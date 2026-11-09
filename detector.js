// Detector de ovos rodando no próprio aparelho (o modelo roda em detector-worker.js).
// Mesmo pipeline de training/infer.py:
//   1. acha a placa de Petri e recorta só ela (plate.js) — o que está fora da placa não é contado;
//   2. roda o modelo em uma ou mais versões do recorte ("variantes": original, espelhada...);
//   3. funde as variantes por votação (merge);
//   4. filtra (select): nota >= limiar, sem ovos bem menores que o típico da foto (sujeira) e sem
//      marcações grudadas num ovo mais confiante (duplicatas).
// Devolve o centro de cada ovo em coordenadas de pixel da foto.
import { findPlate, insidePlate, plateCrop } from "./plate.js";

const worker = new Worker(new URL("./detector-worker.js", import.meta.url), { type: "module" });
const pending = new Map();
let nextId = 0;

worker.onmessage = ({ data }) => {
  const request = pending.get(data.id);
  pending.delete(data.id);
  if (data.ok) request.resolve(data.result);
  else request.reject(new Error(data.error));
};

function call(type, data, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, data }, transfer);
  });
}

/** Baixa e prepara o modelo; resolve com { version, config }. Pode ser chamado várias vezes. */
export const loadModel = () => call("load");

// Cada variante: tamanho da imagem transformada, matriz que leva um ponto (x, y) do recorte para ela
// ([a, b, c, d, e, f] do canvas: x' = a x + c y + e, y' = b x + d y + f) e o caminho de volta.
const VARIANTS = {
  original: { size: (w, h) => [w, h], matrix: () => [1, 0, 0, 1, 0, 0], back: (x, y) => [x, y] },
  hflip: { size: (w, h) => [w, h], matrix: (w) => [-1, 0, 0, 1, w, 0], back: (x, y, w) => [w - x, y] },
  vflip: { size: (w, h) => [w, h], matrix: (w, h) => [1, 0, 0, -1, 0, h], back: (x, y, w, h) => [x, h - y] },
  transpose: { size: (w, h) => [h, w], matrix: () => [0, 1, 1, 0, 0, 0], back: (x, y) => [y, x] },
};

/** Uma passada do modelo numa variante do recorte. Devolve [cx, cy, tamanho, confiança] em px do recorte. */
async function runVariant(crop, name, inputSize) {
  const variant = VARIANTS[name];
  if (!variant) throw new Error(`variante desconhecida: ${name}`);
  const [vw, vh] = variant.size(crop.width, crop.height);

  // letterbox igual ao do treino: redimensiona mantendo a proporção e completa com cinza 114
  const scale = Math.min(inputSize / vw, inputSize / vh);
  const padX = Math.floor((inputSize - Math.round(vw * scale)) / 2);
  const padY = Math.floor((inputSize - Math.round(vh * scale)) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = inputSize;
  canvas.height = inputSize;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, inputSize, inputSize);
  ctx.imageSmoothingQuality = "high";
  const [a, b, c, d, e, f] = variant.matrix(crop.width, crop.height);
  ctx.setTransform(scale * a, scale * b, scale * c, scale * d, scale * e + padX, scale * f + padY);
  ctx.drawImage(crop, 0, 0);
  const rgba = ctx.getImageData(0, 0, inputSize, inputSize).data;
  canvas.width = canvas.height = 0; // libera a memória já (importante no iPhone)

  const plane = inputSize * inputSize;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    data[i] = rgba[4 * i] / 255;
    data[plane + i] = rgba[4 * i + 1] / 255;
    data[2 * plane + i] = rgba[4 * i + 2] / 255;
  }

  const boxes = await call("detect", data, [data.buffer]);
  return boxes.map(([cx, cy, size, conf]) => {
    const [x, y] = variant.back((cx - padX) / scale, (cy - padY) / scale, crop.width, crop.height);
    return [x, y, size / scale, conf];
  });
}

/**
 * Funde as detecções das variantes: detecções de variantes diferentes a menos de meio ovo uma da outra
 * são o mesmo ovo; nota = soma das confianças / número de variantes. Igual a merge() em infer.py.
 * @returns {{x: number, y: number, score: number, size: number}[]}
 */
function merge(perVariant) {
  const K = perVariant.length;
  const all = perVariant.flatMap((boxes, k) => boxes.map((b) => [...b, k]));
  all.sort((p, q) => q[3] - p[3]);
  const sizes = all.map((b) => b[2]).sort((p, q) => p - q);
  const cell = sizes.length ? median(sizes) : 1;
  const grid = new Map();
  const groups = [];
  for (const [x, y, size, conf, k] of all) {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    let best = null;
    let bestD = Infinity;
    for (let i = gx - 1; i <= gx + 1; i++) {
      for (let j = gy - 1; j <= gy + 1; j++) {
        for (const g of grid.get(`${i},${j}`) ?? []) {
          const dist = (g.x - x) ** 2 + (g.y - y) ** 2;
          const limit = 0.5 * Math.min(g.size, size);
          if (dist < limit * limit && dist < bestD && !g.variants.has(k)) {
            best = g;
            bestD = dist;
          }
        }
      }
    }
    if (best) {
      best.sx += x * conf;
      best.sy += y * conf;
      best.ss += size * conf;
      best.sc += conf;
      best.variants.add(k);
    } else {
      const g = { x, y, size, sx: x * conf, sy: y * conf, ss: size * conf, sc: conf, variants: new Set([k]) };
      const key = `${gx},${gy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(g);
      groups.push(g);
    }
  }
  return groups.map((g) => ({ x: g.sx / g.sc, y: g.sy / g.sc, score: g.sc / K, size: g.ss / g.sc }));
}

/**
 * Filtra a saída de merge, igual a select() em infer.py:
 *  - nota >= threshold;
 *  - tamanho >= minSize * mediana dos tamanhos que passaram no limiar (sujeira é menor que ovo);
 *  - do mais confiante ao menos, descarta o ovo a menos de minDistance * (tamanho médio dos dois)
 *    de um ovo já aceito (duplicata).
 */
function select(eggs, threshold, minSize = 0, minDistance = 0) {
  eggs = eggs.filter((e) => e.score >= threshold);
  if (eggs.length && minSize > 0) {
    const limit = minSize * median(eggs.map((e) => e.size).sort((p, q) => p - q));
    eggs = eggs.filter((e) => e.size >= limit);
  }
  if (!eggs.length || minDistance <= 0) return eggs;
  eggs.sort((p, q) => q.score - p.score);
  const cell = Math.max(1, minDistance) * Math.max(...eggs.map((e) => e.size)); // nenhum limite passa de uma célula
  const grid = new Map();
  const kept = [];
  for (const e of eggs) {
    const gx = Math.floor(e.x / cell);
    const gy = Math.floor(e.y / cell);
    let close = false;
    for (let i = gx - 1; i <= gx + 1 && !close; i++) {
      for (let j = gy - 1; j <= gy + 1 && !close; j++) {
        close = (grid.get(`${i},${j}`) ?? []).some((k) => {
          const limit = minDistance * 0.5 * (e.size + k.size);
          return (k.x - e.x) ** 2 + (k.y - e.y) ** 2 < limit * limit;
        });
      }
    }
    if (close) continue;
    kept.push(e);
    const key = `${gx},${gy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(e);
  }
  return kept;
}

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** @param {HTMLCanvasElement} photo */
export async function detect(photo) {
  const { config } = await loadModel();
  const plateConfig = config.plate;
  const plate = plateConfig ? findPlate(photo, plateConfig) : null;
  const crop = plateConfig ? plateCrop(photo, plate, plateConfig) : { canvas: photo, x: 0, y: 0 };

  const perVariant = [];
  for (const name of config.variants ?? ["original"]) {
    perVariant.push(await runVariant(crop.canvas, name, config.input_size));
  }
  if (crop.canvas !== photo) crop.canvas.width = crop.canvas.height = 0;

  return select(merge(perVariant), config.conf_threshold, config.min_size, config.min_distance)
    .map((egg) => ({ x: egg.x + crop.x, y: egg.y + crop.y }))
    .filter((p) => p.x >= 0 && p.x <= photo.width && p.y >= 0 && p.y <= photo.height)
    .filter((p) => !plateConfig || insidePlate(plate, p.x, p.y, plateConfig));
}

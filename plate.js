// Encontra a placa de Petri na foto e recorta só ela, antes de rodar o modelo.
// Mesmo algoritmo de training/plate.py (o recorte do app tem que ser igual ao do treino); os
// parâmetros vêm de model/zeca_detector.json ("plate"). Explicação passo a passo em plate.py.

/** Reduz por metades (média 2x2 a cada passo) até o lado maior chegar a `size`. */
function shrink(source, size) {
  let canvas = source;
  let w = source.width;
  let h = source.height;
  const target = size / Math.max(w, h);
  while (true) {
    const step = Math.max(0.5, target * (source.width / w));
    const nw = Math.max(1, Math.round(w * step));
    const nh = Math.max(1, Math.round(h * step));
    const next = document.createElement("canvas");
    next.width = nw;
    next.height = nh;
    const ctx = next.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, nw, nh);
    if (canvas !== source) canvas.width = canvas.height = 0;
    canvas = next;
    w = nw;
    h = nh;
    if (step > 0.5) return canvas;
  }
}

/**
 * @param {HTMLCanvasElement} photo
 * @returns {{cx: number, cy: number, rx: number, ry: number, score: number} | null} em pixels da foto
 */
export function findPlate(photo, p) {
  const small = shrink(photo, p.work_size);
  const w = small.width;
  const h = small.height;
  const scale = w / photo.width;
  const rgba = small.getContext("2d").getImageData(0, 0, w, h).data;
  small.width = small.height = 0;

  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];

  // Sobel 3x3 (bordas replicadas); a moldura da foto não conta como borda
  const at = (x, y) => gray[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      gy[i] = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      mag[i] = Math.hypot(gx[i], gy[i]);
    }
  }

  const nEdges = Math.max(1, Math.floor(p.edge_fraction * w * h));
  const threshold = Float32Array.from(mag).sort()[w * h - nEdges];
  const ex = [];
  const ey = [];
  const ux = [];
  const uy = [];
  for (let i = 0; i < w * h; i++) {
    if (mag[i] >= threshold && mag[i] > 0) {
      ex.push(i % w);
      ey.push(Math.floor(i / w));
      ux.push(gx[i] / mag[i]);
      uy.push(gy[i] / mag[i]);
    }
  }

  // votos espalhados em 3x3 = soma 3x3 dos votos (tolera o arredondamento)
  const acc = new Float32Array(w * h);
  const m = Math.min(w, h);
  let best = { score: 0, x: 0, y: 0, rx: 0, ry: 0 };
  for (const aspect of p.aspects) {
    for (let r = Math.trunc(p.min_radius * m); r <= Math.trunc(p.max_radius * m); r++) {
      const rx = r;
      const ry = r * aspect;
      if (ry < p.min_radius * m || ry > p.max_radius * m) continue;
      acc.fill(0);
      let top = 0;
      let topIndex = 0;
      for (let e = 0; e < ex.length; e++) {
        // ponto da elipse cuja normal tem a direção do gradiente
        const k = Math.hypot(ux[e] * rx, uy[e] * ry);
        const dx = (rx * (ux[e] * rx)) / k;
        const dy = (ry * (uy[e] * ry)) / k;
        for (const sign of [-1, 1]) {
          const vx = Math.round(ex[e] + sign * dx);
          const vy = Math.round(ey[e] + sign * dy);
          if (vx < 0 || vx >= w || vy < 0 || vy >= h) continue;
          for (let y = Math.max(0, vy - 1); y <= Math.min(h - 1, vy + 1); y++) {
            for (let x = Math.max(0, vx - 1); x <= Math.min(w - 1, vx + 1); x++) {
              const i = y * w + x;
              if (++acc[i] > top) {
                top = acc[i];
                topIndex = i;
              }
            }
          }
        }
      }
      const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
      const score = top / perimeter;
      if (score > best.score) best = { score, x: topIndex % w, y: Math.floor(topIndex / w), rx, ry };
    }
  }

  if (best.score < p.min_score) return null;
  return {
    cx: (best.x + 0.5) / scale,
    cy: (best.y + 0.5) / scale,
    rx: best.rx / scale,
    ry: best.ry / scale,
    score: best.score,
  };
}

/** Retângulo do recorte em volta da placa, dentro da foto. */
export function cropBox(plate, width, height, p) {
  if (!plate) return { x: 0, y: 0, w: width, h: height };
  const x0 = Math.max(0, Math.floor(plate.cx - p.crop_margin * plate.rx));
  const y0 = Math.max(0, Math.floor(plate.cy - p.crop_margin * plate.ry));
  const x1 = Math.min(width, Math.ceil(plate.cx + p.crop_margin * plate.rx));
  const y1 = Math.min(height, Math.ceil(plate.cy + p.crop_margin * plate.ry));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Se o ponto (em pixels da foto) está dentro da placa. */
export function insidePlate(plate, x, y, p) {
  if (!plate) return true;
  const nx = (x - plate.cx) / plate.rx;
  const ny = (y - plate.cy) / plate.ry;
  return nx * nx + ny * ny <= p.mask_margin * p.mask_margin;
}

/** Recorta a placa e pinta de cinza o que está fora dela. */
export function plateCrop(photo, plate, p) {
  const box = cropBox(plate, photo.width, photo.height, p);
  const canvas = document.createElement("canvas");
  canvas.width = box.w;
  canvas.height = box.h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (plate) {
    ctx.fillStyle = `rgb(${p.fill},${p.fill},${p.fill})`;
    ctx.fillRect(0, 0, box.w, box.h);
    ctx.beginPath();
    ctx.ellipse(plate.cx - box.x, plate.cy - box.y, p.mask_margin * plate.rx, p.mask_margin * plate.ry, 0, 0, 2 * Math.PI);
    ctx.clip();
  }
  ctx.drawImage(photo, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return { canvas, x: box.x, y: box.y };
}

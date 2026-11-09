// Roda o detector de ovos (YOLO exportado em ONNX por training/train.py) fora da thread da tela,
// para a interface não travar enquanto o modelo conta.
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.wasm.min.mjs";

// uma thread só: multithread exige cabeçalhos especiais (COOP/COEP) que hospedagens simples não mandam
ort.env.wasm.numThreads = 1;

let session = null;
let config = null;

async function load() {
  // no-cache: sempre confere se há um modelo novo; o service worker serve do cache quando está offline
  config = await (await fetch("model/zeca_detector.json", { cache: "no-cache" })).json();
  const response = await fetch(`model/zeca_detector.onnx?v=${encodeURIComponent(config.version)}`);
  if (!response.ok) throw new Error(`modelo não encontrado (${response.status})`);
  session = await ort.InferenceSession.create(new Uint8Array(await response.arrayBuffer()), {
    executionProviders: ["wasm"],
  });
  return { version: config.version, config };
}

function iou(a, b) {
  const ix = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
  const iy = Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/**
 * Recebe a imagem já em letterbox (CHW, 0..1) e devolve [cx, cy, tamanho, confiança] de cada detecção
 * (em pixels dessa entrada), depois do NMS. O limiar final é aplicado depois da fusão das variantes.
 */
async function detect(data) {
  const size = config.input_size;
  const minConf = config.candidate_conf ?? config.conf_threshold; // modelos antigos não têm candidate_conf
  const input = new ort.Tensor("float32", data, [1, 3, size, size]);
  const result = await session.run({ [session.inputNames[0]]: input });
  // saída [1, 5, N]: cx, cy, w, h, confiança (uma classe só)
  const output = result[session.outputNames[0]];
  const n = output.dims[2];
  const out = output.data;
  const candidates = [];
  let maxSide = 1;
  for (let i = 0; i < n; i++) {
    const score = out[4 * n + i];
    if (score >= minConf) {
      const c = { cx: out[i], cy: out[n + i], w: out[2 * n + i], h: out[3 * n + i], score };
      candidates.push(c);
      maxSide = Math.max(maxSide, c.w, c.h);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  // NMS guloso; a grade (células do tamanho da maior caixa) só compara caixas vizinhas
  const grid = new Map();
  const kept = [];
  for (const c of candidates) {
    const gx = Math.floor(c.cx / maxSide);
    const gy = Math.floor(c.cy / maxSide);
    let overlaps = false;
    for (let i = gx - 1; i <= gx + 1 && !overlaps; i++) {
      for (let j = gy - 1; j <= gy + 1 && !overlaps; j++) {
        overlaps = (grid.get(`${i},${j}`) ?? []).some((k) => iou(k, c) > config.iou_threshold);
      }
    }
    if (overlaps) continue;
    kept.push(c);
    const key = `${gx},${gy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(c);
  }
  input.dispose?.();
  return kept.map((c) => [c.cx, c.cy, (c.w + c.h) / 2, c.score]);
}

let loading = null;

function ensureLoaded() {
  loading ??= load().catch((e) => {
    loading = null; // permite tentar de novo (ex.: estava sem internet)
    throw e;
  });
  return loading;
}

self.onmessage = async ({ data: msg }) => {
  try {
    const info = await ensureLoaded();
    const result = msg.type === "detect" ? await detect(msg.data) : info;
    self.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String(e?.message ?? e) });
  }
};

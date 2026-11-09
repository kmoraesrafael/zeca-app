// Envia para o Supabase: a foto vai para o Storage e a contagem para a tabela `submissions`.
// Sem internet, o envio pode ficar guardado no aparelho e ser mandado depois (outbox.js).
// URL e chave pública vêm de config.js (gerado no deploy; ver README). Sem ele o app abre, só não envia.
const config = import("./config.js").catch(() => ({}));

const BUCKET = "plate-images";

/** crypto.randomUUID só existe em HTTPS; este funciona também ao testar pela rede local (http). */
function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Ex.: "web iPhone iOS 18.1" ou "web Android 14 Pixel 7". */
function deviceName() {
  const ua = navigator.userAgent;
  let name = navigator.platform || "desconhecido";
  const ios = ua.match(/(iPhone|iPad|iPod).*? OS (\d+[_\d]*)/);
  const android = ua.match(/Android ([\d.]+);\s*([^;)]+)/);
  if (ios) name = `${ios[1]} iOS ${ios[2].replace(/_/g, ".")}`;
  else if (android) name = `Android ${android[1]} ${android[2]}`.trim();
  else if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) name = "iPad";
  return `web ${name}`.slice(0, 128);
}

// Chaves antigas (anon) são JWT e também vão no Authorization; as novas (sb_publishable_...) só no apikey.
function authHeaders(key) {
  const headers = { apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Já existe no servidor = já foi enviado: uma tentativa anterior chegou lá e só a resposta se perdeu
 * (a foto tem nome único e a tabela não aceita a mesma foto duas vezes).
 */
function alreadySent(status, detail) {
  return status === 409 || /duplicate|already exists/i.test(detail);
}

async function execute(step, url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    if (options.signal?.aborted) throw new Error(`não foi possível ${step} (a conexão demorou demais).`);
    throw new Error(`não foi possível ${step} (sem conexão).`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    if (alreadySent(response.status, detail)) return;
    throw new Error(`não foi possível ${step} (${response.status}). ${detail}`);
  }
}

/**
 * Monta o envio (JPEG + linha da tabela) sem mandar nada, para poder enviar agora ou guardar no aparelho
 * e enviar depois (outbox.js). O nome da foto é sorteado aqui, então reenviar o mesmo envio não duplica nada.
 * @param {HTMLCanvasElement} photo foto já rotacionada, nas mesmas coordenadas das marcações
 * @param {{x: number, y: number}[]} points
 * @param {string} source "camera" ou "galeria"
 * @param {{version: string, count: number, points: number[][]} | null} prediction o que o modelo marcou antes das correções
 * @returns {Promise<{id: string, createdAt: number, jpeg: ArrayBuffer, row: object}>}
 */
export async function prepareSubmission(photo, points, source, prediction) {
  const blob = await new Promise((resolve, reject) =>
    photo.toBlob((b) => (b ? resolve(b) : reject(new Error("falha ao gerar o JPEG"))), "image/jpeg", 0.92),
  );
  const imagePath = `${uuid()}.jpg`;
  const row = {
    image_path: imagePath,
    image_width: photo.width,
    image_height: photo.height,
    egg_count: points.length,
    points: points.map((p) => [p.x, p.y]),
    source,
    device: deviceName(),
  };
  if (prediction) {
    row.model_version = prediction.version;
    row.model_count = prediction.count;
    row.model_points = prediction.points;
  }
  // ArrayBuffer em vez de Blob: é o formato que o IndexedDB de qualquer Safari guarda sem problema
  return { id: imagePath, createdAt: Date.now(), jpeg: await blob.arrayBuffer(), row };
}

/**
 * Envia o que prepareSubmission montou.
 * @param {{jpeg: ArrayBuffer, row: object}} submission
 * @param {AbortSignal} [signal] para desistir de uma conexão travada
 */
export async function uploadSubmission({ jpeg, row }, signal) {
  const { SUPABASE_URL = "", SUPABASE_KEY: key = "" } = await config;
  const baseUrl = SUPABASE_URL.replace(/\/+$/, "");
  if (!baseUrl || !key) {
    throw new Error("Supabase não configurado: falta web/config.js com SUPABASE_URL e SUPABASE_KEY.");
  }

  await execute("enviar a foto", `${baseUrl}/storage/v1/object/${BUCKET}/${row.image_path}`, {
    method: "POST",
    headers: { ...authHeaders(key), "x-upsert": "false", "Content-Type": "image/jpeg" },
    body: new Blob([jpeg], { type: "image/jpeg" }),
    signal,
  });
  await execute("registrar a contagem", `${baseUrl}/rest/v1/submissions`, {
    method: "POST",
    headers: { ...authHeaders(key), Prefer: "return=minimal", "Content-Type": "application/json" },
    body: JSON.stringify(row),
    signal,
  });
}

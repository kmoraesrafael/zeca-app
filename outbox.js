// Envios guardados no aparelho para mandar depois, quando a sala de contagem está sem internet.
// Ficam no IndexedDB (foto JPEG + contagem, exatamente como seriam enviados) e saem sozinhos quando o
// app é aberto com internet, quando a conexão volta ou pelo botão "Enviar agora" da tela inicial.
import { uploadSubmission } from "./submission.js";

const DB_NAME = "zeca";
const STORE = "envios-pendentes";
// uma conexão que travou no meio do envio desiste depois disso (dá para uma foto de alguns MB numa rede bem lenta)
const UPLOAD_TIMEOUT_MS = 180_000;

/** Avisa a tela inicial quando a lista muda (evento "change"). */
export const outboxEvents = new EventTarget();
const changed = () => outboxEvents.dispatchEvent(new Event("change"));

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

async function run(mode, action) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("operação cancelada"));
  });
}

/** Envios que já deram certo (para não guardar um envio que terminou enquanto o usuário escolhia salvar). */
const sent = new Set();
/** Envios em andamento agora, para o envio automático não mandar o mesmo duas vezes ao mesmo tempo. */
const inFlight = new Set();

/** Guarda o envio (de submission.js prepareSubmission) no aparelho. */
export async function savePending(item) {
  if (sent.has(item.id)) return;
  await run("readwrite", (store) => store.put(item));
  // pede ao navegador para não apagar estes dados quando faltar espaço (o Safari pode ignorar)
  navigator.storage?.persist?.().catch(() => {});
  // terminou de enviar enquanto salvava? então não precisa ficar guardado
  if (sent.has(item.id)) await run("readwrite", (store) => store.delete(item.id));
  changed();
}

/** @returns {Promise<{id: string, createdAt: number, row: {egg_count: number}}[]>} do mais antigo ao mais novo */
export async function listPending() {
  const items = await run("readonly", (store) => store.getAll());
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

/** Envia agora; se o envio também estiver guardado no aparelho, tira de lá quando der certo. */
export async function upload(item) {
  inFlight.add(item.id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    await uploadSubmission(item, controller.signal);
  } finally {
    clearTimeout(timer);
    inFlight.delete(item.id);
  }
  sent.add(item.id);
  await run("readwrite", (store) => store.delete(item.id)).catch(() => {});
  changed();
}

let flushing = null;

/**
 * Tenta mandar todos os envios guardados, um de cada vez (para no primeiro erro de conexão).
 * @returns {Promise<{sent: number, left: number, error: Error | null}>}
 */
export function flushPending() {
  if (flushing) return flushing;
  flushing = (async () => {
    let count = 0;
    let error = null;
    try {
      for (const item of await listPending()) {
        if (inFlight.has(item.id)) continue;
        try {
          await upload(item);
          count++;
        } catch (e) {
          error = e;
          break;
        }
      }
    } catch (e) {
      error = e;
    }
    const left = (await listPending().catch(() => [])).length;
    return { sent: count, left, error };
  })().finally(() => {
    flushing = null;
    changed();
  });
  changed();
  return flushing;
}

export const isFlushing = () => flushing !== null;

// Service worker: deixa o Z.E.C.A abrir e contar sem internet (o envio, claro, precisa de conexão).
// Arquivos do app: sempre tenta a versão nova da rede primeiro, então cada deploy chega sozinho aos aparelhos.
// Modelo e ONNX Runtime: guardados no aparelho (são grandes e só mudam quando a versão muda).
const CACHE = "zeca-v1";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "detector.js",
  "detector-worker.js",
  "plate.js",
  "submission.js",
  "config.js",
  "manifest.webmanifest",
  "icons/mark.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "model/zeca_detector.json",
];
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: "no-cache" })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const url = new URL(request.url);
    if (url.pathname.endsWith(".onnx")) {
      // apaga as versões antigas do modelo
      for (const old of await cache.keys()) {
        if (new URL(old.url).pathname === url.pathname) await cache.delete(old);
      }
    }
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request, { cache: "no-cache" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS)),
    ]);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.hostname === "cdn.jsdelivr.net" || url.pathname.endsWith(".onnx")) {
    event.respondWith(cacheFirst(request));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  }
  // o resto (Supabase) vai direto para a rede
});

// Service worker minimo: guarda o "shell" do app para abrir offline.
// Rede primeiro: com conexao, sempre carrega a versao mais nova do app;
// sem conexao, usa a copia guardada. Os dados (/api/*) nunca sao cacheados.
const CACHE = "monitor-energia-v8";
const SHELL = ["./", "index.html", "styles.css", "util.js", "mock.js", "voz.js", "graficos.js", "app.js",
  "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.includes("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && url.origin === location.origin) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});

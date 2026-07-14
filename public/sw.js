/* OBV Field Capture service worker.
   Network-first with cache fallback: pages and data stay fresh while the
   app shell keeps working offline (captures queue in IndexedDB). */
const CACHE = "obv-field-v3"; // bumped: stylesheet URLs now carry a ?v= content hash
const SHELL = [
  "/field",
  "/styles.css",
  "/js/field.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  // Cache fallback is ONLY for the offline field-capture shell. Serving a
  // stale copy of any other page (e.g. during a free-tier cold start)
  // would show an outdated app — better to surface the real network state.
  const isFieldShell =
    url.pathname === "/field" || SHELL.includes(url.pathname);
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && isFieldShell) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch((err) => {
        if (isFieldShell) {
          // ignoreSearch: the precached shell stores /styles.css without the
          // ?v= content hash the live pages request it with.
          return caches
            .match(req, { ignoreSearch: true })
            .then((hit) => hit || caches.match("/field"));
        }
        throw err;
      })
  );
});

/* next-baking-app service worker — app shell + data snapshots stay usable offline. */
const VERSION = "next-baking-bc4d63a";
const SHELL = ["/", "/recipes", "/ingredients", "/mixes", "/settings", "/seed/state.json", "/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    for (const url of SHELL) {
      try { await cache.add(new Request(url, { cache: "reload" })); } catch { /* a missing page is not fatal */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;               // every write goes straight to the local DB / hub

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Pages: network when reachable, cached copy when offline.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(VERSION);
        cache.put(request, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(request, { ignoreSearch: false });
        // any in-app route falls back to the shell; the client router draws the right view from the URL
        return cached ?? (await caches.match("/")) ?? new Response("Offline and this page is not cached yet.", { status: 503 });
      }
    })());
    return;
  }

  // Assets & seed data: cache-first with background refresh.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const refresh = (async () => {
      try { const fresh = await fetch(request); (await caches.open(VERSION)).put(request, fresh.clone()); } catch { /* keep stale copy */ }
    })();
    if (cached) { event.waitUntil(refresh); return cached; }
    try { const fresh = await fetch(request); (await caches.open(VERSION)).put(request, fresh.clone()); return fresh; } catch { return new Response("", { status: 504 }); }
  })());
});

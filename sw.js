// Service worker. Exists to make the game installable and playable offline —
// both preconditions for the native package, not features in their own right.
//
// The caching strategy is deliberately lopsided, because a stale copy of this
// game has bitten before: a browser holding an old index.html once made a fixed
// bug look unfixed for an entire session.
//
//   documents and the page itself  -> network first, cache only as a fallback
//   images, audio, icons, manifest -> cache first, refreshed in the background
//
// So an online player always runs the current build, and an offline one still
// gets a game. The heavy files (a 100 KB sprite strip, a 40 KB sample) are the
// ones worth serving from cache, and they change far less often than the code.

const VERSION = "space-taxi-v1";
const ASSETS = `${VERSION}-assets`;
const PAGES = `${VERSION}-pages`;

// Enough to boot offline. Anything missing here still works online and lands in
// the cache on first use, so a typo costs a cache miss rather than a broken app.
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./explosion3.png",
  "./explosion.mp3",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(ASSETS);
    // Individually, not addAll: one 404 would otherwise abort the whole install
    // and leave the game with no service worker at all.
    await Promise.all(PRECACHE.map(async url => {
      try { await cache.add(new Request(url, { cache: "reload" })); } catch (e) {}
    }));
    // Take over at once rather than waiting for every tab to close. An update
    // the player cannot get to is the problem this file has to avoid.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keep = new Set([ASSETS, PAGES]);
    for (const name of await caches.keys()) {
      if (!keep.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

function isAsset(url) {
  return /\.(png|jpg|jpeg|gif|webp|svg|mp3|ogg|wav|woff2?|ttf|webmanifest)$/i.test(url.pathname);
}

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    // Only cache what came back whole; a 206 or an opaque error is not a page.
    if (fresh && fresh.ok && fresh.type === "basic") {
      const cache = await caches.open(PAGES);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // A navigation with nothing cached still has to render something
    if (request.mode === "navigate") {
      const shell = await caches.match("./index.html", { ignoreSearch: true });
      if (shell) return shell;
    }
    throw e;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  const update = fetch(request).then(fresh => {
    if (fresh && fresh.ok && fresh.type === "basic") {
      caches.open(ASSETS).then(c => c.put(request, fresh.clone()));
    }
    return fresh;
  }).catch(() => null);
  // Serve what is there and refresh behind it; only wait when there is nothing.
  return cached || (await update) || Response.error();
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Other origins are left alone entirely: the Google Fonts stylesheet has its
  // own caching, and a WebSocket never reaches here in the first place.
  if (url.origin !== self.location.origin) return;

  if (isAsset(url)) event.respondWith(cacheFirst(request));
  else event.respondWith(networkFirst(request));
});

// Lets a page ask for an update to be applied immediately
self.addEventListener("message", event => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

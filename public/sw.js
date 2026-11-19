// Network first, falling back to the last good copy, so lists and the lucky dip
// keep working on patchy mobile data. Bump VERSION when the precache list changes.
const VERSION = 'triptaster-v2';
const PHOTO_CACHE = 'triptaster-photos';
const MAX_CACHED_THUMBS = 400;
const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/fonts/fraunces.woff2',
  '/fonts/dm-sans.woff2',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];
// Sign-in, admin and invite responses must always be live.
const NEVER_CACHE = ['/auth/', '/api/auth/', '/api/admin/', '/api/links/'];
const NETWORK_WAIT_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION && key !== PHOTO_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) return;
  // Full-size photos are left to the browser's own cache; thumbnails are kept for offline use.
  if (/^\/api\/photos\/\d+\/full$/.test(url.pathname)) return;
  if (/^\/api\/photos\/\d+\/thumb$/.test(url.pathname)) {
    event.respondWith(cachedThumb(request, event));
    return;
  }
  event.respondWith(networkThenCache(request, event));
});

// Photos never change, so a cached thumbnail is always right.
async function cachedThumb(request, event) {
  const cache = await caches.open(PHOTO_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    event.waitUntil(
      cache.put(request, response.clone()).then(async () => {
        const keys = await cache.keys();
        await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_CACHED_THUMBS)).map((key) => cache.delete(key)));
      }),
    );
  }
  return response;
}

async function networkThenCache(request, event) {
  const cache = await caches.open(VERSION);
  const isPage = request.mode === 'navigate';
  const cacheKey = isPage ? '/' : request;

  const network = fetch(request).then(async (response) => {
    if (response.ok && !response.redirected) await cache.put(cacheKey, response.clone());
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  const cached = await cache.match(cacheKey);
  if (!cached) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_WAIT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}

// Network first, falling back to the last good copy, so lists and the lucky dip
// keep working on patchy mobile data. Bump VERSION when the precache list changes.
const VERSION = 'triptaster-v1';
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
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) return;
  event.respondWith(networkThenCache(request, event));
});

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

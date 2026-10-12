// Service worker template; tools/build.js fills in the cache name and precache
// list and writes the result to the export root as sw.js. All paths are
// relative to the worker's own URL so the export also works beneath a
// repository path with no native service.
const CACHE = '__CACHE_NAME__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('sq64-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

const fromCache = async request => await caches.match(request) || caches.match(request, {ignoreSearch: true});

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  if (request.mode === 'navigate') {
    // Network-first keeps deployed pages fresh; the precache keeps them working offline.
    event.respondWith(fetch(request).catch(async () => await fromCache(request) || caches.match(new URL('./', self.location).href)));
  } else {
    event.respondWith(fromCache(request).then(hit => hit || fetch(request)));
  }
});

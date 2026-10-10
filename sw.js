const CACHE_NAME = 'yuzawa-guide-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './services.html',
  './manifest.json',
  './docs/train_info.pdf',
  './docs/onsen_map.pdf'
];

// Install: Pre-cache core shell, services guide, and PDFs
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).catch((err) => {
      console.warn('Cache pre-fetch warning:', err);
    })
  );
  self.skipWaiting();
});

// Activate: Purge older v1 caches immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: Network-First for HTML pages, SWR for PDFs/assets
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const request = event.request;

  // HTML Page Navigation: Network-First (ensures freshest notices and schedules)
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        })
        .catch(() => {
          // If offline, serve cached page or fallback to main shell
          return caches.match(request).then((cached) => cached || caches.match('./services.html') || caches.match('./index.html'));
        })
    );
    return;
  }

  // Static Assets & PDFs: Stale-While-Revalidate (instant offline load + background refresh)
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

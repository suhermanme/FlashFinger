const CACHE = 'flashfinger-shell-v1';
self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['./', './index.html']))); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('message', (event) => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (event) => { if (event.request.method !== 'GET') return; event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request).then((response) => { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy)); return response; }).catch(() => caches.match('./index.html')))); });

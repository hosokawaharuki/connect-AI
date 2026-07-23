const CACHE_NAME = 'conect-ai-v1';
const ASSETS = [
  '/',
  '/static/style.css',
  '/static/script.js',
  '/static/line-audio-optimizer.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});
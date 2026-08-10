const CACHE = 'mercador-ia-shell-v2.0.0';
const SHELL = [
  './', './index.html', './cadastro.html', './admin.html', './usuario.html',
  './css/app.css', './css/auth.css', './css/admin.css', './css/user.css',
  './js/firebase-config.js', './js/utils.js', './js/auth.js', './js/smart-matcher.js',
  './js/index.js', './js/cadastro.js', './js/admin.js', './js/pdf-encarte-importer.js', './js/usuario.js', './js/lista-promocoes.js', './js/pwa.js',
  './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key.startsWith('mercador-ia-')).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      const clone = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, clone));
      return response;
    }).catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html'))));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    const clone = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, clone));
    return response;
  })));
});

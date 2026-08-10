const CACHE = 'mercador-ia-shell-v2.6.0';

// Shell enxuto do consumidor. O painel Admin/PDF é carregado somente quando
// um administrador realmente o acessa — não pesa no PWA de todos os usuários.
const USER_SHELL = [
  './', './index.html', './cadastro.html', './usuario.html',
  './css/app.css', './css/auth.css',
  './js/firebase-config.js', './js/utils.js', './js/auth.js', './js/smart-matcher.js',
  './js/index.js', './js/cadastro.js', './js/lista-promocoes.js', './js/pwa.js',
  './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(USER_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key.startsWith('mercador-ia-')).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // HTML é network-first para uma atualização publicada chegar rápido.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Assets versionados são cache-first; se não estiverem no shell, entram no
  // cache sob demanda (ex.: Admin e importador de PDF).
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response && response.ok) {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, clone));
      }
      return response;
    }))
  );
});

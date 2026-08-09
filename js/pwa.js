(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch((error) => {
      console.warn('[Mercador IA] Service Worker não registrado:', error);
    });
  });
})();

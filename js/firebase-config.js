(function () {
  'use strict';

  const firebaseConfig = {
    apiKey: "AIzaSyBSe0peh7AXK9YQFwZpvbAenfq7AXnS9rY",
    authDomain: "mercadoria-37c2e.firebaseapp.com",
    databaseURL: "https://mercadoria-37c2e-default-rtdb.firebaseio.com",
    projectId: "mercadoria-37c2e",
    storageBucket: "mercadoria-37c2e.firebasestorage.app",
    messagingSenderId: "306603094398",
    appId: "1:306603094398:web:3f850928eb1136e91b032f"
  };

  const MASTER_UID = 'Ah16jHtjZTgSVBzgL759FnQl5W73';
  const MASTER_EMAIL = 'tsd.valencio@gmail.com';
  const APP_VERSION = '1.0.0';

  if (!window.firebase) {
    throw new Error('Firebase SDK não carregado.');
  }

  const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);

  window.MercadorIA = window.MercadorIA || {};
  Object.assign(window.MercadorIA, {
    firebaseConfig,
    MASTER_UID,
    MASTER_EMAIL,
    APP_VERSION,
    app,
    auth: firebase.auth(),
    db: firebase.database(),
    serverTimestamp: firebase.database.ServerValue.TIMESTAMP
  });
})();

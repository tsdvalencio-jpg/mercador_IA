(function () {
  'use strict';
  const M = window.MercadorIA;
  const { auth } = M;
  const form = document.getElementById('loginForm');
  const loginBtn = document.getElementById('loginBtn');
  const forgotLink = document.getElementById('forgotLink');

  const qs = new URLSearchParams(location.search);
  if (qs.get('erro')) M.toast(qs.get('erro'), 'error', 6500);

  auth.onAuthStateChanged(async (user) => {
    if (!user) return;
    try {
      await M.routeAuthenticatedUser(user);
    } catch (error) {
      M.toast(error.message, 'error', 6500);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    M.setBusy(loginBtn, true, 'Entrando...');
    try {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      await M.routeAuthenticatedUser(cred.user);
    } catch (error) {
      const messages = {
        'auth/invalid-credential': 'E-mail ou senha incorretos.',
        'auth/user-disabled': 'Esta conta foi desativada no Firebase Authentication.',
        'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
      };
      M.toast(messages[error.code] || error.message || 'Não foi possível entrar.', 'error', 6500);
    } finally {
      M.setBusy(loginBtn, false);
    }
  });

  forgotLink.addEventListener('click', async (event) => {
    event.preventDefault();
    const email = document.getElementById('email').value.trim();
    if (!email) {
      M.toast('Digite seu e-mail primeiro para receber a redefinição de senha.', 'warning');
      return;
    }
    try {
      await auth.sendPasswordResetEmail(email);
      M.toast('E-mail de redefinição de senha enviado.', 'success');
    } catch (error) {
      M.toast(error.message || 'Não foi possível enviar o e-mail.', 'error');
    }
  });
})();

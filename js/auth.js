(function () {
  'use strict';

  const M = window.MercadorIA;
  const { auth, db, MASTER_UID, serverTimestamp } = M;

  M.getProfile = async function getProfile(uid) {
    const snap = await db.ref(`users/${uid}`).once('value');
    return snap.exists() ? { uid, ...snap.val() } : null;
  };

  const LOGIN_TOUCH_MS = 30 * 60 * 1000;
  function shouldTouchLogin(uid, serverValue) {
    const key = `mercadorIA:lastLoginTouch:${uid}`;
    const now = Date.now();
    let local = 0;
    try { local = Number(localStorage.getItem(key) || 0); } catch (_) {}
    const remote = Number(serverValue || 0);
    const due = now - Math.max(local, remote) >= LOGIN_TOUCH_MS;
    if (due) { try { localStorage.setItem(key, String(now)); } catch (_) {} }
    return due;
  }

  M.ensureAuthenticatedProfile = async function ensureAuthenticatedProfile(user) {
    if (!user) return null;
    const ref = db.ref(`users/${user.uid}`);
    const snap = await ref.once('value');

    if (user.uid === MASTER_UID) {
      const current = snap.val() || {};
      const patch = {};
      if (!current.name) patch.name = 'Administrador Master';
      if ((user.email || current.email || '') !== current.email) patch.email = user.email || current.email || '';
      if (current.role !== 'superadmin') patch.role = 'superadmin';
      if (current.status !== 'active') patch.status = 'active';
      if (!current.createdAt) patch.createdAt = serverTimestamp;
      if (shouldTouchLogin(user.uid, current.lastLoginAt)) patch.lastLoginAt = serverTimestamp;
      if (Object.keys(patch).length) { patch.updatedAt = serverTimestamp; await ref.update(patch); }
      return { uid:user.uid, ...current, ...patch, role:'superadmin', status:'active' };
    }

    if (!snap.exists()) throw new Error('Seu login existe no Authentication, mas o perfil da plataforma ainda não foi criado.');
    const profile = snap.val();
    if (profile.status !== 'active') throw new Error('Seu acesso está bloqueado. Procure o administrador da plataforma.');
    if (shouldTouchLogin(user.uid, profile.lastLoginAt)) ref.child('lastLoginAt').set(serverTimestamp).catch(() => {});
    return { uid:user.uid, ...profile };
  };

  M.waitForAuth = function waitForAuth() {
    return new Promise((resolve) => {
      const unsub = auth.onAuthStateChanged((user) => {
        unsub();
        resolve(user);
      });
    });
  };

  M.requireRole = async function requireRole(allowedRoles) {
    const user = await M.waitForAuth();
    if (!user) {
      location.replace('./index.html');
      throw new Error('Não autenticado.');
    }
    try {
      const profile = await M.ensureAuthenticatedProfile(user);
      if (!profile || !allowedRoles.includes(profile.role)) {
        location.replace('./usuario.html');
        throw new Error('Perfil sem permissão para esta área.');
      }
      return { user, profile };
    } catch (error) {
      await auth.signOut().catch(() => {});
      location.replace(`./index.html?erro=${encodeURIComponent(error.message)}`);
      throw error;
    }
  };

  M.routeAuthenticatedUser = async function routeAuthenticatedUser(user) {
    const profile = await M.ensureAuthenticatedProfile(user);
    if (['superadmin', 'admin'].includes(profile.role)) {
      location.replace('./admin.html');
    } else {
      location.replace('./usuario.html');
    }
  };

  M.logout = async function logout() {
    await auth.signOut();
    location.replace('./index.html');
  };
})();

(function () {
  'use strict';

  const M = window.MercadorIA;
  if (!M) return;
  const { auth, db } = M;

  const state = {
    uid: null,
    items: {},
    markets: {},
    units: {},
    promotions: {},
    location: null,
    radiusKm: 5,
    listenersStarted: false
  };

  const $ = (id) => document.getElementById(id);

  function setStatus(message) {
    const el = $('geo-promo-status');
    if (el) el.textContent = message;
  }

  function getPendingItems() {
    return Object.entries(state.items || {}).map(([id, item]) => ({ id, ...item }))
      .filter((item) => item && item.status === 'faltando');
  }

  function render() {
    const results = $('geo-promo-results');
    const summary = $('geo-promo-summary');
    if (!results || !summary) return;

    if (!state.location) {
      results.innerHTML = '';
      summary.textContent = 'Toque para consultar perto de você';
      return;
    }

    const pending = getPendingItems();
    if (!pending.length) {
      results.innerHTML = '<div class="geo-offer">Sua lista “A Comprar” está vazia.</div>';
      summary.textContent = 'Nenhum item em A Comprar';
      return;
    }

    const offers = M.findMatchingOffers({
      items: pending,
      promotions: state.promotions,
      units: state.units,
      markets: state.markets,
      location: state.location,
      radiusKm: state.radiusKm
    });

    summary.textContent = offers.length ? `${offers.length} oferta${offers.length === 1 ? '' : 's'} encontrada${offers.length === 1 ? '' : 's'}` : `Nenhuma oferta em ${state.radiusKm} km`;

    if (!offers.length) {
      results.innerHTML = `<div class="geo-offer">Nenhuma promoção válida e conferida dos itens da sua lista foi encontrada em até ${state.radiusKm} km.</div>`;
      return;
    }

    results.innerHTML = offers.map((offer) => {
      const p = offer.promo;
      const itemName = offer.item.nome || offer.item.name || 'Item';
      const previous = Number(p.previousPrice);
      const saving = Number.isFinite(previous) && previous > Number(p.price) ? previous - Number(p.price) : 0;
      const mapQuery = `${offer.unit.lat},${offer.unit.lng}`;
      return `<article class="geo-offer">
        <div class="geo-offer-top">
          <div><div class="geo-offer-name">${M.escapeHtml(itemName)} → ${M.escapeHtml(p.productName || '')}</div>
          <div class="geo-offer-meta">${M.escapeHtml(offer.market.name || 'Mercado')} · ${M.escapeHtml(offer.unit.name || 'Unidade')} · ${offer.distanceKm.toFixed(1).replace('.', ',')} km</div></div>
          <div class="geo-offer-price">${M.formatCurrency(p.price)}</div>
        </div>
        <div class="geo-offer-meta">${p.brand ? `${M.escapeHtml(p.brand)} · ` : ''}${p.packageText ? `${M.escapeHtml(p.packageText)} · ` : ''}válida até ${M.formatDateTime(p.endAt)}${saving > 0 ? ` · economia ${M.formatCurrency(saving)}` : ''}</div>
        <div class="geo-offer-actions"><a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}">📍 Abrir no mapa</a></div>
      </article>`;
    }).join('');
  }

  function startRealtimeListeners() {
    if (state.listenersStarted || !state.uid) return;
    state.listenersStarted = true;
    db.ref(`shopping_lists/${state.uid}`).on('value', (snap) => { state.items = snap.val() || {}; render(); });
    db.ref('markets').on('value', (snap) => { state.markets = snap.val() || {}; render(); });
    db.ref('market_units').on('value', (snap) => { state.units = snap.val() || {}; render(); });
    db.ref('promotions').on('value', (snap) => { state.promotions = snap.val() || {}; render(); });
  }

  async function loadSettings() {
    if (!state.uid) return;
    const snap = await db.ref(`user_settings/${state.uid}/radiusKm`).once('value');
    const saved = Number(snap.val());
    if ([1, 3, 5, 10, 25].includes(saved)) state.radiusKm = saved;
    if ($('geo-promo-radius')) $('geo-promo-radius').value = String(state.radiusKm);
  }

  async function locateAndSearch() {
    if (!state.uid) return;
    const button = $('geo-promo-locate');
    if (button) { button.disabled = true; button.textContent = 'Localizando...'; }
    try {
      state.radiusKm = Number($('geo-promo-radius')?.value || 5);
      await db.ref(`user_settings/${state.uid}`).update({ radiusKm: state.radiusKm, updatedAt: M.serverTimestamp });
      const pos = await M.getCurrentPosition();
      state.location = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      startRealtimeListeners();
      setStatus(`Localização obtida com precisão aproximada de ${Math.round(pos.coords.accuracy)} m. Buscando em ${state.radiusKm} km.`);
      render();
    } catch (error) {
      setStatus(error.message || 'Não foi possível usar sua localização.');
      M.toast(error.message || 'Falha ao localizar.', 'error');
    } finally {
      if (button) { button.disabled = false; button.textContent = 'Usar minha localização e buscar'; }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('geo-promo-toggle')?.addEventListener('click', () => $('geo-promo-strip')?.classList.toggle('open'));
    $('geo-promo-locate')?.addEventListener('click', locateAndSearch);
    $('geo-promo-radius')?.addEventListener('change', async (event) => {
      state.radiusKm = Number(event.target.value || 5);
      if (state.uid) await db.ref(`user_settings/${state.uid}`).update({ radiusKm: state.radiusKm, updatedAt: M.serverTimestamp }).catch(() => {});
      if (state.location) render();
    });
  });

  auth.onAuthStateChanged(async (user) => {
    if (!user) return;
    state.uid = user.uid;
    try { await loadSettings(); } catch (error) { console.warn('[Mercador IA] Não foi possível carregar o raio:', error); }
  });
})();

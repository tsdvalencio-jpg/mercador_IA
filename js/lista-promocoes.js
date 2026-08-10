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
    listenersStarted: false,
    offers: [],
    groupedOffers: new Map(),
    watchId: null,
    trackingActive: false,
    trackingStarting: false,
    firstLiveFix: false,
    lastLocationAt: 0
  };

  const $ = (id) => document.getElementById(id);
  let decorateTimer = 0;
  let listObserver = null;

  function setStatus(message, mode) {
    const el = $('geo-promo-status');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('live', 'warn');
    if (mode === 'live') el.classList.add('live');
    if (mode === 'warn') el.classList.add('warn');
  }

  function setSmartOfferCount(value) {
    const el = $('smart-offer-count');
    if (el) el.textContent = String(Math.max(0, Number(value) || 0));
  }

  function geoErrorMessage(error) {
    const map = {
      1: 'Permissão de localização negada.',
      2: 'O GPS ainda não conseguiu determinar sua posição.',
      3: 'O GPS demorou demais para atualizar a posição.'
    };
    return map[error && error.code] || (error && error.message) || 'Falha ao acompanhar a localização.';
  }

  function liveTimeLabel(timestamp) {
    try {
      return new Date(timestamp || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function updateTrackingButton() {
    const button = $('geo-promo-locate');
    if (!button) return;
    button.disabled = false;
    if (state.trackingStarting) {
      button.disabled = true;
      button.textContent = 'Ativando GPS em tempo real...';
      return;
    }
    button.textContent = state.trackingActive
      ? '🟢 Localização em tempo real ativa'
      : 'Ativar localização em tempo real';
  }

  function stopLiveTracking() {
    if (state.watchId != null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (_) {}
    }
    state.watchId = null;
    state.trackingActive = false;
    state.trackingStarting = false;
    updateTrackingButton();
  }

  function getPendingItems() {
    return Object.entries(state.items || {})
      .map(([id, item]) => ({ id, ...item }))
      .filter((item) => item && item.status === 'faltando');
  }

  function sortOffers(list) {
    return [...list].sort((a, b) => {
      const pa = Number(a.promo && a.promo.price);
      const pb = Number(b.promo && b.promo.price);
      if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
      return Number(a.distanceKm || 0) - Number(b.distanceKm || 0);
    });
  }

  function buildGroups(offers) {
    const grouped = new Map();
    for (const offer of offers || []) {
      const key = String(offer.item && offer.item.id != null ? offer.item.id : '');
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(offer);
    }
    for (const [key, list] of grouped) grouped.set(key, sortOffers(list));
    return grouped;
  }

  function uniqueMarketCount(offers) {
    return new Set((offers || []).map((o) => String(o.market && (o.market.id || o.promo && o.promo.marketId) || o.market && o.market.name || ''))).size;
  }

  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorateItemRows, 20);
  }

  function updatePurchaseProgress() {
    const el = $('purchase-progress');
    if (!el) return;
    const all = Object.values(state.items || {}).filter(Boolean);
    const pending = all.filter((x) => x.status === 'faltando').length;
    const bought = all.filter((x) => x.status === 'comprado').length;
    if (!all.length) el.textContent = 'Sua lista está vazia';
    else if (!pending) el.textContent = bought ? `${bought} comprado${bought === 1 ? '' : 's'} · nada faltando` : 'Nada para comprar';
    else el.textContent = `${pending} para comprar${bought ? ` · ${bought} no carrinho` : ''}`;
  }

  function renderCompactSummary() {
    const results = $('geo-promo-results');
    const summary = $('geo-promo-summary');
    if (!summary) return;

    const pending = getPendingItems();
    updatePurchaseProgress();

    if (!state.location) {
      summary.textContent = 'Ative a localização para comparar';
      if (results) results.textContent = 'A lista continua funcionando normalmente. A localização é usada somente no aparelho para encontrar ofertas próximas.';
      state.offers = [];
      state.groupedOffers = new Map();
      setSmartOfferCount(0);
      scheduleDecorate();
      return;
    }

    if (!pending.length) {
      summary.textContent = 'Nenhum item em A Comprar';
      if (results) results.textContent = 'Adicione produtos à lista para comparar promoções próximas.';
      state.offers = [];
      state.groupedOffers = new Map();
      setSmartOfferCount(0);
      scheduleDecorate();
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

    state.offers = offers;
    state.groupedOffers = buildGroups(offers);

    const itemsWithOffers = state.groupedOffers.size;
    const markets = uniqueMarketCount(offers);
    setSmartOfferCount(itemsWithOffers);
    summary.textContent = itemsWithOffers
      ? `${itemsWithOffers} de ${pending.length} item${pending.length === 1 ? '' : 's'} com oferta`
      : `Nenhuma oferta em ${state.radiusKm} km`;

    if (results) {
      results.textContent = itemsWithOffers
        ? `${offers.length} oferta${offers.length === 1 ? '' : 's'} verificada${offers.length === 1 ? '' : 's'} em ${markets} mercado${markets === 1 ? '' : 's'}. A melhor aparece diretamente em cada item.`
        : `Nenhuma promoção válida e conferida dos seus itens foi encontrada em até ${state.radiusKm} km agora.`;
    }

    scheduleDecorate();
  }

  function offerSignature(itemId, offers) {
    if (!state.location) return 'no-location';
    if (!offers || !offers.length) return `no-offer:${state.radiusKm}`;
    const best = offers[0];
    return [
      itemId,
      state.radiusKm,
      offers.length,
      best.promo && best.promo.id,
      best.promo && best.promo.price,
      best.market && best.market.name,
      Number(best.distanceKm || 0).toFixed(2)
    ].join('|');
  }

  function decorateItemRows() {
    const list = $('lista-faltando');
    if (!list) return;
    const rows = list.querySelectorAll('.item-row[data-id]');

    rows.forEach((row) => {
      const itemId = String(row.dataset.id || '');
      const details = row.querySelector('.item-details');
      if (!details || !itemId) return;

      const offers = state.groupedOffers.get(itemId) || [];
      const signature = offerSignature(itemId, offers);
      let zone = details.querySelector('.item-offer-zone');
      if (zone && zone.dataset.signature === signature) return;
      if (zone) zone.remove();

      if (!state.location) return;

      zone = document.createElement('div');
      zone.className = 'item-offer-zone item-offer-action';
      zone.dataset.signature = signature;

      if (!offers.length) {
        zone.classList.add('no-offer');
        zone.textContent = `Sem oferta verificada em até ${state.radiusKm} km`;
        const actions = details.querySelector('.item-actions-inline');
        if (actions) details.insertBefore(zone, actions); else details.appendChild(zone);
        return;
      }

      const best = offers[0];
      const market = best.market && best.market.name ? best.market.name : 'Mercado';
      const unit = best.unit && best.unit.name ? best.unit.name : '';
      const price = M.formatCurrency(best.promo.price);
      const distance = Number(best.distanceKm || 0).toFixed(1).replace('.', ',');
      const countLabel = offers.length === 1 ? 'Ver oferta' : `Ver ${offers.length} ofertas`;
      const priceCondition = best.promo.requiresClub
        ? `💳 ${M.escapeHtml(best.promo.clubName || 'Preço Clube')}`
        : (best.promo.priceKind === 'condition' ? '⚠️ preço com condição' : 'melhor preço encontrado');

      zone.innerHTML = `
        <div class="item-offer-best">
          <span class="item-offer-flame" aria-hidden="true">🔥</span>
          <span class="item-offer-market">${M.escapeHtml(market)}${unit ? ` · ${M.escapeHtml(unit)}` : ''}</span>
          <span class="item-offer-price">${price}</span>
        </div>
        <div class="item-offer-sub">
          <span class="item-offer-distance">📍 ${distance} km · ${priceCondition}</span>
          <button type="button" class="item-offer-action" data-offers-item="${M.escapeHtml(itemId)}">${countLabel}</button>
        </div>`;
      const actions = details.querySelector('.item-actions-inline');
      if (actions) details.insertBefore(zone, actions); else details.appendChild(zone);
    });
  }

  function ensureOfferSheet() {
    let overlay = $('offer-sheet-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'offer-sheet-overlay';
    overlay.className = 'offer-sheet-overlay item-offer-action';
    overlay.innerHTML = `
      <section class="offer-sheet" role="dialog" aria-modal="true" aria-labelledby="offer-sheet-heading">
        <header class="offer-sheet-head">
          <div class="offer-sheet-title">
            <strong id="offer-sheet-heading">Ofertas</strong>
            <span id="offer-sheet-subtitle"></span>
          </div>
          <button type="button" class="offer-sheet-close item-offer-action" data-close-offer-sheet aria-label="Fechar">×</button>
        </header>
        <div id="offer-sheet-body" class="offer-sheet-body"></div>
      </section>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function offerCardHtml(offer, index, nearestDistance) {
    const p = offer.promo || {};
    const marketName = offer.market && offer.market.name ? offer.market.name : 'Mercado';
    const unitName = offer.unit && offer.unit.name ? offer.unit.name : 'Unidade';
    const previous = Number(p.previousPrice);
    const price = Number(p.price);
    const saving = Number.isFinite(previous) && previous > price ? previous - price : 0;
    const distance = Number(offer.distanceKm || 0);
    const isNearest = Math.abs(distance - nearestDistance) < 0.001;
    const destination = offer.unit && Number.isFinite(Number(offer.unit.lat)) && Number.isFinite(Number(offer.unit.lng))
      ? `${offer.unit.lat},${offer.unit.lng}`
      : `${marketName} ${unitName}`;
    const route = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;

    return `<article class="offer-sheet-card${index === 0 ? ' best' : ''}">
      <div class="offer-sheet-card-top">
        <div>
          <div class="offer-sheet-market">${M.escapeHtml(marketName)} · ${M.escapeHtml(unitName)}</div>
          <div class="offer-sheet-product">${M.escapeHtml(p.productName || '')}${p.brand ? ` · ${M.escapeHtml(p.brand)}` : ''}${p.packageText ? ` · ${M.escapeHtml(p.packageText)}` : ''}</div>
        </div>
        <div class="offer-sheet-price">${M.formatCurrency(price)}</div>
      </div>
      <div class="offer-sheet-meta">
        ${index === 0 ? '<span class="offer-pill best">⭐ Menor preço</span>' : ''}
        ${isNearest ? '<span class="offer-pill">📍 Mais perto</span>' : ''}
        <span class="offer-pill">${distance.toFixed(1).replace('.', ',')} km</span>
        ${saving > 0 ? `<span class="offer-pill best">economiza ${M.formatCurrency(saving)}</span>` : ''}
        ${p.requiresClub ? `<span class="offer-pill">💳 ${M.escapeHtml(p.clubName || 'Preço Clube')}</span>` : ''}
        ${p.priceKind === 'condition' ? '<span class="offer-pill">⚠️ preço com condição</span>' : ''}
        <span class="offer-pill best">✓ valor conferido</span>
        ${p.endAt ? `<span class="offer-pill">até ${M.formatDateTime(p.endAt)}</span>` : ''}
      </div>
      ${p.conditions ? `<div class="small muted" style="margin-top:9px"><strong>Condições:</strong> ${M.escapeHtml(p.conditions)}</div>` : ''}
      <div class="offer-sheet-actions"><a class="item-offer-action" target="_blank" rel="noopener" href="${route}">Abrir rota</a></div>
    </article>`;
  }

  function openOfferSheet(itemId) {
    const offers = sortOffers(state.groupedOffers.get(String(itemId)) || []);
    if (!offers.length) return;
    const overlay = ensureOfferSheet();
    const item = offers[0].item || {};
    const heading = $('offer-sheet-heading');
    const subtitle = $('offer-sheet-subtitle');
    const body = $('offer-sheet-body');
    const nearestDistance = Math.min(...offers.map((x) => Number(x.distanceKm || Infinity)));

    if (heading) heading.textContent = item.nome || item.name || 'Ofertas do item';
    if (subtitle) subtitle.textContent = `${offers.length} oferta${offers.length === 1 ? '' : 's'} em até ${state.radiusKm} km · menor preço primeiro`;
    if (body) body.innerHTML = offers.map((offer, index) => offerCardHtml(offer, index, nearestDistance)).join('');
    overlay.classList.add('visible');
    document.documentElement.style.overflow = 'hidden';
  }

  function closeOfferSheet() {
    const overlay = $('offer-sheet-overlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    document.documentElement.style.overflow = '';
  }

  function startListObserver() {
    const list = $('lista-faltando');
    if (!list || listObserver) return;
    listObserver = new MutationObserver(() => scheduleDecorate());
    listObserver.observe(list, { childList: true, subtree: true });
  }

  function startRealtimeListeners() {
    if (state.listenersStarted || !state.uid) return;
    state.listenersStarted = true;
    db.ref(`shopping_lists/${state.uid}`).on('value', (snap) => {
      state.items = snap.val() || {};
      renderCompactSummary();
    });
    db.ref('markets').on('value', (snap) => {
      state.markets = snap.val() || {};
      renderCompactSummary();
    });
    db.ref('market_units').on('value', (snap) => {
      state.units = snap.val() || {};
      renderCompactSummary();
    });
    db.ref('promotions').on('value', (snap) => {
      state.promotions = snap.val() || {};
      renderCompactSummary();
    });
  }

  async function loadSettings() {
    if (!state.uid) return;
    const snap = await db.ref(`user_settings/${state.uid}/radiusKm`).once('value');
    const saved = Number(snap.val());
    if ([1, 3, 5, 10, 25].includes(saved)) state.radiusKm = saved;
    if ($('geo-promo-radius')) $('geo-promo-radius').value = String(state.radiusKm);
  }

  async function saveRadiusSetting() {
    if (!state.uid) return;
    state.radiusKm = Number($('geo-promo-radius') && $('geo-promo-radius').value || state.radiusKm || 5);
    await db.ref(`user_settings/${state.uid}`).update({ radiusKm: state.radiusKm, updatedAt: M.serverTimestamp });
  }

  function applyLivePosition(pos, options) {
    if (!pos || !pos.coords) return;
    const lat = Number(pos.coords.latitude);
    const lng = Number(pos.coords.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    state.location = {
      lat,
      lng,
      accuracy: Number(pos.coords.accuracy) || 0,
      timestamp: Number(pos.timestamp) || Date.now()
    };
    state.lastLocationAt = state.location.timestamp;
    state.trackingActive = true;
    state.trackingStarting = false;

    const accuracy = Math.max(0, Math.round(state.location.accuracy || 0));
    const time = liveTimeLabel(state.location.timestamp);
    setStatus(`🟢 Localização em tempo real · precisão aproximada ${accuracy} m · atualizado ${time} · raio ${state.radiusKm} km.`, 'live');
    updateTrackingButton();
    renderCompactSummary();

    if (!state.firstLiveFix) {
      state.firstLiveFix = true;
      $('geo-promo-strip') && $('geo-promo-strip').classList.remove('open');
      if (options && options.announce) M.toast('GPS em tempo real ativado. As ofertas agora acompanham seu deslocamento.', 'success');
    }
  }

  async function startLiveTracking(options) {
    if (!state.uid) return;
    const automatic = Boolean(options && options.automatic);
    const announce = Boolean(options && options.announce);

    if (!navigator.geolocation) {
      setStatus('Este navegador não oferece geolocalização.', 'warn');
      M.toast('Este navegador não oferece geolocalização.', 'error');
      return;
    }

    state.radiusKm = Number($('geo-promo-radius') && $('geo-promo-radius').value || state.radiusKm || 5);
    if (!automatic) {
      try { await saveRadiusSetting(); } catch (_) {}
    }

    if (state.watchId != null) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (_) {}
      state.watchId = null;
    }

    state.trackingStarting = true;
    state.firstLiveFix = false;
    updateTrackingButton();
    setStatus('Ativando GPS em tempo real… mantenha a permissão de localização habilitada.', 'warn');

    try {
      state.watchId = navigator.geolocation.watchPosition(
        (pos) => applyLivePosition(pos, { announce: announce && !automatic }),
        (error) => {
          state.trackingStarting = false;
          const message = geoErrorMessage(error);

          if (error && error.code === 1) {
            stopLiveTracking();
            state.location = null;
            setStatus(`${message} Autorize a localização do navegador para receber ofertas por proximidade.`, 'warn');
            renderCompactSummary();
          } else {
            // Erros de indisponibilidade/timeout podem ser transitórios. Mantemos o watch ativo
            // para que o próximo fix do GPS atualize a lista automaticamente.
            setStatus(`🟠 Localização em tempo real aguardando novo sinal · ${message}`, 'warn');
            updateTrackingButton();
          }

          if (!automatic && error && error.code === 1) M.toast(message, 'error');
        },
        {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 0
        }
      );
    } catch (error) {
      stopLiveTracking();
      const message = geoErrorMessage(error);
      setStatus(message, 'warn');
      if (!automatic) M.toast(message, 'error');
    }
  }

  async function autoStartLiveTrackingIfAllowed() {
    if (!navigator.geolocation) return;
    if (!navigator.permissions || !navigator.permissions.query) return;
    try {
      const permission = await navigator.permissions.query({ name: 'geolocation' });
      if (permission.state === 'granted') await startLiveTracking({ automatic: true, announce: false });
      permission.onchange = () => {
        if (permission.state === 'granted' && state.watchId == null) {
          startLiveTracking({ automatic: true, announce: false });
        } else if (permission.state === 'denied') {
          stopLiveTracking();
          state.location = null;
          setStatus('Permissão de localização desativada. Ative-a para acompanhar ofertas em tempo real.', 'warn');
          renderCompactSummary();
        }
      };
    } catch (_) {
      /* iOS/Safari podem não expor Permissions API; o primeiro toque no botão ativa o watch. */
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    startListObserver();
    ensureOfferSheet();

    $('geo-promo-toggle')?.addEventListener('click', () => $('geo-promo-strip')?.classList.toggle('open'));
    $('geo-promo-locate')?.addEventListener('click', () => startLiveTracking({ automatic: false, announce: true }));
    $('geo-promo-radius')?.addEventListener('change', async (event) => {
      state.radiusKm = Number(event.target.value || 5);
      if (state.uid) {
        await db.ref(`user_settings/${state.uid}`).update({ radiusKm: state.radiusKm, updatedAt: M.serverTimestamp }).catch(() => {});
      }
      if (state.location) {
        setStatus(`🟢 Localização em tempo real · precisão aproximada ${Math.round(state.location.accuracy || 0)} m · atualizado ${liveTimeLabel(state.lastLocationAt)} · raio ${state.radiusKm} km.`, state.trackingActive ? 'live' : 'warn');
        renderCompactSummary();
      }
    });

    document.addEventListener('click', (event) => {
      const offerButton = event.target.closest('[data-offers-item]');
      if (offerButton) {
        event.preventDefault();
        event.stopPropagation();
        openOfferSheet(offerButton.dataset.offersItem);
        return;
      }
      if (event.target.closest('[data-close-offer-sheet]')) {
        event.preventDefault();
        event.stopPropagation();
        closeOfferSheet();
        return;
      }
      const overlay = event.target.closest('#offer-sheet-overlay');
      if (overlay && event.target === overlay) closeOfferSheet();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeOfferSheet();
    });
  });


  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.uid && state.watchId == null) {
      await autoStartLiveTrackingIfAllowed();
    }
  });

  window.addEventListener('pagehide', stopLiveTracking);
  window.addEventListener('beforeunload', stopLiveTracking);

  auth.onAuthStateChanged(async (user) => {
    if (!user) return;
    state.uid = user.uid;
    try {
      await loadSettings();
      startRealtimeListeners();
      await autoStartLiveTrackingIfAllowed();
    } catch (error) {
      console.warn('[Mercador IA] Não foi possível iniciar promoções próximas:', error);
      startRealtimeListeners();
    }
  });
})();

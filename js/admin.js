(function () {
  'use strict';

  const M = window.MercadorIA;
  const { db, auth, serverTimestamp, firebaseConfig } = M;
  const state = { users: {}, markets: {}, units: {}, promotions: {}, inbox: {}, audit: {}, profile: null, user: null, pdfImport: null };

  const byId = (id) => document.getElementById(id);
  const entries = (obj) => Object.entries(obj || {}).map(([id, value]) => ({ id, ...(value || {}) }));
  const activeNow = (promo) => {
    const now = Date.now();
    return promo.active === true && promo.verified === true && (!promo.startAt || Number(promo.startAt) <= now) && (!promo.endAt || Number(promo.endAt) >= now);
  };
  const getMarket = (id) => state.markets[id] || null;
  const getUnit = (id) => state.units[id] || null;

  function navigate(section) {
    document.querySelectorAll('.admin-section').forEach((el) => el.classList.toggle('active', el.id === `section-${section}`));
    document.querySelectorAll('[data-section]').forEach((el) => el.classList.toggle('active', el.dataset.section === section));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function audit(action, targetType, targetId, details = {}) {
    try {
      await db.ref('audit_logs').push({
        action,
        targetType,
        targetId: targetId || null,
        details,
        actorUid: state.user.uid,
        actorEmail: state.user.email || '',
        actorRole: state.profile.role,
        createdAt: serverTimestamp
      });
    } catch (error) {
      console.warn('[Mercador IA] Falha ao registrar auditoria:', error);
    }
  }

  function renderDashboard() {
    const users = entries(state.users);
    const markets = entries(state.markets);
    const units = entries(state.units);
    const promotions = entries(state.promotions);
    byId('kpiUsers').textContent = users.filter((x) => x.status === 'active').length;
    byId('kpiMarkets').textContent = markets.filter((x) => x.active === true).length;
    byId('kpiUnits').textContent = units.filter((x) => x.active === true).length;
    byId('kpiPromos').textContent = promotions.filter(activeNow).length;

    const unverified = promotions.filter((x) => x.active === true && x.verified !== true).length;
    const expired = promotions.filter((x) => x.endAt && Number(x.endAt) < Date.now()).length;
    byId('qualitySummary').innerHTML = `
      <div class="entity-card"><div class="entity-top"><div><div class="entity-title">Promoções aguardando conferência</div><div class="small muted">Não aparecem ao consumidor.</div></div><span class="badge ${unverified ? 'warn' : 'ok'}">${unverified}</span></div></div>
      <div class="entity-card"><div class="entity-top"><div><div class="entity-title">Promoções vencidas</div><div class="small muted">Mantidas para histórico administrativo.</div></div><span class="badge info">${expired}</span></div></div>`;
  }

  function renderUsers() {
    const q = M.normalizeText(byId('userSearch').value);
    const users = entries(state.users).filter((u) => !q || M.normalizeText(`${u.name} ${u.email} ${u.role}`).includes(q)).sort((a,b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    byId('userCountBadge').textContent = `${users.length} usuário${users.length === 1 ? '' : 's'}`;
    byId('usersList').innerHTML = users.length ? users.map((u) => {
      const isMaster = u.id === M.MASTER_UID;
      const roleClass = ['superadmin','admin'].includes(u.role) ? 'warn' : 'info';
      return `<article class="entity-card">
        <div class="entity-top">
          <div><div class="entity-title">${M.escapeHtml(u.name || 'Sem nome')}</div><div class="small muted">${M.escapeHtml(u.email || '')}</div>
            <div class="entity-meta"><span class="badge ${roleClass}">${M.escapeHtml(u.role || 'user')}</span><span class="badge ${u.status === 'active' ? 'ok' : 'danger'}">${u.status === 'active' ? 'ativo' : 'bloqueado'}</span>${isMaster ? '<span class="badge ok">MASTER</span>' : ''}<span class="badge">UID ${M.escapeHtml(u.id.slice(0,8))}…</span></div>
          </div>
          <div class="entity-actions">${isMaster ? '' : `<button class="btn btn-sm ${u.status === 'active' ? 'btn-danger' : 'btn-secondary'}" data-user-toggle="${u.id}">${u.status === 'active' ? 'Bloquear' : 'Ativar'}</button>`}</div>
        </div>
      </article>`;
    }).join('') : '<div class="empty">Nenhum usuário encontrado.</div>';
  }

  function renderMarkets() {
    const q = M.normalizeText(byId('marketSearch').value);
    const markets = entries(state.markets).filter((x) => !q || M.normalizeText(`${x.name} ${x.legalName} ${x.cnpj}`).includes(q)).sort((a,b) => String(a.name).localeCompare(String(b.name)));
    byId('marketCountBadge').textContent = `${markets.length} mercado${markets.length === 1 ? '' : 's'}`;
    byId('marketsList').innerHTML = markets.length ? markets.map((x) => {
      const unitCount = entries(state.units).filter((u) => u.marketId === x.id).length;
      return `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(x.name)}</div><div class="small muted">${M.escapeHtml(x.legalName || x.cnpj || 'Cadastro comercial')}</div><div class="entity-meta"><span class="badge ${x.active ? 'ok':'danger'}">${x.active ? 'ativo':'inativo'}</span><span class="badge info">${unitCount} unidade${unitCount === 1 ? '' : 's'}</span>${x.contact ? `<span class="badge">${M.escapeHtml(x.contact)}</span>`:''}</div></div><div class="entity-actions"><button class="btn btn-secondary btn-sm" data-market-edit="${x.id}">Editar</button><button class="btn btn-sm ${x.active ? 'btn-danger':'btn-secondary'}" data-market-toggle="${x.id}">${x.active ? 'Desativar':'Ativar'}</button></div></div></article>`;
    }).join('') : '<div class="empty">Nenhum mercado cadastrado.</div>';
    refreshMarketSelects();
  }

  function renderUnits() {
    const q = M.normalizeText(byId('unitSearch').value);
    const units = entries(state.units).filter((x) => !q || M.normalizeText(`${x.name} ${x.address} ${x.city} ${x.state} ${getMarket(x.marketId)?.name || ''}`).includes(q)).sort((a,b) => String(a.name).localeCompare(String(b.name)));
    byId('unitCountBadge').textContent = `${units.length} unidade${units.length === 1 ? '' : 's'}`;
    byId('unitsList').innerHTML = units.length ? units.map((x) => `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(x.name)}</div><div class="small muted">${M.escapeHtml(getMarket(x.marketId)?.name || 'Mercado não encontrado')} · ${M.escapeHtml(x.address || '')}, ${M.escapeHtml(x.city || '')}/${M.escapeHtml(x.state || '')}</div><div class="entity-meta"><span class="badge ${x.active ? 'ok':'danger'}">${x.active ? 'ativa':'inativa'}</span><span class="badge info">${Number(x.lat).toFixed(5)}, ${Number(x.lng).toFixed(5)}</span></div></div><div class="entity-actions"><a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${x.lat},${x.lng}`)}">Mapa</a><button class="btn btn-secondary btn-sm" data-unit-edit="${x.id}">Editar</button><button class="btn btn-sm ${x.active ? 'btn-danger':'btn-secondary'}" data-unit-toggle="${x.id}">${x.active ? 'Desativar':'Ativar'}</button></div></div></article>`).join('') : '<div class="empty">Nenhuma unidade cadastrada.</div>';
    refreshUnitSelects();
    refreshPdfImportUnitSelects();
  }

  function renderPromotions() {
    const q = M.normalizeText(byId('promoSearch').value);
    const filter = byId('promoFilter').value;
    let list = entries(state.promotions).filter((p) => !q || M.normalizeText(`${p.productName} ${p.brand} ${p.category} ${getMarket(p.marketId)?.name || ''}`).includes(q));
    if (filter === 'valid') list = list.filter(activeNow);
    if (filter === 'expired') list = list.filter((p) => p.endAt && Number(p.endAt) < Date.now());
    if (filter === 'inactive') list = list.filter((p) => p.active !== true);
    list.sort((a,b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
    byId('promoCountBadge').textContent = `${list.length} promoç${list.length === 1 ? 'ão':'ões'}`;
    byId('promotionsList').innerHTML = list.length ? list.map((p) => {
      const market = getMarket(p.marketId);
      const unit = getUnit(p.unitId);
      const saving = Number(p.previousPrice) > Number(p.price) ? Number(p.previousPrice) - Number(p.price) : 0;
      const valid = activeNow(p);
      return `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(p.productName)}</div><div class="small muted">${M.escapeHtml(market?.name || 'Mercado')} · ${M.escapeHtml(unit?.name || 'Unidade')}</div><div class="entity-meta"><span class="badge ${valid ? 'ok':(p.active ? 'warn':'danger')}">${valid ? 'válida agora':(p.active ? 'fora da validade':'inativa')}</span><span class="badge ${p.verified ? 'ok':'warn'}">${p.verified ? 'valor conferido':'não conferida'}</span><span class="badge info">${M.formatCurrency(p.price)}</span>${p.requiresClub ? `<span class="badge warn">💳 ${M.escapeHtml(p.clubName || 'Preço Clube')}</span>`:''}${saving > 0 ? `<span class="badge ok">economia ${M.formatCurrency(saving)}</span>`:''}<span class="badge">até ${M.formatDateTime(p.endAt)}</span></div><div class="small muted" style="margin-top:9px">Origem: ${M.escapeHtml(p.sourceType || '—')} · ${M.escapeHtml(p.sourceReference || 'sem referência')}</div>${p.conditions ? `<div class="small muted" style="margin-top:6px">Condições: ${M.escapeHtml(p.conditions)}</div>`:''}</div><div class="entity-actions"><button class="btn btn-secondary btn-sm" data-promo-edit="${p.id}">Editar</button><button class="btn btn-sm ${p.active ? 'btn-danger':'btn-secondary'}" data-promo-toggle="${p.id}">${p.active ? 'Desativar':'Ativar'}</button></div></div></article>`;
    }).join('') : '<div class="empty">Nenhuma promoção encontrada.</div>';
  }

  function renderInbox() {
    const list = entries(state.inbox).sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    byId('inboxList').innerHTML = list.length ? list.map((x) => `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(getMarket(x.marketId)?.name || 'Mercado não definido')}</div><div class="small muted">${M.escapeHtml(x.sourceType || 'recebimento')} · ${M.formatDateTime(x.createdAt)}</div><div style="white-space:pre-wrap;margin-top:10px;font-size:.86rem">${M.escapeHtml(x.rawText || '')}</div><div class="entity-meta"><span class="badge ${x.status === 'processed' ? 'ok':'warn'}">${x.status === 'processed' ? 'processado':'aguardando revisão'}</span></div></div><div class="entity-actions"><button class="btn btn-secondary btn-sm" data-inbox-promo="${x.id}">Usar em promoção</button>${x.status !== 'processed' ? `<button class="btn btn-primary btn-sm" data-inbox-process="${x.id}">Marcar revisado</button>`:''}</div></div></article>`).join('') : '<div class="empty">Nenhuma mensagem recebida ainda.</div>';
  }

  function renderAudit() {
    const list = entries(state.audit).sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0,80);
    byId('auditList').innerHTML = list.length ? list.map((x) => `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(x.action || 'ação')}</div><div class="small muted">${M.escapeHtml(x.actorEmail || x.actorUid || '')} · ${M.formatDateTime(x.createdAt)}</div><div class="entity-meta"><span class="badge info">${M.escapeHtml(x.targetType || 'sistema')}</span>${x.targetId ? `<span class="badge">${M.escapeHtml(String(x.targetId).slice(0,18))}</span>`:''}</div></div></div></article>`).join('') : '<div class="empty">A auditoria começará a ser preenchida conforme o painel for utilizado.</div>';
  }

  function refreshMarketSelects() {
    const options = entries(state.markets).filter((x) => x.active === true).sort((a,b) => String(a.name).localeCompare(String(b.name))).map((x) => `<option value="${x.id}">${M.escapeHtml(x.name)}</option>`).join('');
    ['unitMarketId','promoMarketId','pdfImportMarketId'].forEach((id) => { const el = byId(id); if (!el) return; const current = el.value; el.innerHTML = `<option value="">Selecione...</option>${options}`; if ([...el.options].some((o) => o.value === current)) el.value = current; });
    const inbox = byId('inboxMarketId'); if (inbox) { const current = inbox.value; inbox.innerHTML = `<option value="">Não definido</option>${options}`; if ([...inbox.options].some((o) => o.value === current)) inbox.value = current; }
    refreshUnitSelects();
    refreshPdfImportUnitSelects();
  }

  function refreshUnitSelects() {
    const marketId = byId('promoMarketId')?.value;
    const el = byId('promoUnitId');
    if (!el) return;
    const current = el.value;
    const options = entries(state.units).filter((x) => x.active === true && (!marketId || x.marketId === marketId)).sort((a,b) => String(a.name).localeCompare(String(b.name))).map((x) => `<option value="${x.id}">${M.escapeHtml(x.name)} — ${M.escapeHtml(x.city || '')}</option>`).join('');
    el.innerHTML = `<option value="">Selecione...</option>${options}`;
    if ([...el.options].some((o) => o.value === current)) el.value = current;
  }

  function refreshPdfImportUnitSelects() {
    const marketId = byId('pdfImportMarketId')?.value;
    const el = byId('pdfImportUnitId');
    if (!el) return;
    const current = el.value;
    const options = entries(state.units)
      .filter((x) => x.active === true && (!marketId || x.marketId === marketId))
      .sort((a,b) => String(a.name).localeCompare(String(b.name)))
      .map((x) => `<option value="${x.id}">${M.escapeHtml(x.name)} — ${M.escapeHtml(x.city || '')}</option>`).join('');
    el.innerHTML = `<option value="">Selecione...</option>${options}`;
    if ([...el.options].some((o) => o.value === current)) el.value = current;
  }

  function listenData() {
    db.ref('users').on('value', (s) => { state.users = s.val() || {}; renderUsers(); renderDashboard(); });
    db.ref('markets').on('value', (s) => { state.markets = s.val() || {}; renderMarkets(); renderUnits(); renderPromotions(); renderInbox(); renderDashboard(); });
    db.ref('market_units').on('value', (s) => { state.units = s.val() || {}; renderUnits(); renderPromotions(); renderDashboard(); });
    db.ref('promotions').on('value', (s) => { state.promotions = s.val() || {}; renderPromotions(); renderDashboard(); });
    db.ref('promotion_inbox').on('value', (s) => { state.inbox = s.val() || {}; renderInbox(); });
    db.ref('audit_logs').limitToLast(80).on('value', (s) => { state.audit = s.val() || {}; renderAudit(); });
  }

  function bindNavigation() {
    document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.section)));
    document.querySelectorAll('[data-open-modal]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.openModal;
      if (id === 'marketModal') resetMarketForm();
      if (id === 'unitModal') resetUnitForm();
      if (id === 'promotionModal') resetPromotionForm();
      if (id === 'userModal') byId('userForm').reset();
      if (id === 'inboxModal') byId('inboxForm').reset();
      M.openModal(id);
    }));
  }

  function resetMarketForm() { const f = byId('marketForm'); f.reset(); f.elements.id.value = ''; f.elements.active.checked = true; byId('marketModalTitle').textContent = 'Cadastrar mercado'; }
  function resetUnitForm() { const f = byId('unitForm'); f.reset(); f.elements.id.value = ''; f.elements.active.checked = true; byId('unitModalTitle').textContent = 'Cadastrar unidade'; refreshMarketSelects(); }
  function resetPromotionForm() {
    const f = byId('promotionForm'); f.reset(); f.elements.id.value = ''; f.elements.active.checked = true; f.elements.verified.checked = false; f.elements.priceKind.value = 'general'; byId('promotionModalTitle').textContent = 'Cadastrar promoção real';
    const now = new Date(); const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    f.elements.startAt.value = M.toLocalDateTimeInput(now.getTime()); f.elements.endAt.value = M.toLocalDateTimeInput(end.getTime()); refreshMarketSelects();
  }

  async function createUser(event) {
    event.preventDefault();
    const f = event.currentTarget;
    const btn = byId('userSubmit');
    const name = f.elements.name.value.trim();
    const email = f.elements.email.value.trim().toLowerCase();
    const password = f.elements.password.value;
    const role = f.elements.role.value;
    if (role === 'admin' && state.profile.role !== 'superadmin') { M.toast('Somente SuperAdmin pode criar outro administrador.', 'error'); return; }
    M.setBusy(btn, true, 'Criando...');
    try {
      const secondaryApp = firebase.apps.find((x) => x.name === 'AdminUserCreator') || firebase.initializeApp(firebaseConfig, 'AdminUserCreator');
      const secondaryAuth = secondaryApp.auth();
      await secondaryAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
      const credential = await secondaryAuth.createUserWithEmailAndPassword(email, password);
      const uid = credential.user.uid;
      await secondaryAuth.signOut();
      await db.ref(`users/${uid}`).set({ name, email, role, status: 'active', createdAt: serverTimestamp, createdBy: state.user.uid, updatedAt: serverTimestamp });
      await db.ref(`user_settings/${uid}`).set({ radiusKm: 5, updatedAt: serverTimestamp });
      await audit('user_created', 'user', uid, { email, role });
      f.reset(); M.closeModal('userModal'); M.toast('Usuário criado com sucesso.', 'success');
    } catch (error) {
      const msg = error.code === 'auth/email-already-in-use' ? 'Esse e-mail já está cadastrado no Firebase Authentication.' : (error.message || 'Falha ao criar usuário.');
      M.toast(msg, 'error', 7000);
    } finally { M.setBusy(btn, false); }
  }

  async function saveMarket(event) {
    event.preventDefault(); const f = event.currentTarget; const id = f.elements.id.value || db.ref('markets').push().key;
    const value = { name:f.elements.name.value.trim(), legalName:f.elements.legalName.value.trim(), cnpj:f.elements.cnpj.value.trim(), contact:f.elements.contact.value.trim(), website:f.elements.website.value.trim(), active:f.elements.active.checked, updatedAt:serverTimestamp, updatedBy:state.user.uid };
    if (!f.elements.id.value) { value.createdAt = serverTimestamp; value.createdBy = state.user.uid; }
    await db.ref(`markets/${id}`).update(value); await audit(f.elements.id.value ? 'market_updated':'market_created','market',id,{name:value.name}); M.closeModal('marketModal'); M.toast('Mercado salvo.', 'success');
  }

  async function saveUnit(event) {
    event.preventDefault(); const f = event.currentTarget; const id = f.elements.id.value || db.ref('market_units').push().key;
    const lat = Number(f.elements.lat.value), lng = Number(f.elements.lng.value);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) { M.toast('Latitude ou longitude inválida.', 'warning'); return; }
    const value = { marketId:f.elements.marketId.value, name:f.elements.name.value.trim(), address:f.elements.address.value.trim(), city:f.elements.city.value.trim(), state:f.elements.state.value.trim().toUpperCase(), lat, lng, active:f.elements.active.checked, updatedAt:serverTimestamp, updatedBy:state.user.uid };
    if (!f.elements.id.value) { value.createdAt=serverTimestamp; value.createdBy=state.user.uid; }
    await db.ref(`market_units/${id}`).update(value); await audit(f.elements.id.value ? 'unit_updated':'unit_created','market_unit',id,{name:value.name,marketId:value.marketId}); M.closeModal('unitModal'); M.toast('Unidade salva.', 'success');
  }

  async function savePromotion(event) {
    event.preventDefault(); const f=event.currentTarget; const id=f.elements.id.value || db.ref('promotions').push().key;
    const startAt=M.toTimestampFromLocalInput(f.elements.startAt.value), endAt=M.toTimestampFromLocalInput(f.elements.endAt.value); const price=Number(f.elements.price.value), previousPrice=f.elements.previousPrice.value ? Number(f.elements.previousPrice.value) : null;
    if (!startAt || !endAt || endAt <= startAt) { M.toast('A validade deve terminar depois do início.', 'warning'); return; }
    if (!Number.isFinite(price) || price <= 0) { M.toast('Informe um preço promocional válido.', 'warning'); return; }
    if (!f.elements.verified.checked) { M.toast('A promoção só pode ser salva como oferta real após a conferência do valor.', 'warning'); return; }
    const unit=getUnit(f.elements.unitId.value); if (!unit || unit.marketId !== f.elements.marketId.value) { M.toast('A unidade selecionada não pertence ao mercado informado.', 'error'); return; }
    const priceKind=f.elements.priceKind.value || 'general'; const requiresClub=priceKind==='club'; const clubName=f.elements.clubName.value.trim(); const conditions=f.elements.conditions.value.trim();
    if (requiresClub && !clubName) { M.toast('Informe o nome do Clube/programa exigido por esse preço.', 'warning'); return; }
    if (priceKind === 'condition' && !conditions) { M.toast('Descreva a condição necessária para esse preço.', 'warning'); return; }
    const value={ marketId:f.elements.marketId.value, unitId:f.elements.unitId.value, productName:f.elements.productName.value.trim(), category:M.slugify(f.elements.category.value).replaceAll('-','_') || M.inferCategory(f.elements.productName.value) || 'outros', brand:f.elements.brand.value.trim(), packageText:f.elements.packageText.value.trim(), price, previousPrice, startAt, endAt, sourceType:f.elements.sourceType.value, sourceReference:f.elements.sourceReference.value.trim(), aliases:f.elements.aliases.value.trim(), priceKind, requiresClub, clubName:requiresClub?clubName:'', conditions, verified:true, verifiedAt:serverTimestamp, verifiedBy:state.user.uid, active:f.elements.active.checked, updatedAt:serverTimestamp, updatedBy:state.user.uid };
    if (!f.elements.id.value) { value.createdAt=serverTimestamp; value.createdBy=state.user.uid; }
    await db.ref(`promotions/${id}`).update(value); await audit(f.elements.id.value ? 'promotion_updated':'promotion_created','promotion',id,{product:value.productName,price:value.price,marketId:value.marketId}); M.closeModal('promotionModal'); M.toast('Promoção real salva e conferida.', 'success');
  }

  async function saveInbox(event) {
    event.preventDefault(); const f=event.currentTarget; const ref=db.ref('promotion_inbox').push(); const value={ marketId:f.elements.marketId.value || null, sourceType:f.elements.sourceType.value, rawText:f.elements.rawText.value.trim(), status:'pending', createdAt:serverTimestamp, createdBy:state.user.uid };
    await ref.set(value); await audit('inbox_received','promotion_inbox',ref.key,{marketId:value.marketId,sourceType:value.sourceType}); M.closeModal('inboxModal'); f.reset(); M.toast('Recebimento registrado para revisão.', 'success');
  }

  function populateMarketForm(id) { const x=state.markets[id]; if(!x)return; resetMarketForm(); const f=byId('marketForm'); Object.entries(x).forEach(([k,v])=>{ if(f.elements[k] && k!=='active') f.elements[k].value=v ?? ''; }); f.elements.id.value=id; f.elements.active.checked=x.active===true; byId('marketModalTitle').textContent='Editar mercado'; M.openModal('marketModal'); }
  function populateUnitForm(id) { const x=state.units[id]; if(!x)return; resetUnitForm(); const f=byId('unitForm'); ['marketId','name','address','city','state','lat','lng'].forEach((k)=>{ if(f.elements[k])f.elements[k].value=x[k] ?? '';}); f.elements.id.value=id; f.elements.active.checked=x.active===true; byId('unitModalTitle').textContent='Editar unidade'; M.openModal('unitModal'); }
  function populatePromotionForm(id) { const x=state.promotions[id]; if(!x)return; resetPromotionForm(); const f=byId('promotionForm'); ['marketId','productName','category','brand','packageText','price','previousPrice','sourceType','sourceReference','clubName','conditions','aliases'].forEach((k)=>{ if(f.elements[k])f.elements[k].value=x[k] ?? '';}); f.elements.priceKind.value=x.priceKind || (x.requiresClub ? 'club':'general'); refreshUnitSelects(); f.elements.unitId.value=x.unitId || ''; f.elements.startAt.value=M.toLocalDateTimeInput(x.startAt); f.elements.endAt.value=M.toLocalDateTimeInput(x.endAt); f.elements.id.value=id; f.elements.active.checked=x.active===true; f.elements.verified.checked=x.verified===true; byId('promotionModalTitle').textContent='Editar promoção'; M.openModal('promotionModal'); }

  async function toggle(path,id,field,current,action,type) { await db.ref(`${path}/${id}/${field}`).set(!current); await db.ref(`${path}/${id}/updatedAt`).set(serverTimestamp); await audit(action,type,id,{[field]:!current}); M.toast('Status atualizado.', 'success'); }


  function getPdfImport() {
    return state.pdfImport;
  }

  function resetPdfImport() {
    state.pdfImport = null;
    const workspace = byId('pdfImportWorkspace');
    if (workspace) workspace.hidden = true;
    const progress = byId('pdfImportProgress');
    if (progress) progress.hidden = true;
    if (byId('pdfImportProgressBar')) byId('pdfImportProgressBar').style.width = '0%';
    if (byId('pdfImportStatus')) byId('pdfImportStatus').textContent = 'Selecione mercado, unidade e PDF.';
    if (byId('pdfCandidatesList')) byId('pdfCandidatesList').innerHTML = '';
    if (byId('pdfImportMeta')) byId('pdfImportMeta').textContent = '';
    if (byId('pdfCandidateSearch')) byId('pdfCandidateSearch').value = '';
    if (byId('pdfCandidateFilter')) byId('pdfCandidateFilter').value = 'all';
    if (byId('pdfImportFile')) byId('pdfImportFile').value = '';
  }

  function setPdfProgress(percent, text) {
    const progress = byId('pdfImportProgress');
    const bar = byId('pdfImportProgressBar');
    if (progress) progress.hidden = false;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    if (text && byId('pdfImportStatus')) byId('pdfImportStatus').textContent = text;
  }

  function confidenceLabel(value) {
    const n = Math.round(Number(value || 0) * 100);
    if (n >= 98) return { n, label:'muito alta', klass:'ok' };
    if (n >= 90) return { n, label:'alta', klass:'info' };
    if (n >= 75) return { n, label:'média', klass:'warn' };
    return { n, label:'baixa', klass:'danger' };
  }

  const PDF_RISK_LABELS = {
    association_disagreement: 'associação produto↔preço conflitante',
    single_association_pass: 'apenas uma associação espacial',
    short_product_name: 'descrição curta',
    missing_validity: 'validade não identificada',
    too_many_prices: 'mais de dois preços no mesmo bloco',
    ambiguous_price_kind: 'tipo do preço ambíguo',
    invalid_price: 'preço inválido',
    invalid_previous_price: 'preço anterior inconsistente',
    header_contamination: 'texto de cabeçalho misturado',
    price_inside_product_text: 'preço misturado ao nome',
    overlong_product_text: 'descrição excessivamente longa',
    missing_club_name: 'programa/clube sem nome'
  };

  function automationThreshold() {
    const raw = Number(byId('pdfAutomationMode')?.value || .98);
    return Number.isFinite(raw) ? Math.max(.97, Math.min(.99, raw)) : .98;
  }

  function classifyPdfCandidate(candidate, threshold = automationThreshold()) {
    if (candidate.published) return 'published';
    if (candidate.ignored) return 'ignored';
    if (candidate.verified && candidate.verificationMode === 'manual') return 'manual';
    const risks = new Set(candidate.riskFlags || []);
    candidate.riskFlags = [...risks];
    const hardBlock = ['association_disagreement','missing_validity','too_many_prices','ambiguous_price_kind','invalid_price','invalid_previous_price','header_contamination','price_inside_product_text']
      .some((x) => risks.has(x));
    if (!hardBlock && candidate.automationSafe === true && Number(candidate.confidence || 0) >= threshold) return 'auto';
    if (!hardBlock && Number(candidate.confidence || 0) >= .90) return 'supervised';
    return 'review';
  }

  function refreshPdfClassifications() {
    const imp = getPdfImport();
    if (!imp) return;
    const threshold = imp.threshold || automationThreshold();
    imp.threshold = threshold;
    imp.candidates.forEach((candidate) => {
      if (!candidate.published && !candidate.ignored && !(candidate.verified && candidate.verificationMode === 'manual')) {
        candidate.automationDecision = classifyPdfCandidate(candidate, threshold);
      }
    });
  }

  function pdfCandidateStatus(candidate) {
    if (candidate.published) return { label:candidate.verificationMode === 'automatic' ? 'publicado automático' : 'publicado', klass:'info' };
    if (candidate.ignored) return { label:'ignorado', klass:'danger' };
    if (candidate.verified && candidate.verificationMode === 'manual') return { label:'conferido manualmente', klass:'ok' };
    if (candidate.automationDecision === 'auto') return { label:'automático seguro', klass:'ok' };
    if (candidate.automationDecision === 'supervised') return { label:'supervisionado', klass:'warn' };
    return { label:'revisão necessária', klass:'danger' };
  }

  function renderPdfImport() {
    const imp = getPdfImport();
    const workspace = byId('pdfImportWorkspace');
    if (!imp || !workspace) {
      if (workspace) workspace.hidden = true;
      return;
    }
    refreshPdfClassifications();
    workspace.hidden = false;
    const candidates = imp.candidates || [];
    const autoPending = candidates.filter((x) => !x.published && !x.ignored && x.automationDecision === 'auto').length;
    const manualReady = candidates.filter((x) => x.verified && x.verificationMode === 'manual' && !x.published && !x.ignored).length;
    const reviewPending = candidates.filter((x) => !x.published && !x.ignored && x.automationDecision !== 'auto' && !(x.verified && x.verificationMode === 'manual')).length;
    const published = candidates.filter((x) => x.published).length;
    byId('pdfKpiCandidates').textContent = candidates.length;
    byId('pdfKpiPagesFoot').textContent = `${imp.result.numPages || 0} página${imp.result.numPages === 1 ? '' : 's'}`;
    byId('pdfKpiAuto').textContent = autoPending;
    byId('pdfKpiReview').textContent = reviewPending;
    byId('pdfKpiPublished').textContent = published;

    const validity = imp.result.validity || {};
    const validityText = validity.startAt && validity.endAt
      ? `${M.formatDateOnly(validity.startAt)} a ${M.formatDateOnly(validity.endAt)}`
      : 'validade não confirmada automaticamente';
    const thresholdPct = Math.round((imp.threshold || .98) * 100);
    byId('pdfImportMeta').innerHTML = `<div class="pdf-automation-summary">Arquivo: <strong>${M.escapeHtml(imp.result.fileName)}</strong> · ${imp.result.numPages} página${imp.result.numPages === 1 ? '' : 's'} · ${M.escapeHtml(validityText)} · SHA-256 ${M.escapeHtml((imp.result.hash || '').slice(0,16))}…<br><strong>${autoPending}</strong> automáticos aguardando publicação · <strong>${reviewPending}</strong> exceções para revisão · limite automático <strong>${thresholdPct}%</strong> · motor ${M.escapeHtml(imp.result.engineVersion || '2.0.0')} / PDF.js ${M.escapeHtml(imp.result.pdfjsVersion || '')}</div>`;

    const q = M.normalizeText(byId('pdfCandidateSearch')?.value || '');
    const filter = byId('pdfCandidateFilter')?.value || 'all';
    let list = candidates.filter((x) => !q || M.normalizeText(`${x.productName} ${x.category} ${x.brand} ${x.packageText}`).includes(q));
    if (filter === 'auto') list = list.filter((x) => !x.published && !x.ignored && x.automationDecision === 'auto');
    if (filter === 'pending') list = list.filter((x) => !x.published && !x.ignored && x.automationDecision !== 'auto' && !(x.verified && x.verificationMode === 'manual'));
    if (filter === 'verified') list = list.filter((x) => x.verified && x.verificationMode === 'manual' && !x.published && !x.ignored);
    if (filter === 'published') list = list.filter((x) => x.published);
    if (filter === 'ignored') list = list.filter((x) => x.ignored);
    if (filter === 'low') list = list.filter((x) => Number(x.confidence || 0) < .90 && !x.ignored);

    byId('pdfCandidatesList').innerHTML = list.length ? list.map((x) => {
      const conf = confidenceLabel(x.confidence);
      const status = pdfCandidateStatus(x);
      const hasOld = Number(x.previousPrice) > Number(x.price);
      const priceType = x.priceKind === 'club' ? `💳 ${x.clubName || 'Preço Clube'}` : (x.priceKind === 'condition' ? 'Preço com condição' : (x.priceKind === 'review' ? 'tipo de preço a confirmar' : 'preço geral'));
      const decisionClass = x.automationDecision === 'auto' ? 'auto-approved' : (x.automationDecision === 'supervised' ? 'needs-review' : (x.automationDecision === 'review' ? 'blocked-auto' : ''));
      const riskHtml = (x.riskFlags || []).length ? `<div class="pdf-risk-list">${x.riskFlags.map((r) => `<span class="pdf-risk-chip">⚠ ${M.escapeHtml(PDF_RISK_LABELS[r] || r)}</span>`).join('')}</div>` : '';
      const evidenceHtml = (x.evidence || []).length ? `<div class="pdf-evidence-list">${x.evidence.slice(0,5).map((e) => `<span class="pdf-evidence-chip">✓ ${M.escapeHtml(e)}</span>`).join('')}</div>` : '';
      return `<article class="entity-card pdf-candidate-card ${decisionClass} ${x.verified ? 'verified':''} ${x.published ? 'published':''} ${x.ignored ? 'ignored':''}">
        <div class="pdf-candidate-main">
          <div>
            <div class="entity-title">${M.escapeHtml(x.productName)}</div>
            <div class="small muted">Página ${x.pageNumber} · ${M.escapeHtml(x.category || 'outros')}${x.packageText ? ` · ${M.escapeHtml(x.packageText)}`:''}</div>
            <div class="entity-meta">
              <span class="badge ${status.klass}">${status.label}</span>
              <span class="badge ${conf.klass}">confiança ${conf.n}% · ${conf.label}</span>
              <span class="badge">${M.escapeHtml(priceType)}</span>
              ${x.detectedPrices?.length > 1 ? `<span class="badge warn">${x.detectedPrices.length} preços detectados</span>`:''}
            </div>
            ${evidenceHtml}${riskHtml}
            ${x.conditions ? `<div class="small muted pdf-source-meta">Condições: ${M.escapeHtml(x.conditions)}</div>`:''}
          </div>
          <div class="pdf-price-stack">
            <span class="pdf-price-main">${M.formatCurrency(x.price)}</span>
            ${hasOld ? `<span class="pdf-price-old">${M.formatCurrency(x.previousPrice)}</span>`:''}
          </div>
        </div>
        <div class="pdf-confidence ${conf.n < 90 ? 'low':''}">
          <div class="pdf-confidence-track"><span style="width:${conf.n}%"></span></div>
          <span class="small muted">Associação espacial dupla: ${Math.round(Number(x.associationAgreement || 0) * 100)}%.</span>
        </div>
        <div class="entity-actions" style="margin-top:12px">
          <button class="btn btn-secondary btn-sm" type="button" data-pdf-review="${M.escapeHtml(x.id)}">${x.published ? 'Ver origem' : (x.automationDecision === 'auto' ? 'Ver evidência' : 'Revisar exceção')}</button>
        </div>
      </article>`;
    }).join('') : '<div class="empty">Nenhum candidato neste filtro.</div>';

    const publishBtn = byId('pdfPublishVerifiedBtn');
    if (publishBtn) {
      publishBtn.disabled = manualReady === 0;
      publishBtn.textContent = manualReady ? `Publicar ${manualReady} revisada${manualReady === 1 ? '' : 's'}` : 'Publicar revisados';
    }
    const autoBtn = byId('pdfPublishAutoBtn');
    if (autoBtn) {
      autoBtn.disabled = autoPending === 0;
      autoBtn.textContent = autoPending ? `Publicar ${autoPending} automática${autoPending === 1 ? '' : 's'}` : 'Publicar automáticos seguros';
    }
  }

  async function analyzePdfImport(event) {
    event.preventDefault();
    const importer = window.MercadorPDFImporter;
    if (!importer) { M.toast('Módulo de PDF não carregado. Verifique a conexão e recarregue o painel.', 'error', 7000); return; }
    const marketId = byId('pdfImportMarketId').value;
    const unitId = byId('pdfImportUnitId').value;
    const file = byId('pdfImportFile').files?.[0];
    const unit = getUnit(unitId);
    if (!marketId || !unitId || !unit || unit.marketId !== marketId) { M.toast('Selecione um mercado e uma unidade válidos.', 'warning'); return; }
    if (!file) { M.toast('Selecione o PDF oficial do encarte.', 'warning'); return; }

    const btn = byId('pdfImportAnalyzeBtn');
    M.setBusy(btn, true, 'Analisando e conferindo...');
    setPdfProgress(2, 'Carregando o motor automático...');
    try {
      const lowerPriceIsClub = byId('pdfImportLowerIsClub').checked;
      const clubName = byId('pdfImportClubName').value.trim();
      const threshold = automationThreshold();
      const result = await importer.analyzeFile(file, { lowerPriceIsClub, clubName }, (progress) => {
        setPdfProgress(progress.percent, `Conferindo página ${progress.pageNumber} de ${progress.numPages}...`);
      });
      result.engineVersion = importer.ENGINE_VERSION || '2.0.0';
      if (result.validity?.startAt && !byId('pdfImportStartAt').value) byId('pdfImportStartAt').value = M.toLocalDateTimeInput(result.validity.startAt);
      if (result.validity?.endAt && !byId('pdfImportEndAt').value) byId('pdfImportEndAt').value = M.toLocalDateTimeInput(result.validity.endAt);

      state.pdfImport = {
        result,
        candidates: result.candidates.map((x) => ({ ...x, detectedProductName: x.productName })),
        marketId,
        unitId,
        sourceUrl: byId('pdfImportSourceUrl').value.trim(),
        lowerPriceIsClub,
        clubName,
        threshold
      };
      refreshPdfClassifications();
      const autoCount = state.pdfImport.candidates.filter((x) => x.automationDecision === 'auto').length;
      const reviewCount = state.pdfImport.candidates.filter((x) => x.automationDecision !== 'auto').length;
      setPdfProgress(100, `${result.candidates.length} ofertas detectadas: ${autoCount} seguras para automação e ${reviewCount} exceções.`);
      renderPdfImport();
      await audit('pdf_import_analyzed_v2', 'pdf_import', (result.hash || '').slice(0,20), { fileName:result.fileName, pages:result.numPages, candidates:result.candidates.length, auto:autoCount, review:reviewCount, threshold, marketId, unitId, engineVersion:result.engineVersion });
      if (!result.candidates.length) {
        M.toast('O PDF foi lido, mas nenhum bloco de produto/preço foi associado com segurança.', 'warning', 8000);
      } else if (byId('pdfAutoPublish')?.checked && autoCount) {
        await publishAutomaticPdfCandidates(true);
        const remaining = state.pdfImport.candidates.filter((x) => !x.published && !x.ignored && x.automationDecision !== 'auto').length;
        setPdfProgress(100, `Automação concluída. ${remaining} exceção${remaining === 1 ? '' : 'ões'} aguardando revisão.`);
        M.toast(`Automação concluída. Revise somente ${remaining} exceção${remaining === 1 ? '' : 'ões'}.`, remaining ? 'info' : 'success', 7000);
      } else {
        M.toast(`Análise concluída: ${autoCount} automáticas e ${reviewCount} para supervisão.`, 'success', 6500);
      }
    } catch (error) {
      console.error(error);
      state.pdfImport = null;
      byId('pdfImportWorkspace').hidden = true;
      setPdfProgress(0, error.message || 'Falha ao analisar o PDF.');
      M.toast(error.message || 'Falha ao analisar o encarte.', 'error', 8000);
    } finally {
      M.setBusy(btn, false);
    }
  }

  async function openPdfReview(candidateId) {
    const imp = getPdfImport();
    const candidate = imp?.candidates.find((x) => x.id === candidateId);
    if (!candidate) return;
    const f = byId('pdfReviewForm');
    f.reset();
    f.elements.candidateId.value = candidate.id;
    f.elements.productName.value = candidate.productName || '';
    f.elements.category.value = candidate.category || M.inferCategory(candidate.productName) || 'outros';
    f.elements.brand.value = candidate.brand || '';
    f.elements.packageText.value = candidate.packageText || '';
    f.elements.price.value = Number(candidate.price || 0).toFixed(2);
    f.elements.previousPrice.value = Number(candidate.previousPrice) > 0 ? Number(candidate.previousPrice).toFixed(2) : '';
    f.elements.priceKind.value = candidate.priceKind === 'review' ? '' : (candidate.priceKind || 'general');
    f.elements.clubName.value = candidate.clubName || imp.clubName || '';
    f.elements.conditions.value = candidate.conditions || '';
    const globalStart = M.toTimestampFromLocalInput(byId('pdfImportStartAt').value);
    const globalEnd = M.toTimestampFromLocalInput(byId('pdfImportEndAt').value);
    f.elements.startAt.value = M.toLocalDateTimeInput(candidate.startAt || globalStart || imp.result.validity?.startAt);
    f.elements.endAt.value = M.toLocalDateTimeInput(candidate.endAt || globalEnd || imp.result.validity?.endAt);
    f.elements.verified.checked = candidate.verified === true;
    byId('pdfReviewSource').textContent = `${imp.result.fileName} · página ${candidate.pageNumber} · SHA-256 ${(imp.result.hash || '').slice(0,16)}…`;
    byId('pdfDetectedPrices').textContent = `Valores detectados nesta região: ${(candidate.detectedPrices || [candidate.price]).map(M.formatCurrency).join(' · ')}. A detecção automática é apenas uma sugestão; confira a imagem acima.`;
    M.openModal('pdfReviewModal');
    const canvas = byId('pdfReviewCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 560; canvas.height = 160;
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#333'; ctx.font = '16px sans-serif'; ctx.fillText('Renderizando recorte da página...', 20, 50);
    try {
      await window.MercadorPDFImporter.renderPreview(candidate, canvas);
    } catch (error) {
      console.error(error);
      M.toast('Não foi possível renderizar o recorte, mas os dados podem ser revisados manualmente.', 'warning');
    }
  }

  function savePdfReview(event) {
    event.preventDefault();
    const imp = getPdfImport();
    if (!imp) return;
    const f = event.currentTarget;
    const candidate = imp.candidates.find((x) => x.id === f.elements.candidateId.value);
    if (!candidate || candidate.published) { M.closeModal('pdfReviewModal'); return; }

    const price = Number(f.elements.price.value);
    const previousPrice = f.elements.previousPrice.value ? Number(f.elements.previousPrice.value) : null;
    const startAt = M.toTimestampFromLocalInput(f.elements.startAt.value);
    const endAt = M.toTimestampFromLocalInput(f.elements.endAt.value);
    const priceKind = f.elements.priceKind.value;
    const clubName = f.elements.clubName.value.trim();
    const conditions = f.elements.conditions.value.trim();
    if (!Number.isFinite(price) || price <= 0) { M.toast('Informe o preço correto do encarte.', 'warning'); return; }
    if (!startAt || !endAt || endAt <= startAt) { M.toast('Confira o período de validade.', 'warning'); return; }
    if (!priceKind) { M.toast('Defina se é preço geral, Clube ou outra condição.', 'warning'); return; }
    if (priceKind === 'club' && !clubName) { M.toast('Informe o nome do Clube/programa exigido pelo preço.', 'warning'); return; }
    if (priceKind === 'condition' && !conditions) { M.toast('Descreva a condição necessária para esse preço.', 'warning'); return; }
    if (f.elements.verified.checked && (!f.elements.productName.value.trim() || !f.elements.category.value.trim())) { M.toast('Produto e categoria precisam estar conferidos.', 'warning'); return; }

    Object.assign(candidate, {
      productName: f.elements.productName.value.trim(),
      category: M.slugify(f.elements.category.value).replaceAll('-','_') || M.inferCategory(f.elements.productName.value) || 'outros',
      brand: f.elements.brand.value.trim(),
      packageText: f.elements.packageText.value.trim(),
      price,
      previousPrice: Number.isFinite(previousPrice) && previousPrice > price ? previousPrice : null,
      priceKind,
      requiresClub: priceKind === 'club',
      clubName: priceKind === 'club' ? clubName : '',
      conditions: conditions.slice(0,250),
      startAt,
      endAt,
      verified: f.elements.verified.checked,
      verificationMode: f.elements.verified.checked ? 'manual' : '',
      automationDecision: f.elements.verified.checked ? 'manual' : classifyPdfCandidate(candidate, imp.threshold || automationThreshold()),
      reviewed: true,
      ignored: false
    });
    M.closeModal('pdfReviewModal');
    renderPdfImport();
    M.toast(candidate.verified ? 'Oferta conferida e pronta para publicação.' : 'Revisão salva. O item ainda não será publicado.', candidate.verified ? 'success' : 'info');
  }

  function ignorePdfCandidate() {
    const imp = getPdfImport();
    const f = byId('pdfReviewForm');
    const candidate = imp?.candidates.find((x) => x.id === f.elements.candidateId.value);
    if (!candidate || candidate.published) return;
    candidate.ignored = true;
    candidate.verified = false;
    candidate.reviewed = true;
    M.closeModal('pdfReviewModal');
    renderPdfImport();
    M.toast('Candidato ignorado. Nada foi gravado como promoção.', 'info');
  }

  function isDuplicatePdfPromotion(candidate, imp) {
    return Object.values(state.promotions || {}).some((promo) =>
      promo && promo.sourceHash && promo.sourceHash === imp.result.hash
      && Number(promo.sourcePage || 0) === Number(candidate.pageNumber || 0)
      && Math.abs(Number(promo.price || 0) - Number(candidate.price || 0)) < .001
      && M.normalizeText(promo.productName || '') === M.normalizeText(candidate.productName || '')
      && promo.unitId === imp.unitId
    );
  }

  async function publishPdfCandidateSet(candidates, mode, silent = false) {
    const imp = getPdfImport();
    if (!imp || !candidates.length) return { created:0, duplicates:0 };
    const market = getMarket(imp.marketId);
    const unit = getUnit(imp.unitId);
    if (!market || !unit || unit.marketId !== imp.marketId) throw new Error('Mercado/unidade do encarte não estão mais válidos.');

    const updates = {};
    const created = [];
    let duplicates = 0;
    candidates.forEach((candidate) => {
      if (isDuplicatePdfPromotion(candidate, imp)) {
        candidate.published = true;
        candidate.duplicate = true;
        duplicates += 1;
        return;
      }
      const startAt = Number(candidate.startAt || M.toTimestampFromLocalInput(byId('pdfImportStartAt').value) || imp.result.validity?.startAt || 0);
      const endAt = Number(candidate.endAt || M.toTimestampFromLocalInput(byId('pdfImportEndAt').value) || imp.result.validity?.endAt || 0);
      if (!startAt || !endAt || endAt <= startAt || !Number.isFinite(Number(candidate.price)) || Number(candidate.price) <= 0 || candidate.priceKind === 'review') {
        throw new Error(`A oferta "${candidate.productName}" não passou nas travas obrigatórias de publicação.`);
      }
      const key = db.ref('promotions').push().key;
      const sourceReference = `PDF ${imp.result.fileName} · pág. ${candidate.pageNumber} · SHA256 ${(imp.result.hash || '').slice(0,16)}${imp.sourceUrl ? ' · fonte oficial informada' : ''}`.slice(0,250);
      updates[`promotions/${key}`] = {
        marketId: imp.marketId,
        unitId: imp.unitId,
        productName: candidate.productName.slice(0,160),
        category: candidate.category || M.inferCategory(candidate.productName) || 'outros',
        brand: (candidate.brand || '').slice(0,80),
        packageText: (candidate.packageText || '').slice(0,80),
        price: Number(candidate.price),
        previousPrice: Number(candidate.previousPrice) > Number(candidate.price) ? Number(candidate.previousPrice) : null,
        startAt,
        endAt,
        sourceType: 'encarte',
        sourceReference,
        sourceUrl: imp.sourceUrl || '',
        sourceFileName: imp.result.fileName,
        sourcePage: candidate.pageNumber,
        sourceHash: imp.result.hash || '',
        sourceBox: candidate.sourceBox || null,
        detectedProductName: candidate.detectedProductName || candidate.productName,
        importConfidence: Number(candidate.confidence || 0),
        priceKind: candidate.priceKind || 'general',
        requiresClub: candidate.requiresClub === true,
        clubName: candidate.requiresClub ? (candidate.clubName || '').slice(0,80) : '',
        conditions: (candidate.conditions || '').slice(0,250),
        aliases: '',
        verified: true,
        verificationMode: mode === 'automatic' ? 'automatic' : 'manual',
        automationEngineVersion: imp.result.engineVersion || '2.0.0',
        automationThreshold: Number(imp.threshold || .98),
        automationConfidence: Number(candidate.confidence || 0),
        automationEvidence: (candidate.evidence || []).slice(0,10),
        automationRiskFlags: (candidate.riskFlags || []).slice(0,10),
        verifiedAt: serverTimestamp,
        verifiedBy: state.user.uid,
        active: true,
        createdAt: serverTimestamp,
        createdBy: state.user.uid,
        updatedAt: serverTimestamp,
        updatedBy: state.user.uid
      };
      created.push({ candidate, key });
    });
    if (created.length) await db.ref().update(updates);
    created.forEach(({ candidate }) => {
      candidate.published = true;
      candidate.verified = true;
      candidate.verificationMode = mode === 'automatic' ? 'automatic' : 'manual';
    });
    if (created.length || duplicates) {
      await audit(mode === 'automatic' ? 'pdf_import_auto_published' : 'pdf_import_manual_published', 'pdf_import', (imp.result.hash || '').slice(0,20), {
        fileName: imp.result.fileName,
        created: created.length,
        duplicates,
        marketId: imp.marketId,
        unitId: imp.unitId,
        pages: imp.result.numPages,
        sourceUrl: imp.sourceUrl || '',
        threshold: imp.threshold || .98,
        engineVersion: imp.result.engineVersion || '2.0.0'
      });
    }
    renderPdfImport();
    if (!silent) M.toast(`${created.length} promoção${created.length === 1 ? '' : 'ões'} publicada${created.length === 1 ? '' : 's'}${duplicates ? ` · ${duplicates} duplicada${duplicates === 1 ? '' : 's'} ignorada${duplicates === 1 ? '' : 's'}` : ''}.`, 'success', 7000);
    return { created:created.length, duplicates };
  }

  async function publishAutomaticPdfCandidates(silent = false) {
    const imp = getPdfImport();
    if (!imp) return { created:0, duplicates:0 };
    refreshPdfClassifications();
    const candidates = imp.candidates.filter((x) => !x.published && !x.ignored && x.automationDecision === 'auto');
    if (!candidates.length) {
      if (!silent) M.toast('Nenhuma oferta atingiu o nível de segurança para publicação automática.', 'warning');
      return { created:0, duplicates:0 };
    }
    const btn = byId('pdfPublishAutoBtn');
    if (btn && !silent) M.setBusy(btn, true, 'Publicando seguros...');
    try {
      return await publishPdfCandidateSet(candidates, 'automatic', silent);
    } catch (error) {
      console.error(error);
      if (!silent) M.toast(error.message || 'Falha na publicação automática.', 'error', 8000);
      else throw error;
      return { created:0, duplicates:0 };
    } finally {
      if (btn && !silent) M.setBusy(btn, false);
      renderPdfImport();
    }
  }

  async function publishVerifiedPdfCandidates() {
    const imp = getPdfImport();
    if (!imp) return;
    const candidates = imp.candidates.filter((x) => x.verified && x.verificationMode === 'manual' && !x.published && !x.ignored);
    if (!candidates.length) { M.toast('Nenhuma exceção conferida aguardando publicação.', 'warning'); return; }
    const btn = byId('pdfPublishVerifiedBtn');
    M.setBusy(btn, true, 'Publicando revisados...');
    try {
      await publishPdfCandidateSet(candidates, 'manual', false);
    } catch (error) {
      console.error(error);
      M.toast(error.message || 'Falha ao publicar promoções revisadas.', 'error', 8000);
    } finally {
      M.setBusy(btn, false);
      renderPdfImport();
    }
  }

  function bindActions() {
    byId('logoutBtn').addEventListener('click', M.logout);
    byId('userForm').addEventListener('submit', createUser);
    byId('marketForm').addEventListener('submit', (e)=>saveMarket(e).catch((er)=>M.toast(er.message,'error')));
    byId('unitForm').addEventListener('submit', (e)=>saveUnit(e).catch((er)=>M.toast(er.message,'error')));
    byId('promotionForm').addEventListener('submit', (e)=>savePromotion(e).catch((er)=>M.toast(er.message,'error')));
    byId('inboxForm').addEventListener('submit', (e)=>saveInbox(e).catch((er)=>M.toast(er.message,'error')));
    byId('pdfImportForm').addEventListener('submit', analyzePdfImport);
    byId('pdfReviewForm').addEventListener('submit', savePdfReview);
    byId('pdfImportMarketId').addEventListener('change', refreshPdfImportUnitSelects);
    byId('pdfImportResetBtn').addEventListener('click', resetPdfImport);
    byId('pdfPublishVerifiedBtn').addEventListener('click', publishVerifiedPdfCandidates);
    byId('pdfPublishAutoBtn').addEventListener('click', () => publishAutomaticPdfCandidates(false));
    byId('pdfAutomationMode').addEventListener('change', () => { if (state.pdfImport) { state.pdfImport.threshold = automationThreshold(); refreshPdfClassifications(); renderPdfImport(); } });
    byId('pdfIgnoreCandidateBtn').addEventListener('click', ignorePdfCandidate);
    byId('pdfCandidateSearch').addEventListener('input', renderPdfImport);
    byId('pdfCandidateFilter').addEventListener('change', renderPdfImport);
    byId('promoMarketId').addEventListener('change', refreshUnitSelects);
    ['userSearch','marketSearch','unitSearch','promoSearch'].forEach((id)=>byId(id).addEventListener('input', ()=>({userSearch:renderUsers,marketSearch:renderMarkets,unitSearch:renderUnits,promoSearch:renderPromotions}[id])()));
    byId('promoFilter').addEventListener('change', renderPromotions);
    byId('useMyLocationUnit').addEventListener('click', async()=>{ try{ const p=await M.getCurrentPosition(); const f=byId('unitForm'); f.elements.lat.value=p.coords.latitude.toFixed(7); f.elements.lng.value=p.coords.longitude.toFixed(7); M.toast(`Localização capturada com precisão aproximada de ${Math.round(p.coords.accuracy)} m.`, 'success'); }catch(e){M.toast(e.message,'error');} });

    document.addEventListener('click', async (event) => {
      const t=event.target.closest('button,a'); if(!t)return;
      if(t.dataset.pdfReview) { await openPdfReview(t.dataset.pdfReview); return; }
      if(t.dataset.userToggle){
        const id=t.dataset.userToggle; const x=state.users[id];
        if(x){ const next=x.status==='active'?'blocked':'active'; await db.ref(`users/${id}`).update({status:next,updatedAt:serverTimestamp}); await audit('user_status_changed','user',id,{status:next}); M.toast(`Usuário ${next==='active'?'ativado':'bloqueado'}.`,'success'); }
      }
      if(t.dataset.marketEdit) populateMarketForm(t.dataset.marketEdit);
      if(t.dataset.unitEdit) populateUnitForm(t.dataset.unitEdit);
      if(t.dataset.promoEdit) populatePromotionForm(t.dataset.promoEdit);
      if(t.dataset.marketToggle){ const x=state.markets[t.dataset.marketToggle]; if(x) await toggle('markets',x.id,'active',x.active,'market_status_changed','market'); }
      if(t.dataset.unitToggle){ const x=state.units[t.dataset.unitToggle]; if(x) await toggle('market_units',x.id,'active',x.active,'unit_status_changed','market_unit'); }
      if(t.dataset.promoToggle){ const x=state.promotions[t.dataset.promoToggle]; if(x) await toggle('promotions',x.id,'active',x.active,'promotion_status_changed','promotion'); }
      if(t.dataset.inboxProcess){ await db.ref(`promotion_inbox/${t.dataset.inboxProcess}`).update({status:'processed',processedAt:serverTimestamp,processedBy:state.user.uid}); await audit('inbox_processed','promotion_inbox',t.dataset.inboxProcess); }
      if(t.dataset.inboxPromo){ const x=state.inbox[t.dataset.inboxPromo]; if(!x)return; resetPromotionForm(); const f=byId('promotionForm'); if(x.marketId){f.elements.marketId.value=x.marketId;refreshUnitSelects();} f.elements.sourceType.value=x.sourceType==='encarte'?'encarte':'whatsapp'; f.elements.sourceReference.value=`Inbox ${t.dataset.inboxPromo} · recebido em ${M.formatDateTime(x.createdAt)}`; f.elements.aliases.value=''; M.openModal('promotionModal'); }
    });
  }

  (async function init(){
    try {
      const {user,profile}=await M.requireRole(['superadmin','admin']); state.user=user; state.profile=profile;
      byId('adminRoleBadge').textContent=profile.role; byId('adminWelcome').textContent=`${profile.name || user.email} · ${user.email}`;
      if(profile.role!=='superadmin') byId('newUserRole').querySelector('option[value="admin"]')?.remove();
      bindNavigation(); bindActions(); listenData(); byId('loading').hidden=true;
    } catch(error){ console.error(error); }
  })();
})();

(function () {
  'use strict';

  const M = window.MercadorIA;
  const { db, auth, serverTimestamp, firebaseConfig } = M;
  const state = { users: {}, markets: {}, units: {}, promotions: {}, inbox: {}, audit: {}, profile: null, user: null };

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
      return `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(p.productName)}</div><div class="small muted">${M.escapeHtml(market?.name || 'Mercado')} · ${M.escapeHtml(unit?.name || 'Unidade')}</div><div class="entity-meta"><span class="badge ${valid ? 'ok':(p.active ? 'warn':'danger')}">${valid ? 'válida agora':(p.active ? 'fora da validade':'inativa')}</span><span class="badge ${p.verified ? 'ok':'warn'}">${p.verified ? 'valor conferido':'não conferida'}</span><span class="badge info">${M.formatCurrency(p.price)}</span>${saving > 0 ? `<span class="badge ok">economia ${M.formatCurrency(saving)}</span>`:''}<span class="badge">até ${M.formatDateTime(p.endAt)}</span></div><div class="small muted" style="margin-top:9px">Origem: ${M.escapeHtml(p.sourceType || '—')} · ${M.escapeHtml(p.sourceReference || 'sem referência')}</div></div><div class="entity-actions"><button class="btn btn-secondary btn-sm" data-promo-edit="${p.id}">Editar</button><button class="btn btn-sm ${p.active ? 'btn-danger':'btn-secondary'}" data-promo-toggle="${p.id}">${p.active ? 'Desativar':'Ativar'}</button></div></div></article>`;
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
    ['unitMarketId','promoMarketId'].forEach((id) => { const el = byId(id); if (!el) return; const current = el.value; el.innerHTML = `<option value="">Selecione...</option>${options}`; if ([...el.options].some((o) => o.value === current)) el.value = current; });
    const inbox = byId('inboxMarketId'); if (inbox) { const current = inbox.value; inbox.innerHTML = `<option value="">Não definido</option>${options}`; if ([...inbox.options].some((o) => o.value === current)) inbox.value = current; }
    refreshUnitSelects();
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
    const f = byId('promotionForm'); f.reset(); f.elements.id.value = ''; f.elements.active.checked = true; f.elements.verified.checked = false; byId('promotionModalTitle').textContent = 'Cadastrar promoção real';
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
    const value={ marketId:f.elements.marketId.value, unitId:f.elements.unitId.value, productName:f.elements.productName.value.trim(), category:M.slugify(f.elements.category.value).replaceAll('-','_') || M.inferCategory(f.elements.productName.value) || 'outros', brand:f.elements.brand.value.trim(), packageText:f.elements.packageText.value.trim(), price, previousPrice, startAt, endAt, sourceType:f.elements.sourceType.value, sourceReference:f.elements.sourceReference.value.trim(), aliases:f.elements.aliases.value.trim(), verified:true, verifiedAt:serverTimestamp, verifiedBy:state.user.uid, active:f.elements.active.checked, updatedAt:serverTimestamp, updatedBy:state.user.uid };
    if (!f.elements.id.value) { value.createdAt=serverTimestamp; value.createdBy=state.user.uid; }
    await db.ref(`promotions/${id}`).update(value); await audit(f.elements.id.value ? 'promotion_updated':'promotion_created','promotion',id,{product:value.productName,price:value.price,marketId:value.marketId}); M.closeModal('promotionModal'); M.toast('Promoção real salva e conferida.', 'success');
  }

  async function saveInbox(event) {
    event.preventDefault(); const f=event.currentTarget; const ref=db.ref('promotion_inbox').push(); const value={ marketId:f.elements.marketId.value || null, sourceType:f.elements.sourceType.value, rawText:f.elements.rawText.value.trim(), status:'pending', createdAt:serverTimestamp, createdBy:state.user.uid };
    await ref.set(value); await audit('inbox_received','promotion_inbox',ref.key,{marketId:value.marketId,sourceType:value.sourceType}); M.closeModal('inboxModal'); f.reset(); M.toast('Recebimento registrado para revisão.', 'success');
  }

  function populateMarketForm(id) { const x=state.markets[id]; if(!x)return; resetMarketForm(); const f=byId('marketForm'); Object.entries(x).forEach(([k,v])=>{ if(f.elements[k] && k!=='active') f.elements[k].value=v ?? ''; }); f.elements.id.value=id; f.elements.active.checked=x.active===true; byId('marketModalTitle').textContent='Editar mercado'; M.openModal('marketModal'); }
  function populateUnitForm(id) { const x=state.units[id]; if(!x)return; resetUnitForm(); const f=byId('unitForm'); ['marketId','name','address','city','state','lat','lng'].forEach((k)=>{ if(f.elements[k])f.elements[k].value=x[k] ?? '';}); f.elements.id.value=id; f.elements.active.checked=x.active===true; byId('unitModalTitle').textContent='Editar unidade'; M.openModal('unitModal'); }
  function populatePromotionForm(id) { const x=state.promotions[id]; if(!x)return; resetPromotionForm(); const f=byId('promotionForm'); ['marketId','productName','category','brand','packageText','price','previousPrice','sourceType','sourceReference','aliases'].forEach((k)=>{ if(f.elements[k])f.elements[k].value=x[k] ?? '';}); refreshUnitSelects(); f.elements.unitId.value=x.unitId || ''; f.elements.startAt.value=M.toLocalDateTimeInput(x.startAt); f.elements.endAt.value=M.toLocalDateTimeInput(x.endAt); f.elements.id.value=id; f.elements.active.checked=x.active===true; f.elements.verified.checked=x.verified===true; byId('promotionModalTitle').textContent='Editar promoção'; M.openModal('promotionModal'); }

  async function toggle(path,id,field,current,action,type) { await db.ref(`${path}/${id}/${field}`).set(!current); await db.ref(`${path}/${id}/updatedAt`).set(serverTimestamp); await audit(action,type,id,{[field]:!current}); M.toast('Status atualizado.', 'success'); }

  function bindActions() {
    byId('logoutBtn').addEventListener('click', M.logout);
    byId('userForm').addEventListener('submit', createUser);
    byId('marketForm').addEventListener('submit', (e)=>saveMarket(e).catch((er)=>M.toast(er.message,'error')));
    byId('unitForm').addEventListener('submit', (e)=>saveUnit(e).catch((er)=>M.toast(er.message,'error')));
    byId('promotionForm').addEventListener('submit', (e)=>savePromotion(e).catch((er)=>M.toast(er.message,'error')));
    byId('inboxForm').addEventListener('submit', (e)=>saveInbox(e).catch((er)=>M.toast(er.message,'error')));
    byId('promoMarketId').addEventListener('change', refreshUnitSelects);
    ['userSearch','marketSearch','unitSearch','promoSearch'].forEach((id)=>byId(id).addEventListener('input', ()=>({userSearch:renderUsers,marketSearch:renderMarkets,unitSearch:renderUnits,promoSearch:renderPromotions}[id])()));
    byId('promoFilter').addEventListener('change', renderPromotions);
    byId('useMyLocationUnit').addEventListener('click', async()=>{ try{ const p=await M.getCurrentPosition(); const f=byId('unitForm'); f.elements.lat.value=p.coords.latitude.toFixed(7); f.elements.lng.value=p.coords.longitude.toFixed(7); M.toast(`Localização capturada com precisão aproximada de ${Math.round(p.coords.accuracy)} m.`, 'success'); }catch(e){M.toast(e.message,'error');} });

    document.addEventListener('click', async (event) => {
      const t=event.target.closest('button,a'); if(!t)return;
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

// ── DATA STORE ──────────────────────────────────────────────────────────────
const DATA = { characters: [], locations: [], events: [], factions: [], relations: [] };

async function loadData() {
  const files = ['characters', 'locations', 'events', 'factions', 'relations'];
  await Promise.all(files.map(async f => {
    const r = await fetch(`data/${f}.json`);
    DATA[f] = await r.json();
  }));
}

// ── STATE ────────────────────────────────────────────────────────────────────
const STATE = {
  activeTab: 'painel',
  secretsVisible: localStorage.getItem('secretsVisible') !== 'false',
  modal: { stack: [], current: null },
  graphFilters: { character: true, location: true, event: true, faction: true },
  graphShowLabels: true,
  charFilters: { name: '', faction: '', status: '', secretsOnly: false },
};

// ── HELPERS ──────────────────────────────────────────────────────────────────
function getFactionById(id) { return DATA.factions.find(f => f.id === id); }
function getCharById(id)    { return DATA.characters.find(c => c.id === id); }
function getLocationById(id){ return DATA.locations.find(l => l.id === id); }
function getEventById(id)   { return DATA.events.find(e => e.id === id); }

function factionColor(factionId) {
  const f = getFactionById(factionId);
  return f ? f.color : '#3a5a7a';
}

function hasSecrets(item) {
  return item && item.secrets && item.secrets.trim().length > 0;
}

function statusBadgeHtml(status) {
  if (!status) return '';
  const cls = { 'Vivo': 'badge-vivo', 'Morto': 'badge-morto', 'Desaparecido': 'badge-desaparecido' }[status] || 'badge-vivo';
  return `<span class="badge ${cls}">${status}</span>`;
}

function factionBadgeHtml(factionId) {
  const f = getFactionById(factionId);
  if (!f) return '';
  return `<span class="faction-badge" style="background:${f.color}22;color:${f.color};border:1px solid ${f.color}44;border-radius:10px;padding:2px 7px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;">${f.name}</span>`;
}

function scaleBadgeHtml(scale) {
  if (!scale) return '';
  const cls = { 'Mundial': 'scale-mundial', 'Regional': 'scale-regional', 'Local': 'scale-local', 'Pessoal': 'scale-pessoal' }[scale] || 'scale-local';
  return `<span class="scale-badge ${cls}">${scale}</span>`;
}

function relTypeColor(type) {
  return { family: '#ffffff', political: '#c8a96a', romantic: '#c07090', secret: '#c03030', historical: '#7a8a9a' }[type] || '#5a7a9a';
}

function avatarHtml(char, size = 64, classes = '') {
  const imgPath = char.image ? `assets/images/characters/${char.image}` : null;
  const initial = char.name ? char.name.charAt(0).toUpperCase() : '?';
  if (imgPath) {
    return `<div class="char-avatar${classes ? ' ' + classes : ''}" style="width:${size}px;height:${size}px;border-radius:8px;overflow:hidden;border:2px solid var(--border-accent);">
      <img src="${imgPath}" alt="${char.name}" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<div class=\\'char-avatar-placeholder\\'>${initial}</div>'">
    </div>`;
  }
  return `<div class="char-avatar${classes ? ' ' + classes : ''}" style="width:${size}px;height:${size}px;border-radius:8px;overflow:hidden;border:2px solid var(--border-accent);">
    <div class="char-avatar-placeholder">${initial}</div>
  </div>`;
}

function charPortraitHtml(c) {
  const initial = c.name ? c.name.charAt(0).toUpperCase() : '?';
  const imgPath = c.image ? `assets/images/characters/${c.image}` : null;
  const imageEl = imgPath
    ? `<img class="char-portrait-img" src="${imgPath}" alt="${c.name}"
         onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <div class="char-portrait-initial" style="display:none">${initial}</div>`
    : `<div class="char-portrait-initial">${initial}</div>`;
  return `<div class="char-portrait">
    ${imageEl}
    <div class="char-portrait-overlay">
      ${statusBadgeHtml(c.status)}
      ${hasSecrets(c) ? '<span class="portrait-secret secret-icon">🔒</span>' : ''}
    </div>
  </div>`;
}

// ── NAVIGATION ───────────────────────────────────────────────────────────────
function switchTab(tab) {
  STATE.activeTab = tab;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'relacoes') renderGraph();
}

// ── SECRETS TOGGLE ───────────────────────────────────────────────────────────
function applySecretsState() {
  const btn = document.getElementById('secrets-float-btn');
  if (STATE.secretsVisible) {
    document.body.classList.add('secrets-visible');
    btn.classList.add('active');
    btn.innerHTML = '🔓 Segredos';
  } else {
    document.body.classList.remove('secrets-visible');
    btn.classList.remove('active');
    btn.innerHTML = '🔒 Segredos';
  }
}

function toggleSecrets() {
  STATE.secretsVisible = !STATE.secretsVisible;
  localStorage.setItem('secretsVisible', STATE.secretsVisible);
  applySecretsState();
}

// ── PAINEL ───────────────────────────────────────────────────────────────────
function renderPainel() {
  const secretsCount = [...DATA.characters, ...DATA.locations, ...DATA.events, ...DATA.factions]
    .filter(hasSecrets).length;

  document.getElementById('count-chars').textContent    = DATA.characters.length;
  document.getElementById('count-locations').textContent = DATA.locations.length;
  document.getElementById('count-events').textContent   = DATA.events.length;
  document.getElementById('count-factions').textContent  = DATA.factions.length;
  document.getElementById('secrets-total').textContent   = secretsCount;

  const relList = document.getElementById('recent-relations');
  const recent = DATA.relations.slice(-5).reverse();
  relList.innerHTML = recent.map(r => {
    const sName = getEntityName(r.sourceId, r.sourceType);
    const tName = getEntityName(r.targetId, r.targetType);
    return `<div class="recent-relation" data-id="${r.sourceId}" data-type="${r.sourceType}">
      <span class="rel-source">${sName}</span>
      <span class="rel-label">${r.label}</span>
      <span class="rel-target">${tName}</span>
    </div>`;
  }).join('') || '<p style="color:var(--text-muted);font-size:13px;">Nenhuma relação cadastrada.</p>';

  relList.querySelectorAll('.recent-relation').forEach(el => {
    el.addEventListener('click', () => openModal(el.dataset.id, el.dataset.type));
  });
}

function getEntityName(id, type) {
  const map = { character: getCharById, location: getLocationById, event: getEventById, faction: getFactionById };
  const item = map[type]?.(id);
  return item ? item.name : id;
}

// ── CHARACTERS ───────────────────────────────────────────────────────────────
function renderCharacters() {
  const { name, faction, status, secretsOnly } = STATE.charFilters;
  let chars = DATA.characters.filter(c => {
    if (name && !c.name.toLowerCase().includes(name.toLowerCase())) return false;
    if (faction && c.faction !== faction) return false;
    if (status && c.status !== status) return false;
    if (secretsOnly && !hasSecrets(c)) return false;
    return true;
  });

  const grid = document.getElementById('characters-grid');
  if (!chars.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">⚓</div><p>Nenhum personagem encontrado.</p></div>`;
    return;
  }

  grid.innerHTML = chars.map(c => {
    const fc = factionColor(c.faction);
    return `<div class="character-card" data-id="${c.id}" style="--faction-color:${fc}">
      ${charPortraitHtml(c)}
      <div class="char-info">
        <div class="char-faction-strip" style="background:${fc}"></div>
        <div class="char-name">${c.name}</div>
        <div class="char-role">${c.role || ''}</div>
        <div class="badges">${factionBadgeHtml(c.faction)}</div>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.character-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, 'character'));
  });
}

function buildCharacterFilters() {
  const factionSelect = document.getElementById('char-filter-faction');
  factionSelect.innerHTML = '<option value="">Todas as facções</option>' +
    DATA.factions.map(f => `<option value="${f.id}">${f.name}</option>`).join('');

  document.getElementById('char-filter-name').addEventListener('input', e => {
    STATE.charFilters.name = e.target.value;
    renderCharacters();
  });
  factionSelect.addEventListener('change', e => {
    STATE.charFilters.faction = e.target.value;
    renderCharacters();
  });
  document.getElementById('char-filter-status').addEventListener('change', e => {
    STATE.charFilters.status = e.target.value;
    renderCharacters();
  });
  const secretsToggle = document.getElementById('char-filter-secrets');
  secretsToggle.addEventListener('click', () => {
    STATE.charFilters.secretsOnly = !STATE.charFilters.secretsOnly;
    secretsToggle.classList.toggle('active', STATE.charFilters.secretsOnly);
    renderCharacters();
  });
}

// ── LOCATIONS ────────────────────────────────────────────────────────────────
function renderLocations() {
  const grid = document.getElementById('locations-grid');
  grid.innerHTML = DATA.locations.map(l => {
    const controller = getCharById(l.controlledBy);
    const controlText = controller
      ? controller.name
      : (getFactionById(l.controlledBy)?.name || l.controlledBy);

    if (l.featured) {
      const descWords = (l.description || '').split('\n');
      const firstPara = descWords[0] || '';
      const secondPara = descWords.slice(2).join('\n') || '';
      return `<div class="location-card location-featured" data-id="${l.id}">
        <div class="location-featured-inner">
          <div>
            <div class="location-name">${l.name}</div>
            <div class="location-subtitle">${l.subtitle || ''}</div>
            <span class="location-type-badge">${l.type || ''}</span>
            <div class="location-tone" style="margin-top:10px;">${l.tone || ''}</div>
            ${hasSecrets(l) ? '<div style="margin-top:10px;"><span class="secret-icon" title="Tem segredos">🔒</span></div>' : ''}
          </div>
          <p class="location-featured-desc">${firstPara}</p>
        </div>
      </div>`;
    }

    return `<div class="location-card" data-id="${l.id}">
      <div class="location-name">${l.name}</div>
      <div class="location-subtitle">${l.subtitle || ''}</div>
      <span class="location-type-badge">${l.type || ''}</span>
      <div class="location-tone">${l.tone || ''}</div>
      ${controlText ? `<div class="location-control">Controlado por: ${controlText}</div>` : ''}
      ${hasSecrets(l) ? '<span class="secret-icon" title="Tem segredos">🔒</span>' : ''}
    </div>`;
  }).join('');

  grid.querySelectorAll('.location-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, 'location'));
  });
}

// ── EVENTS ───────────────────────────────────────────────────────────────────
function renderEvents() {
  const sorted = [...DATA.events].sort((a, b) => (a.order || 0) - (b.order || 0));
  const timeline = document.getElementById('events-timeline');
  timeline.innerHTML = sorted.map(e => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="event-card" data-id="${e.id}">
        <div class="event-period">${e.period || ''}</div>
        <div class="event-name">${e.name}</div>
        ${scaleBadgeHtml(e.scale)}
        ${hasSecrets(e) ? '<span class="secret-icon" title="Tem segredos">🔒</span>' : ''}
        <div class="event-desc">${e.description || ''}</div>
      </div>
    </div>
  `).join('');

  timeline.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, 'event'));
  });
}

// ── FACTIONS ─────────────────────────────────────────────────────────────────
function renderFactions() {
  const grid = document.getElementById('factions-grid');
  grid.innerHTML = DATA.factions.map(f => {
    const memberTags = (f.members || []).map(mid => {
      const c = getCharById(mid);
      return c ? `<span class="tag-chip" data-id="${mid}" data-type="character">${c.name}</span>` : '';
    }).join('');
    return `<div class="faction-card" data-id="${f.id}">
      <div class="faction-card-accent" style="background:linear-gradient(to right,${f.color},${f.color}66,transparent)"></div>
      <div class="faction-card-body">
        <div class="faction-header">
          <div class="faction-symbol-wrap" style="background:${f.color}18;border:1px solid ${f.color}33;">
            <span>${f.symbol || '◆'}</span>
          </div>
          <div style="flex:1">
            <div class="faction-name" style="color:${f.color};">${f.name}</div>
            <div class="faction-type">${f.type || ''}</div>
          </div>
          ${hasSecrets(f) ? '<span class="secret-icon" title="Tem segredos">🔒</span>' : ''}
        </div>
        <div class="faction-desc">${f.description || ''}</div>
        ${memberTags ? `<div class="faction-label">Membros notáveis</div><div class="tags-list">${memberTags}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.faction-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, 'faction'));
  });
  grid.querySelectorAll('.tag-chip').forEach(tag => {
    tag.addEventListener('click', e => {
      e.stopPropagation();
      openModal(tag.dataset.id, tag.dataset.type);
    });
  });
}

// ── MODAL ────────────────────────────────────────────────────────────────────
function openModal(id, type, pushToStack = true) {
  const overlay = document.getElementById('modal-overlay');
  const panel   = document.getElementById('modal-panel');

  if (pushToStack) {
    if (STATE.modal.current) STATE.modal.stack.push(STATE.modal.current);
    STATE.modal.current = { id, type };
  }

  const content = buildModalContent(id, type);
  if (!content) return;

  document.getElementById('modal-body').innerHTML = content;
  overlay.classList.add('open');
  panel.classList.add('open');

  updateBreadcrumb();
  attachModalEvents();
  applySecretsToModal();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal-panel').classList.remove('open');
  STATE.modal.stack = [];
  STATE.modal.current = null;
}

function modalBack() {
  if (!STATE.modal.stack.length) return;
  const prev = STATE.modal.stack.pop();
  STATE.modal.current = prev;
  openModal(prev.id, prev.type, false);
}

function updateBreadcrumb() {
  const bc = document.getElementById('modal-breadcrumb');
  const backBtn = document.getElementById('modal-back-btn');
  const trail = [...STATE.modal.stack, STATE.modal.current];

  bc.innerHTML = trail.map((item, i) => {
    const name = item ? getEntityName(item.id, item.type) : '';
    const isCurrent = i === trail.length - 1;
    return `<span class="bc-item${isCurrent ? ' current' : ''}" data-idx="${i}">${name}</span>` +
      (isCurrent ? '' : '<span class="bc-sep">›</span>');
  }).join('');

  backBtn.disabled = STATE.modal.stack.length === 0;

  bc.querySelectorAll('.bc-item:not(.current)').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      const target = [...STATE.modal.stack, STATE.modal.current][idx];
      STATE.modal.stack = STATE.modal.stack.slice(0, idx);
      STATE.modal.current = target;
      openModal(target.id, target.type, false);
    });
  });
}

function applySecretsToModal() {
  // handled by CSS class on body
}

function attachModalEvents() {
  document.getElementById('modal-body').querySelectorAll('[data-modal-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openModal(el.dataset.modalId, el.dataset.modalType);
    });
  });
}

function buildModalContent(id, type) {
  const builders = {
    character: buildCharModalContent,
    location:  buildLocationModalContent,
    event:     buildEventModalContent,
    faction:   buildFactionModalContent,
  };
  return builders[type]?.(id) || '';
}

// Character modal
function buildCharModalContent(id) {
  const c = getCharById(id);
  if (!c) return '';

  const rels = DATA.relations.filter(r =>
    (r.sourceId === id && r.sourceType === 'character') ||
    (r.targetId === id && r.targetType === 'character')
  );

  const relItems = rels.map(r => {
    const isSource = r.sourceId === id;
    const otherId   = isSource ? r.targetId   : r.sourceId;
    const otherType = isSource ? r.targetType  : r.sourceType;
    const label     = r.label;
    const otherName = getEntityName(otherId, otherType);
    const color = relTypeColor(r.type);
    return `<div class="modal-relation-tag" data-modal-id="${otherId}" data-modal-type="${otherType}">
      <div class="rel-type-indicator" style="background:${color}"></div>
      <span class="rel-target-name">${otherName}</span>
      <span class="rel-label-text">${label}</span>
      ${r.secret ? '<span title="Relação secreta" style="opacity:.6;">🔒</span>' : ''}
    </div>`;
  }).join('');

  const eventItems = (c.events || []).map(eid => {
    const ev = getEventById(eid);
    return ev ? `<div class="modal-link-item" data-modal-id="${eid}" data-modal-type="event">${ev.name}<span class="link-label-text">${ev.period || ''}</span></div>` : '';
  }).join('');

  const locItems = (c.locations || []).map(lid => {
    const loc = getLocationById(lid);
    return loc ? `<div class="modal-link-item" data-modal-id="${lid}" data-modal-type="location">${loc.name}<span class="link-label-text">${loc.subtitle || ''}</span></div>` : '';
  }).join('');

  const imgHtml = c.image
    ? `<div class="modal-char-avatar"><img src="assets/images/characters/${c.image}" alt="${c.name}" onerror="this.parentElement.innerHTML='<div class=\\'modal-char-avatar-placeholder\\'>${c.name.charAt(0)}</div>'"></div>`
    : `<div class="modal-char-avatar"><div class="modal-char-avatar-placeholder">${c.name.charAt(0)}</div></div>`;

  return `
    <div class="modal-char-hero">
      ${imgHtml}
      <div class="modal-char-info">
        <div class="modal-char-name">${c.name}</div>
        <div class="modal-char-role">${c.role || ''}</div>
        <div class="badges">${statusBadgeHtml(c.status)} ${factionBadgeHtml(c.faction)}</div>
      </div>
    </div>
    ${c.description ? `<div class="modal-section">
      <div class="modal-section-title">Descrição Pública</div>
      <div class="modal-section-text">${c.description}</div>
    </div>` : ''}
    ${c.personality ? `<div class="modal-section">
      <div class="modal-section-title">Personalidade</div>
      <div class="modal-section-text">${c.personality}</div>
    </div>` : ''}
    ${hasSecrets(c) ? `<div class="modal-section secrets-section">
      <div class="modal-secrets">
        <div class="modal-section-title">🔒 Segredos do Mestre</div>
        <div class="modal-section-text">${c.secrets}</div>
      </div>
    </div>` : ''}
    ${relItems ? `<div class="modal-section">
      <div class="modal-section-title">Relações</div>
      <div class="modal-relations-list">${relItems}</div>
    </div>` : ''}
    ${locItems ? `<div class="modal-section">
      <div class="modal-section-title">Locais Associados</div>
      <div class="modal-link-list">${locItems}</div>
    </div>` : ''}
    ${eventItems ? `<div class="modal-section">
      <div class="modal-section-title">Aparece nos Eventos</div>
      <div class="modal-link-list">${eventItems}</div>
    </div>` : ''}
  `;
}

// Location modal
function buildLocationModalContent(id) {
  const l = getLocationById(id);
  if (!l) return '';

  const controller = getCharById(l.controlledBy);
  const controlText = controller ? controller.name : (getFactionById(l.controlledBy)?.name || l.controlledBy || '—');
  const controlId   = controller ? l.controlledBy : null;
  const controlType = controller ? 'character' : (getFactionById(l.controlledBy) ? 'faction' : null);

  const poiHtml = (l.pointsOfInterest || []).map(p => `<li class="poi-item">${p}</li>`).join('');

  const charItems = (l.characters || []).map(cid => {
    const c = getCharById(cid);
    return c ? `<div class="modal-link-item" data-modal-id="${cid}" data-modal-type="character">${c.name}<span class="link-label-text">${c.role || ''}</span></div>` : '';
  }).join('');

  const eventItems = (l.events || []).map(eid => {
    const ev = getEventById(eid);
    return ev ? `<div class="modal-link-item" data-modal-id="${eid}" data-modal-type="event">${ev.name}</div>` : '';
  }).join('');

  return `
    <div class="modal-location-hero">
      <div class="modal-location-name">${l.name}</div>
      <div class="modal-location-subtitle">${l.subtitle || ''}</div>
      <div class="badges">
        <span class="location-type-badge">${l.type || ''}</span>
        ${factionBadgeHtml(l.faction)}
      </div>
      <div style="margin-top:8px;font-size:13px;color:var(--text-secondary);font-style:italic;">${l.tone || ''}</div>
      ${controlText ? `<div style="margin-top:6px;font-size:12px;color:var(--text-muted);">Controlado por: ${controlId && controlType ? `<span class="tag-chip" data-modal-id="${controlId}" data-modal-type="${controlType}" style="cursor:pointer;">${controlText}</span>` : controlText}</div>` : ''}
    </div>
    ${l.description ? `<div class="modal-section">
      <div class="modal-section-title">Descrição</div>
      <div class="modal-section-text">${l.description}</div>
    </div>` : ''}
    ${poiHtml ? `<div class="modal-section">
      <div class="modal-section-title">Pontos de Interesse</div>
      <ul class="poi-list">${poiHtml}</ul>
    </div>` : ''}
    ${hasSecrets(l) ? `<div class="modal-section secrets-section">
      <div class="modal-secrets">
        <div class="modal-section-title">🔒 Segredos do Mestre</div>
        <div class="modal-section-text">${l.secrets}</div>
      </div>
    </div>` : ''}
    ${charItems ? `<div class="modal-section">
      <div class="modal-section-title">Personagens Associados</div>
      <div class="modal-link-list">${charItems}</div>
    </div>` : ''}
    ${eventItems ? `<div class="modal-section">
      <div class="modal-section-title">Eventos que Ocorreram Aqui</div>
      <div class="modal-link-list">${eventItems}</div>
    </div>` : ''}
  `;
}

// Event modal
function buildEventModalContent(id) {
  const e = getEventById(id);
  if (!e) return '';

  const loc = e.location ? getLocationById(e.location) : null;

  const charItems = (e.characters || []).map(cid => {
    const c = getCharById(cid);
    return c ? `<div class="modal-link-item" data-modal-id="${cid}" data-modal-type="character">${c.name}</div>` : '';
  }).join('');

  const relEventItems = (e.relatedEvents || []).map(eid => {
    const ev = getEventById(eid);
    return ev ? `<div class="modal-link-item" data-modal-id="${eid}" data-modal-type="event">${ev.name}</div>` : '';
  }).join('');

  return `
    <div class="modal-location-hero">
      <div class="event-period" style="margin-bottom:4px;">${e.period || ''}</div>
      <div class="modal-location-name">${e.name}</div>
      <div style="margin-top:8px;">${scaleBadgeHtml(e.scale)}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Descrição Completa</div>
      <div class="modal-section-text">${e.description || ''}</div>
    </div>
    ${hasSecrets(e) ? `<div class="modal-section secrets-section">
      <div class="modal-secrets">
        <div class="modal-section-title">🔒 Segredos do Mestre</div>
        <div class="modal-section-text">${e.secrets}</div>
      </div>
    </div>` : ''}
    ${charItems ? `<div class="modal-section">
      <div class="modal-section-title">Personagens Presentes</div>
      <div class="modal-link-list">${charItems}</div>
    </div>` : ''}
    ${loc ? `<div class="modal-section">
      <div class="modal-section-title">Local do Evento</div>
      <div class="modal-link-list"><div class="modal-link-item" data-modal-id="${loc.id}" data-modal-type="location">${loc.name}</div></div>
    </div>` : ''}
    ${relEventItems ? `<div class="modal-section">
      <div class="modal-section-title">Eventos Relacionados</div>
      <div class="modal-link-list">${relEventItems}</div>
    </div>` : ''}
  `;
}

// Faction modal
function buildFactionModalContent(id) {
  const f = getFactionById(id);
  if (!f) return '';

  const memberItems = (f.members || []).map(mid => {
    const c = getCharById(mid);
    return c ? `<div class="modal-link-item" data-modal-id="${mid}" data-modal-type="character">${c.name}<span class="link-label-text">${c.role || ''}</span></div>` : '';
  }).join('');

  const locItems = (f.locations || []).map(lid => {
    const l = getLocationById(lid);
    return l ? `<div class="modal-link-item" data-modal-id="${lid}" data-modal-type="location">${l.name}</div>` : '';
  }).join('');

  const rels = DATA.relations.filter(r =>
    (r.sourceId === id && r.sourceType === 'faction') ||
    (r.targetId === id && r.targetType === 'faction')
  );

  const relItems = rels.map(r => {
    const isSource = r.sourceId === id;
    const otherId   = isSource ? r.targetId   : r.sourceId;
    const otherType = isSource ? r.targetType  : r.sourceType;
    const otherName = getEntityName(otherId, otherType);
    const color = relTypeColor(r.type);
    return `<div class="modal-relation-tag" data-modal-id="${otherId}" data-modal-type="${otherType}">
      <div class="rel-type-indicator" style="background:${color}"></div>
      <span class="rel-target-name">${otherName}</span>
      <span class="rel-label-text">${r.label}</span>
      ${r.secret ? '<span title="Relação secreta" style="opacity:.6;">🔒</span>' : ''}
    </div>`;
  }).join('');

  return `
    <div class="modal-location-hero" style="border-left:3px solid ${f.color};">
      <div style="display:flex;gap:12px;align-items:center;">
        <span style="font-size:36px;">${f.symbol || '◆'}</span>
        <div>
          <div class="modal-location-name" style="color:${f.color};">${f.name}</div>
          <div class="faction-type">${f.type || ''}</div>
        </div>
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Descrição</div>
      <div class="modal-section-text">${f.description || ''}</div>
    </div>
    ${hasSecrets(f) ? `<div class="modal-section secrets-section">
      <div class="modal-secrets">
        <div class="modal-section-title">🔒 Segredos do Mestre</div>
        <div class="modal-section-text">${f.secrets}</div>
      </div>
    </div>` : ''}
    ${memberItems ? `<div class="modal-section">
      <div class="modal-section-title">Membros</div>
      <div class="modal-link-list">${memberItems}</div>
    </div>` : ''}
    ${locItems ? `<div class="modal-section">
      <div class="modal-section-title">Locais Controlados</div>
      <div class="modal-link-list">${locItems}</div>
    </div>` : ''}
    ${relItems ? `<div class="modal-section">
      <div class="modal-section-title">Relações</div>
      <div class="modal-relations-list">${relItems}</div>
    </div>` : ''}
  `;
}

// ── GLOBAL SEARCH ─────────────────────────────────────────────────────────────
function buildSearchIndex() {
  const idx = [];
  DATA.characters.forEach(c => idx.push({ id: c.id, type: 'character', name: c.name, sub: c.role }));
  DATA.locations.forEach(l => idx.push({ id: l.id, type: 'location', name: l.name, sub: l.subtitle }));
  DATA.events.forEach(e => idx.push({ id: e.id, type: 'event', name: e.name, sub: e.period }));
  DATA.factions.forEach(f => idx.push({ id: f.id, type: 'faction', name: f.name, sub: f.type }));
  return idx;
}

function setupSearch(index) {
  const overlay = document.getElementById('global-search-overlay');
  const input   = document.getElementById('global-search-input');
  const results = document.getElementById('global-search-results');

  document.getElementById('search-toggle').addEventListener('click', () => {
    overlay.classList.add('open');
    setTimeout(() => input.focus(), 50);
  });

  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') overlay.classList.remove('open');
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      overlay.classList.toggle('open');
      if (overlay.classList.contains('open')) setTimeout(() => input.focus(), 50);
    }
  });

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    if (!q) { results.innerHTML = ''; return; }
    const hits = index.filter(i => i.name.toLowerCase().includes(q)).slice(0, 12);
    if (!hits.length) {
      results.innerHTML = '<div class="search-no-results">Nenhum resultado encontrado.</div>';
      return;
    }
    results.innerHTML = hits.map(h => `
      <div class="search-result-item" data-id="${h.id}" data-type="${h.type}">
        <span class="search-result-type type-${h.type}">${{character:'Personagem',location:'Local',event:'Evento',faction:'Facção'}[h.type]}</span>
        <span class="search-result-name">${h.name}</span>
        <span class="search-result-sub">${h.sub || ''}</span>
      </div>
    `).join('');
    results.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', () => {
        overlay.classList.remove('open');
        input.value = '';
        results.innerHTML = '';
        const tabMap = { character: 'personagens', location: 'locais', event: 'eventos', faction: 'faccoes' };
        switchTab(tabMap[el.dataset.type]);
        setTimeout(() => openModal(el.dataset.id, el.dataset.type), 100);
      });
    });
  });
}

// ── GRAPH ─────────────────────────────────────────────────────────────────────
let graphSimulation = null;

function renderGraph() {
  const wrapper = document.getElementById('graph-wrapper');
  const svg = document.getElementById('graph-svg');

  // Clear previous
  svg.innerHTML = '';
  if (graphSimulation) graphSimulation.stop();

  const W = wrapper.clientWidth;
  const H = wrapper.clientHeight;

  const svgEl = d3.select('#graph-svg')
    .attr('viewBox', `0 0 ${W} ${H}`);

  // Defs for arrowheads
  const defs = svgEl.append('defs');
  ['normal','secret','romantic','political','family','historical'].forEach(type => {
    defs.append('marker')
      .attr('id', `arrow-${type}`)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 18)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', relTypeColor(type));
  });

  const g = svgEl.append('g');

  // Zoom + pan
  const zoom = d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => g.attr('transform', e.transform));
  svgEl.call(zoom);

  // Build nodes from all entity types
  const { character, location, event, faction } = STATE.graphFilters;
  const nodes = [];
  const nodeMap = {};

  const addNode = (id, type, name, degree = 0) => {
    if (!nodeMap[id]) {
      nodeMap[id] = { id, type, name, degree };
      nodes.push(nodeMap[id]);
    }
  };

  if (character) DATA.characters.forEach(c => addNode(c.id, 'character', c.name));
  if (location)  DATA.locations.forEach(l => addNode(l.id, 'location', l.name));
  if (event)     DATA.events.forEach(e => addNode(e.id, 'event', e.name));
  if (faction)   DATA.factions.forEach(f => addNode(f.id, 'faction', f.name));

  // Build edges only between visible nodes
  const links = DATA.relations.filter(r => nodeMap[r.sourceId] && nodeMap[r.targetId]).map(r => ({
    source: r.sourceId,
    target: r.targetId,
    label: r.label,
    type: r.type || 'historical',
    secret: r.secret || false,
  }));

  // Degree count
  links.forEach(l => {
    if (nodeMap[l.source]) nodeMap[l.source].degree++;
    if (nodeMap[l.target]) nodeMap[l.target].degree++;
  });

  // Node colors by type — factions use their own color from JSON
  const NODE_COLOR_BASE = { character: '#c8a96a', location: '#5a8ab0', event: '#7a9a6a', faction: '#9a5a5a' };
  const getNodeColor = d => {
    if (d.type === 'faction') {
      const f = getFactionById(d.id);
      return f ? f.color : NODE_COLOR_BASE.faction;
    }
    return NODE_COLOR_BASE[d.type] || '#9a5a5a';
  };

  // Simulation
  graphSimulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(110))
    .force('charge', d3.forceManyBody().strength(-280))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide().radius(30));

  // Links
  const linkG = g.append('g').attr('class', 'links');
  const linkEl = linkG.selectAll('.graph-link')
    .data(links).enter()
    .append('line')
    .attr('class', 'graph-link')
    .attr('stroke', d => relTypeColor(d.type))
    .attr('stroke-dasharray', d => d.secret ? '5,4' : null)
    .attr('stroke-opacity', 0.6)
    .attr('marker-end', d => `url(#arrow-${d.type})`);

  // Link labels
  const linkLabelEl = g.append('g').attr('class', 'link-labels')
    .selectAll('.graph-link-label')
    .data(links).enter()
    .append('text')
    .attr('class', 'graph-link-label')
    .attr('text-anchor', 'middle')
    .attr('dy', -4)
    .text(d => STATE.graphShowLabels ? d.label : '');

  // Nodes
  const nodeG = g.append('g').attr('class', 'nodes');
  const nodeEl = nodeG.selectAll('.graph-node')
    .data(nodes).enter()
    .append('g')
    .attr('class', 'graph-node')
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) graphSimulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) graphSimulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  nodeEl.append('circle')
    .attr('r', d => Math.max(10, 8 + d.degree * 2.5))
    .attr('fill', d => getNodeColor(d) + '33')
    .attr('stroke', d => getNodeColor(d))
    .attr('stroke-width', 2);

  nodeEl.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', d => Math.max(10, 8 + d.degree * 2.5) + 14)
    .text(d => d.name.length > 14 ? d.name.substring(0, 13) + '…' : d.name)
    .attr('fill', '#e8d4a0')
    .attr('font-size', 10);

  // Hover interactions
  nodeEl.on('mouseover', (e, d) => {
    const connectedIds = new Set([d.id]);
    links.forEach(l => {
      if (l.source.id === d.id || l.source === d.id) connectedIds.add(typeof l.target === 'object' ? l.target.id : l.target);
      if (l.target.id === d.id || l.target === d.id) connectedIds.add(typeof l.source === 'object' ? l.source.id : l.source);
    });
    nodeEl.attr('opacity', n => connectedIds.has(n.id) ? 1 : 0.15);
    linkEl.attr('opacity', l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      return (sid === d.id || tid === d.id) ? 1 : 0.05;
    });
  })
  .on('mouseout', () => {
    nodeEl.attr('opacity', 1);
    linkEl.attr('opacity', 0.6);
  })
  .on('click', (e, d) => {
    e.stopPropagation();
    openModal(d.id, d.type);
  });

  // Tick
  graphSimulation.on('tick', () => {
    linkEl
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    linkLabelEl
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);
    nodeEl.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

function setupGraphControls() {
  document.querySelectorAll('.graph-filter-btn[data-filter]').forEach(btn => {
    const key = btn.dataset.filter;
    btn.classList.toggle('active', key === 'all' || STATE.graphFilters[key]);
    btn.addEventListener('click', () => {
      if (key === 'all') {
        const allOn = Object.values(STATE.graphFilters).every(Boolean);
        Object.keys(STATE.graphFilters).forEach(k => STATE.graphFilters[k] = !allOn);
      } else {
        STATE.graphFilters[key] = !STATE.graphFilters[key];
      }
      document.querySelectorAll('.graph-filter-btn[data-filter]').forEach(b => {
        const k = b.dataset.filter;
        if (k === 'all') b.classList.toggle('active', Object.values(STATE.graphFilters).every(Boolean));
        else b.classList.toggle('active', STATE.graphFilters[k]);
      });
      renderGraph();
    });
  });

  const labelsBtn = document.getElementById('graph-labels-toggle');
  labelsBtn.addEventListener('click', () => {
    STATE.graphShowLabels = !STATE.graphShowLabels;
    labelsBtn.classList.toggle('active', STATE.graphShowLabels);
    renderGraph();
  });
}

// ── BOOTSTRAP ────────────────────────────────────────────────────────────────
async function init() {
  await loadData();

  // Tab navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Modal controls
  document.getElementById('modal-overlay').addEventListener('click', closeModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-back-btn').addEventListener('click', modalBack);

  // Secrets toggle
  document.getElementById('secrets-float-btn').addEventListener('click', toggleSecrets);

  // Render all sections
  renderPainel();
  renderCharacters();
  renderLocations();
  renderEvents();
  renderFactions();

  buildCharacterFilters();
  setupSearch(buildSearchIndex());
  setupGraphControls();
  applySecretsState();
}

document.addEventListener('DOMContentLoaded', init);

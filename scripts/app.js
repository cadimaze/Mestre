// ── IMPORTS ──────────────────────────────────────────────────────────────────
import { initializeApp }                          from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInWithEmailAndPassword,
         createUserWithEmailAndPassword, signOut,
         onAuthStateChanged }                     from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, collection, doc, getDoc,
         getDocs, setDoc, addDoc, updateDoc,
         deleteDoc, onSnapshot, query, orderBy, where,
         serverTimestamp, writeBatch }            from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { FIREBASE_CONFIG, MASTER_EMAIL, CAMPAIGN_ID,
         CLOUDINARY_CLOUD_NAME,
         CLOUDINARY_UPLOAD_PRESET }             from './firebase-config.js';
import * as d3                                   from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

// ── FIREBASE INIT ─────────────────────────────────────────────────────────────
const fbApp = initializeApp(FIREBASE_CONFIG);
const auth  = getAuth(fbApp);
const db    = getFirestore(fbApp);

// ── STATE ─────────────────────────────────────────────────────────────────────
const STATE = {
  user:           null,
  profile:        null,
  isMaster:       false,
  players:        [],
  unsubscribers:  [],
  data: { characters: [], locations: [], events: [], factions: [], relations: [], annotations: [] },

  activeTab:       'painel',
  secretsVisible:  localStorage.getItem('secretsVisible') !== 'false',
  modal:           { stack: [], current: null },
  graphFilters:    { character: true, location: true, event: true, faction: true },
  graphShowLabels: true,
  charFilters:     { name: '', faction: '', status: '', secretsOnly: false },
};

// ── AUTH UI ───────────────────────────────────────────────────────────────────
function showAuthOverlay()  { document.getElementById('auth-overlay').classList.add('visible'); }
function hideAuthOverlay()  { document.getElementById('auth-overlay').classList.remove('visible'); }
function showAuthError(msg) { document.getElementById('auth-error').textContent = msg; }
function clearAuthError()   { document.getElementById('auth-error').textContent = ''; }

function setupAuthUI() {
  const loginForm      = document.getElementById('login-form');
  const registerForm   = document.getElementById('register-form');
  const showRegisterBtn = document.getElementById('show-register');
  const showLoginBtn   = document.getElementById('show-login');

  showRegisterBtn.addEventListener('click', () => {
    loginForm.style.display    = 'none';
    registerForm.style.display = 'flex';
    showRegisterBtn.style.display = 'none';
    showLoginBtn.style.display    = 'inline';
    clearAuthError();
  });

  showLoginBtn.addEventListener('click', () => {
    loginForm.style.display    = 'flex';
    registerForm.style.display = 'none';
    showRegisterBtn.style.display = 'inline';
    showLoginBtn.style.display    = 'none';
    clearAuthError();
  });

  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth,
        document.getElementById('login-email').value,
        document.getElementById('login-password').value
      );
      clearAuthError();
    } catch (err) { showAuthError(authErrMsg(err.code)); }
  });

  registerForm.addEventListener('submit', async e => {
    e.preventDefault();
    const name  = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value;
    const pass  = document.getElementById('reg-password').value;
    if (!name) { showAuthError('Informe seu nome.'); return; }
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      const role = email.toLowerCase() === MASTER_EMAIL.toLowerCase() ? 'master' : 'player';
      await setDoc(doc(db, 'users', cred.user.uid), {
        displayName: name,
        email: email.toLowerCase(),
        role,
        campaignId: CAMPAIGN_ID,
        playerCharacter: null,
        createdAt: serverTimestamp(),
      });
      clearAuthError();
    } catch (err) { showAuthError(authErrMsg(err.code)); }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    STATE.unsubscribers.forEach(u => u());
    STATE.unsubscribers = [];
    await signOut(auth);
  });
}

function authErrMsg(code) {
  return ({
    'auth/user-not-found':      'Usuário não encontrado.',
    'auth/wrong-password':      'Senha incorreta.',
    'auth/email-already-in-use':'Este e-mail já está em uso.',
    'auth/weak-password':       'Senha fraca — use ao menos 6 caracteres.',
    'auth/invalid-email':       'E-mail inválido.',
    'auth/invalid-credential':  'E-mail ou senha inválidos.',
    'auth/too-many-requests':   'Muitas tentativas. Aguarde e tente novamente.',
  })[code] || 'Erro ao autenticar. Tente novamente.';
}

// ── USER PROFILE ──────────────────────────────────────────────────────────────
async function loadUserProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  if (snap.exists()) {
    STATE.profile  = snap.data();
    STATE.isMaster = STATE.profile.role === 'master';
    return STATE.profile;
  }
  return null;
}

async function loadAllPlayers() {
  const snap = await getDocs(collection(db, 'users'));
  STATE.players = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

// ── FIRESTORE SUBSCRIPTIONS ──────────────────────────────────────────────────
function subscribeToCollection(collName) {
  const ref = collection(db, 'campaigns', CAMPAIGN_ID, collName);

  if (STATE.isMaster) {
    const unsub = onSnapshot(ref, snap => {
      STATE.data[collName] = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      rerenderSection(collName);
    }, err => console.error(`[${collName}]`, err));
    STATE.unsubscribers.push(unsub);
    return;
  }

  // Players: two separate single-field queries merged by id.
  // Using two listeners avoids composite-index requirements and is provably safe
  // under the simplified isVisible() rule (mode==all OR uid in playerIds).
  const uid   = STATE.user.uid;
  const byId  = { all: new Map(), specific: new Map() };

  function merge() {
    const merged = new Map([...byId.all, ...byId.specific]);
    STATE.data[collName] = [...merged.values()];
    rerenderSection(collName);
  }

  const unsubAll = onSnapshot(
    query(ref, where('visibility.mode', '==', 'all')),
    snap => {
      byId.all.clear();
      snap.docs.forEach(d => byId.all.set(d.id, { ...d.data(), id: d.id }));
      merge();
    },
    err => console.error(`[${collName}/all]`, err)
  );

  const unsubSpecific = onSnapshot(
    query(ref, where('visibility.playerIds', 'array-contains', uid)),
    snap => {
      byId.specific.clear();
      snap.docs.forEach(d => byId.specific.set(d.id, { ...d.data(), id: d.id }));
      merge();
    },
    err => console.error(`[${collName}/specific]`, err)
  );

  STATE.unsubscribers.push(unsubAll, unsubSpecific);
}

function subscribeToAnnotations() {
  const ref = collection(db, 'campaigns', CAMPAIGN_ID, 'annotations');
  const q   = query(ref, orderBy('createdAt', 'asc'));
  const unsub = onSnapshot(q, snap => {
    STATE.data.annotations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (STATE.modal.current) refreshModalAnnotations();
  });
  STATE.unsubscribers.push(unsub);
}

function isItemVisible(item) {
  const v = item.visibility;
  if (!v) return false;
  if (v.mode === 'all') return true;
  if (v.mode === 'specific') return (v.playerIds || []).includes(STATE.user.uid);
  return false;
}

function rerenderSection(collName) {
  switch (collName) {
    case 'characters': renderPainel(); renderCharacters(); break;
    case 'locations':  renderPainel(); renderLocations();  break;
    case 'events':     renderPainel(); renderEvents();     break;
    case 'factions':   renderPainel(); renderFactions(); buildCharacterFilters(); break;
    case 'relations':  if (STATE.activeTab === 'relacoes') renderGraph(); break;
  }
}

async function setupFirestoreListeners() {
  subscribeToCollection('characters');
  subscribeToCollection('locations');
  subscribeToCollection('events');
  subscribeToCollection('factions');
  subscribeToCollection('relations');
  subscribeToAnnotations();
}

// ── VISIBILITY ────────────────────────────────────────────────────────────────
async function updateVisibility(collName, itemId, mode, playerIds = []) {
  await updateDoc(doc(db, 'campaigns', CAMPAIGN_ID, collName, itemId), {
    'visibility.mode':      mode,
    'visibility.playerIds': playerIds,
  });
}

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
const collNameToEntityType = { characters: 'character', locations: 'location', events: 'event', factions: 'faction' };

async function sendRevealNotifications(targetUids, entityType, entityId, entityName, type = 'reveal') {
  if (!targetUids.length) return;
  const batch = writeBatch(db);
  for (const uid of targetUids) {
    const ref = doc(collection(db, 'users', uid, 'notifications'));
    batch.set(ref, {
      type,                    // 'reveal' | 'secret'
      entityType,
      entityId,
      entityName,
      read: false,
      createdAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

let _notifQueue  = [];
let _notifActive = false;

function showRevealToast(notif) {
  return new Promise(resolve => {
    const isSecret = notif.type === 'secret';
    const overlay  = document.createElement('div');
    overlay.className = 'reveal-toast-overlay';

    const icon     = isSecret ? '🔒' : { character: '⚔️', location: '🗺️', event: '📜', faction: '⚜️' }[notif.entityType] || '✨';
    const eyebrow  = isSecret ? 'Segredo Revelado' : 'Novo Acesso';
    const titleTxt = isSecret ? 'Agora você sabe de um segredo importante!' : `Agora você pode ver`;
    const entityLabel = { character: 'este personagem', location: 'este local', event: 'este evento', faction: 'esta facção' }[notif.entityType] || 'este conteúdo';

    overlay.innerHTML = `
      <div class="reveal-toast${isSecret?' toast-secret':''}">
        <div class="reveal-toast-icon">${icon}</div>
        <div class="reveal-toast-eyebrow">${eyebrow}</div>
        <div class="reveal-toast-title">${titleTxt}</div>
        <div class="reveal-toast-name">${escHtml(notif.entityName)}</div>
        <div class="reveal-toast-desc">${
          isSecret
            ? 'O mestre revelou um segredo exclusivo para você. Esta informação é confidencial.'
            : `O mestre liberou o acesso a informações sobre ${escHtml(notif.entityName)}. Explore ${entityLabel} agora.`
        }</div>
        <div>
          ${!isSecret ? `<button class="reveal-toast-btn" id="rt-view">Ver agora</button>` : ''}
          <button class="${isSecret?'reveal-toast-btn':'reveal-toast-btn-secondary'}" id="rt-close">${isSecret?'Entendido':'Fechar'}</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    async function dismiss() {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 450);
      if (notif.id) {
        try { await updateDoc(doc(db, 'users', STATE.user.uid, 'notifications', notif.id), { read: true }); } catch {}
      }
      resolve();
    }

    overlay.querySelector('#rt-close').addEventListener('click', dismiss);
    const viewBtn = overlay.querySelector('#rt-view');
    if (viewBtn) {
      viewBtn.addEventListener('click', async () => {
        await dismiss();
        if (notif.entityId && notif.entityType) openModal(notif.entityId, notif.entityType);
      });
    }
  });
}

async function processNotifQueue() {
  if (_notifActive || !_notifQueue.length) return;
  _notifActive = true;
  while (_notifQueue.length) {
    const notif = _notifQueue.shift();
    await showRevealToast(notif);
    await new Promise(r => setTimeout(r, 400));
  }
  _notifActive = false;
}

function enqueueNotif(notif) {
  _notifQueue.push(notif);
  processNotifQueue();
}

async function checkAndShowNotifications() {
  if (!STATE.user || STATE.isMaster) return;
  try {
    const snap = await getDocs(
      query(collection(db, 'users', STATE.user.uid, 'notifications'),
            where('read', '==', false))
    );
    snap.docs.forEach(d => enqueueNotif({ id: d.id, ...d.data() }));
  } catch (err) { console.warn('Notifications read error:', err); }
}

function subscribeToNotifications() {
  if (!STATE.user || STATE.isMaster) return;
  let initialized = false;
  onSnapshot(
    query(collection(db, 'users', STATE.user.uid, 'notifications'), where('read', '==', false)),
    snap => {
      if (!initialized) { initialized = true; return; } // skip initial load (handled by checkAndShowNotifications)
      snap.docChanges().forEach(change => {
        if (change.type === 'added') enqueueNotif({ id: change.doc.id, ...change.doc.data() });
      });
    },
    err => console.warn('Notifications listener error:', err)
  );
}

function visBadgeEmoji(item) {
  const m = item.visibility?.mode;
  if (m === 'all')      return '🌐';
  if (m === 'specific') return `👁 ${(item.visibility.playerIds || []).length}`;
  return '🔒';
}

function buildVisibilitySection(item, collName) {
  if (!STATE.isMaster) return '';
  const isAll = item.visibility?.mode === 'all';
  const isSpec = item.visibility?.mode === 'specific';

  const playerOptions = STATE.players
    .filter(p => p.role === 'player')
    .map(p => {
      const checked = (item.visibility?.playerIds || []).includes(p.uid) ? 'checked' : '';
      return `<label class="player-vis-label">
        <input type="checkbox" class="player-vis-check" data-uid="${p.uid}" ${checked}>
        <span>${p.displayName}</span>
      </label>`;
    }).join('') || '<span style="color:#3a4a5a;font-size:12px;font-family:var(--font-body)">Nenhum jogador registrado ainda.</span>';

  return `<div class="modal-section vis-section" id="vis-section"
               data-item-id="${item.id}" data-coll-name="${collName}">
    <div class="modal-section-title">Visibilidade para Jogadores</div>
    <div class="vis-controls">
      <button class="vis-btn vis-btn-all ${isAll ? 'active' : ''}" data-mode="all">🌐 Todos podem ver</button>
      <button class="vis-btn vis-btn-specific ${isSpec ? 'active' : ''}" data-mode="specific">👁 Específicos</button>
      <button class="vis-btn vis-btn-hidden ${!isAll && !isSpec ? 'active' : ''}" data-mode="hidden">🔒 Oculto</button>
    </div>
    <div class="vis-players ${isAll ? 'vis-players-hidden' : ''}" id="vis-players">
      ${playerOptions}
    </div>
  </div>`;
}

function attachVisibilityEvents() {
  const sec = document.getElementById('vis-section');
  if (!sec) return;
  const itemId   = sec.dataset.itemId;
  const collName = sec.dataset.collName;

  function getOldVis() {
    const typeKey  = collNameToEntityType[collName] || collName;
    const collKey  = collName;
    const dataMap  = { characters: STATE.data.characters, locations: STATE.data.locations, events: STATE.data.events, factions: STATE.data.factions };
    const item     = (dataMap[collKey] || []).find(e => e.id === itemId);
    return { mode: item?.visibility?.mode || 'hidden', playerIds: item?.visibility?.playerIds || [], name: item?.name || '' };
  }

  async function save() {
    const activeBtn = sec.querySelector('.vis-btn.active');
    const mode = activeBtn ? activeBtn.dataset.mode : 'hidden';
    // playerIds MUST be empty unless mode==='specific'. This is a hard invariant:
    // isVisible() in Firestore rules is simplified to (mode==all || uid in playerIds),
    // so a non-empty playerIds on a 'hidden' doc would grant unintended read access.
    const playerIds = mode === 'specific'
      ? [...sec.querySelectorAll('.player-vis-check:checked')].map(c => c.dataset.uid)
      : [];

    const old        = getOldVis();
    const entityType = collNameToEntityType[collName] || collName;

    await updateVisibility(collName, itemId, mode, playerIds);

    // Notify newly-visible players
    const allPlayerUids = STATE.players.filter(p => p.role === 'player').map(p => p.uid);
    let newlyVisible = [];
    if (mode === 'all' && old.mode !== 'all') {
      newlyVisible = allPlayerUids;
    } else if (mode === 'specific') {
      newlyVisible = playerIds.filter(uid => !old.playerIds.includes(uid));
    }
    if (newlyVisible.length) {
      await sendRevealNotifications(newlyVisible, entityType, itemId, old.name, 'reveal');
    }
  }

  sec.querySelectorAll('.vis-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      sec.querySelectorAll('.vis-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const playersDiv = document.getElementById('vis-players');
      if (playersDiv) {
        if (btn.dataset.mode === 'all') playersDiv.classList.add('vis-players-hidden');
        else playersDiv.classList.remove('vis-players-hidden');
      }
      await save();
    });
  });

  sec.querySelectorAll('.player-vis-check').forEach(chk => {
    chk.addEventListener('change', save);
  });
}

// ── ANNOTATIONS ───────────────────────────────────────────────────────────────
function itemAnnotations(targetId) {
  return STATE.data.annotations.filter(a => a.targetId === targetId);
}

function annotationListHtml(targetId) {
  const anns = itemAnnotations(targetId);
  if (!anns.length) return '<div class="annotation-empty">Nenhuma anotação ainda.</div>';
  return anns.map(a => {
    const date = a.createdAt?.toDate
      ? a.createdAt.toDate().toLocaleDateString('pt-BR') : '';
    const canDel = STATE.isMaster || a.authorId === STATE.user?.uid;
    return `<div class="annotation-item">
      <div class="annotation-header">
        <span class="annotation-author">${escHtml(a.authorName)}</span>
        <span class="annotation-date">${date}</span>
        ${canDel ? `<button class="annotation-delete-btn" data-ann-id="${a.id}" title="Excluir">✕</button>` : ''}
      </div>
      <div class="annotation-text">${escHtml(a.text)}</div>
    </div>`;
  }).join('');
}

function buildAnnotationsSection(targetId, targetType) {
  return `<div class="modal-section annotations-section" id="annotations-section">
    <div class="modal-section-title">📝 Anotações</div>
    <div class="annotations-list" id="annotations-list">${annotationListHtml(targetId)}</div>
    <div class="annotation-form">
      <textarea id="annotation-input" class="annotation-textarea"
        placeholder="Adicionar anotação..." rows="2"></textarea>
      <button id="annotation-submit" class="annotation-submit-btn"
        data-target-id="${targetId}" data-target-type="${targetType}">Salvar</button>
    </div>
  </div>`;
}

function attachSecretVisEvents(charId) {
  if (!STATE.isMaster) return;
  const sec = document.getElementById('char-secrets-modal-section');
  if (!sec) return;

  async function saveSecretVis(secretId, mode, playerIds) {
    const char = getCharById(charId);
    if (!char) return;

    const oldList    = Array.isArray(char.secretsList) ? char.secretsList
                       : (char.secrets ? [{ id: '0', text: char.secrets, visibility: { mode: 'hidden', playerIds: [] } }] : []);
    const oldSecret  = oldList.find(s => s.id === secretId);
    const oldVis     = oldSecret?.visibility || { mode: 'hidden', playerIds: [] };

    const newList = oldList.map(s =>
      s.id === secretId ? { ...s, visibility: { mode, playerIds } } : s
    );

    await updateDoc(doc(db, 'campaigns', CAMPAIGN_ID, 'characters', charId), { secretsList: newList });

    // Notify newly-visible players
    const allPlayerUids = STATE.players.filter(p => p.role === 'player').map(p => p.uid);
    let newlyVisible = [];
    if (mode === 'all' && oldVis.mode !== 'all') {
      newlyVisible = allPlayerUids;
    } else if (mode === 'specific') {
      newlyVisible = playerIds.filter(uid => !(oldVis.playerIds || []).includes(uid));
    }
    if (newlyVisible.length) {
      await sendRevealNotifications(newlyVisible, 'character', charId, char.name, 'secret');
    }
  }

  sec.querySelectorAll('.sec-vis-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const secretId = btn.dataset.secretId;
      const mode     = btn.dataset.mode;

      // Update active state on buttons for this secret
      sec.querySelectorAll(`.sec-vis-btn[data-secret-id="${secretId}"]`)
         .forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

      // Show/hide player list
      const playersDiv = document.getElementById(`svp-${secretId}`);
      if (playersDiv) playersDiv.classList.toggle('pc-hidden', mode !== 'specific');

      const playerIds = mode === 'specific'
        ? [...sec.querySelectorAll(`.sec-player-check[data-secret-id="${secretId}"]:checked`)].map(c => c.dataset.uid)
        : [];

      await saveSecretVis(secretId, mode, playerIds);
    });
  });

  sec.querySelectorAll('.sec-player-check').forEach(chk => {
    chk.addEventListener('change', async () => {
      const secretId  = chk.dataset.secretId;
      const playerIds = [...sec.querySelectorAll(`.sec-player-check[data-secret-id="${secretId}"]:checked`)].map(c => c.dataset.uid);
      await saveSecretVis(secretId, 'specific', playerIds);
    });
  });
}

function attachAnnotationEvents() {
  const btn = document.getElementById('annotation-submit');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const text = document.getElementById('annotation-input').value.trim();
    if (!text) return;
    await addDoc(collection(db, 'campaigns', CAMPAIGN_ID, 'annotations'), {
      targetId:   btn.dataset.targetId,
      targetType: btn.dataset.targetType,
      text,
      authorId:   STATE.user.uid,
      authorName: STATE.profile.displayName,
      createdAt:  serverTimestamp(),
    });
    document.getElementById('annotation-input').value = '';
  });
  attachAnnotationDeleteEvents();
}

function attachAnnotationDeleteEvents() {
  document.querySelectorAll('.annotation-delete-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (confirm('Excluir esta anotação?')) {
        await deleteDoc(doc(db, 'campaigns', CAMPAIGN_ID, 'annotations', btn.dataset.annId));
      }
    });
  });
}

function refreshModalAnnotations() {
  const list = document.getElementById('annotations-list');
  if (!list || !STATE.modal.current) return;
  list.innerHTML = annotationListHtml(STATE.modal.current.id);
  attachAnnotationDeleteEvents();
}

function escHtml(text) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(text));
  return d.innerHTML;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const getFactionById  = id => STATE.data.factions.find(f => f.id === id);
const getCharById     = id => STATE.data.characters.find(c => c.id === id);
const getLocationById = id => STATE.data.locations.find(l => l.id === id);
const getEventById    = id => STATE.data.events.find(e => e.id === id);

function factionColor(factionId) {
  const f = getFactionById(factionId);
  return f ? f.color : '#3a5a7a';
}

function hasSecrets(item) {
  if (!item) return false;
  if (Array.isArray(item.secretsList) && item.secretsList.length > 0) return true;
  return !!(item.secrets && item.secrets.trim().length > 0);
}

function buildCharSecretsHtml(c) {
  const uid      = STATE.user?.uid;
  const isMaster = STATE.isMaster;
  const list     = Array.isArray(c.secretsList)
    ? c.secretsList
    : (c.secrets ? [{ id: '0', text: c.secrets, visibility: { mode: 'hidden', playerIds: [] } }] : []);
  if (!list.length) return '';

  if (isMaster) {
    const players = STATE.players.filter(p => p.role === 'player');

    function secVisButtons(vis, secretId) {
      const mode = vis?.mode || 'hidden';
      return `<div class="sec-vis-btn-row" data-secret-id="${secretId}">
        ${['hidden','specific','all'].map(m =>
          `<button type="button" class="sec-vis-btn${mode===m?' active':''}" data-secret-id="${secretId}" data-mode="${m}">${
            m==='hidden'?'🔒 Oculto':m==='specific'?'👁 Específicos':'🌐 Todos'
          }</button>`
        ).join('')}
      </div>`;
    }

    function secPlayerChecks(vis, secretId) {
      if (!players.length) return `<div class="pc-no-players" style="padding:8px 0;">Nenhum jogador cadastrado.</div>`;
      const selectedIds = vis?.playerIds || [];
      return `<div class="sec-vis-players${vis?.mode==='specific'?'':' pc-hidden'}" id="svp-${secretId}">
        ${players.map(p =>
          `<label class="pc-player-check-label">
            <input type="checkbox" class="sec-player-check" data-secret-id="${secretId}" data-uid="${p.uid}"${selectedIds.includes(p.uid)?' checked':''}>
            ${escHtml(p.displayName || p.email)}
          </label>`
        ).join('')}
      </div>`;
    }

    const items = list.map((s, i) => {
      const vis = s.visibility || { mode: 'hidden', playerIds: [] };
      return `<div class="modal-char-secret-item" data-secret-id="${s.id}">
        <div class="modal-char-secret-header">
          <span class="modal-char-secret-num">Segredo ${i+1}</span>
        </div>
        <div class="modal-section-text" style="margin-bottom:10px;">${escHtml(s.text)}</div>
        <div class="sec-vis-wrap">
          <div class="sec-vis-label">Visível para:</div>
          ${secVisButtons(vis, s.id)}
          ${secPlayerChecks(vis, s.id)}
        </div>
      </div>`;
    }).join('');

    return `<div class="modal-section secrets-section" id="char-secrets-modal-section" data-char-id="${c.id}">
      <div class="modal-secrets">
        <div class="modal-section-title">🔒 Segredos do Mestre</div>
        ${items}
      </div>
    </div>`;
  }

  // Player view — only show accessible secrets
  const visible = list.filter(s => {
    const v = s.visibility;
    if (!v || v.mode === 'all') return true;
    if (v.mode === 'specific') return (v.playerIds||[]).includes(uid);
    return false;
  });
  if (!visible.length) return '';
  return `<div class="modal-section player-secrets-section"><div class="modal-secrets">
    <div class="modal-section-title">🔒 Segredos Revelados</div>
    ${visible.map(s => `<div class="modal-section-text" style="margin-bottom:8px;">${escHtml(s.text)}</div>`).join('')}
  </div></div>`;
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

function charImgSrc(char) {
  if (char.imageUrl) return char.imageUrl;
  if (char.image)    return `assets/images/characters/${char.image}`;
  return null;
}

function avatarHtml(char, size = 64) {
  const imgPath = charImgSrc(char);
  const initial = char.name ? char.name.charAt(0).toUpperCase() : '?';
  const inner = imgPath
    ? `<img src="${imgPath}" alt="${char.name}" style="width:100%;height:100%;object-fit:cover;"
         onerror="this.parentElement.innerHTML='<div class=\\'char-avatar-placeholder\\'>${initial}</div>'">`
    : `<div class="char-avatar-placeholder">${initial}</div>`;
  return `<div class="char-avatar" style="width:${size}px;height:${size}px;border-radius:8px;overflow:hidden;border:2px solid var(--border-accent);">${inner}</div>`;
}

function charPortraitHtml(c) {
  const initial = c.name ? c.name.charAt(0).toUpperCase() : '?';
  const imgPath = charImgSrc(c);
  const imageEl = imgPath
    ? `<img class="char-portrait-img" src="${imgPath}" alt="${c.name}"
         onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <div class="char-portrait-initial" style="display:none">${initial}</div>`
    : `<div class="char-portrait-initial">${initial}</div>`;
  return `<div class="char-portrait">
    ${imageEl}
    <div class="char-portrait-overlay">
      ${statusBadgeHtml(c.status)}
      ${hasSecrets(c) && STATE.isMaster ? '<span class="portrait-secret secret-icon">🔒</span>' : ''}
    </div>
  </div>`;
}

// ── NAVIGATION ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  STATE.activeTab = tab;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'relacoes')       renderGraph();
  if (tab === 'jogadores')      renderJogadores();
  if (tab === 'meu-personagem') renderMeuPersonagem();
}

// ── SECRETS TOGGLE ────────────────────────────────────────────────────────────
function applySecretsState() {
  const btn = document.getElementById('secrets-float-btn');
  if (!btn) return;
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

// ── PAINEL ────────────────────────────────────────────────────────────────────
function renderPainel() {
  const d = STATE.data;
  document.getElementById('count-chars').textContent     = d.characters.length;
  document.getElementById('count-locations').textContent  = d.locations.length;
  document.getElementById('count-events').textContent    = d.events.length;
  document.getElementById('count-factions').textContent   = d.factions.length;

  if (STATE.isMaster) {
    const secretsEl = document.getElementById('secrets-total');
    if (secretsEl) secretsEl.textContent = [...d.characters, ...d.locations, ...d.events, ...d.factions].filter(hasSecrets).length;
  }

  const relList = document.getElementById('recent-relations');
  const recent = d.relations.slice(-5).reverse();
  relList.innerHTML = recent.map(r => {
    const sName = getEntityName(r.sourceId, r.sourceType);
    const tName = getEntityName(r.targetId, r.targetType);
    return `<div class="recent-relation" data-id="${r.sourceId}" data-type="${r.sourceType}">
      <span class="rel-source">${sName}</span>
      <span class="rel-label">${r.label}</span>
      <span class="rel-target">${tName}</span>
    </div>`;
  }).join('') || '<p style="color:var(--text-muted);font-size:13px;">Nenhuma relação disponível.</p>';

  relList.querySelectorAll('.recent-relation').forEach(el => {
    el.addEventListener('click', () => openModal(el.dataset.id, el.dataset.type));
  });
}

function getEntityName(id, type) {
  const fn = { character: getCharById, location: getLocationById, event: getEventById, faction: getFactionById }[type];
  return fn?.(id)?.name || id;
}

// ── ADD NEW BUTTONS ───────────────────────────────────────────────────────────
function ensureAddBtn(sectionId, type, label) {
  if (!STATE.isMaster) return;
  const section = document.getElementById(sectionId);
  if (!section || section.querySelector('.add-new-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'add-new-btn master-only';
  btn.textContent = `+ ${label}`;
  btn.addEventListener('click', () => openNewItemModal(type));
  section.appendChild(btn);
}

// ── CHARACTERS ────────────────────────────────────────────────────────────────
function renderCharacters() {
  const { name, faction, status, secretsOnly } = STATE.charFilters;
  const chars = STATE.data.characters.filter(c => {
    if (name && !c.name.toLowerCase().includes(name.toLowerCase())) return false;
    if (faction && c.faction !== faction) return false;
    if (status && c.status !== status) return false;
    if (secretsOnly && !hasSecrets(c)) return false;
    return true;
  });

  const grid = document.getElementById('characters-grid');
  if (!chars.length) {
    const msg = !STATE.isMaster && !STATE.data.characters.length
      ? 'Você ainda não pode ver nada por aqui.'
      : 'Nenhum personagem encontrado.';
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">⚓</div><p>${msg}</p></div>`;
    return;
  }

  grid.innerHTML = chars.map(c => {
    const fc = factionColor(c.faction);
    return `<div class="character-card" data-id="${c.id}" style="--faction-color:${fc};position:relative;">
      ${charPortraitHtml(c)}
      <div class="char-info">
        <div class="char-faction-strip" style="background:${fc}"></div>
        <div class="char-name">${c.name}</div>
        <div class="char-role">${c.role || ''}</div>
        <div class="badges">${factionBadgeHtml(c.faction)}</div>
      </div>
      ${STATE.isMaster ? `<span class="vis-card-badge" title="Visibilidade">${visBadgeEmoji(c)}</span>` : ''}
    </div>`;
  }).join('');

  grid.querySelectorAll('.character-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, 'character'));
  });
  ensureAddBtn('tab-personagens', 'character', 'Adicionar Personagem');
}

function buildCharacterFilters() {
  const sel = document.getElementById('char-filter-faction');
  sel.innerHTML = '<option value="">Todas as facções</option>' +
    STATE.data.factions.map(f => `<option value="${f.id}">${f.name}</option>`).join('');

  // Only add listeners once
  if (sel.dataset.ready) return;
  sel.dataset.ready = '1';

  document.getElementById('char-filter-name').addEventListener('input', e => {
    STATE.charFilters.name = e.target.value; renderCharacters();
  });
  sel.addEventListener('change', e => {
    STATE.charFilters.faction = e.target.value; renderCharacters();
  });
  document.getElementById('char-filter-status').addEventListener('change', e => {
    STATE.charFilters.status = e.target.value; renderCharacters();
  });
  const secBtn = document.getElementById('char-filter-secrets');
  if (secBtn) secBtn.addEventListener('click', () => {
    STATE.charFilters.secretsOnly = !STATE.charFilters.secretsOnly;
    secBtn.classList.toggle('active', STATE.charFilters.secretsOnly);
    renderCharacters();
  });
}

// ── LOCATIONS ─────────────────────────────────────────────────────────────────
function renderLocations() {
  const grid = document.getElementById('locations-grid');
  if (!STATE.data.locations.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🌊</div><p>${!STATE.isMaster ? 'Você ainda não pode ver nada por aqui.' : 'Nenhum local cadastrado.'}</p></div>`;
    ensureAddBtn('tab-locais', 'location', 'Adicionar Local');
    return;
  }
  grid.innerHTML = STATE.data.locations.map(l => {
    const controller = getCharById(l.controlledBy);
    const controlText = controller
      ? controller.name
      : (getFactionById(l.controlledBy)?.name || l.controlledBy);

    if (l.featured) {
      const paras = (l.description || '').split('\n');
      const firstPara = paras[0] || '';
      return `<div class="location-card location-featured" data-id="${l.id}" style="position:relative;">
        ${l.imageUrl ? `<img class="location-card-img location-card-img-featured" src="${l.imageUrl}" alt="${l.name}" onerror="this.remove()">` : ''}
        <div class="location-featured-inner">
          <div>
            <div class="location-name">${l.name}</div>
            <div class="location-subtitle">${l.subtitle || ''}</div>
            <span class="location-type-badge">${l.type || ''}</span>
            <div class="location-tone" style="margin-top:10px;">${l.tone || ''}</div>
            ${hasSecrets(l) && STATE.isMaster ? '<div style="margin-top:10px;"><span class="secret-icon" title="Tem segredos">🔒</span></div>' : ''}
          </div>
          <p class="location-featured-desc">${firstPara}</p>
        </div>
        ${STATE.isMaster ? `<span class="vis-card-badge" title="Visibilidade">${visBadgeEmoji(l)}</span>` : ''}
      </div>`;
    }

    return `<div class="location-card" data-id="${l.id}" style="position:relative;">
      ${l.imageUrl ? `<img class="location-card-img" src="${l.imageUrl}" alt="${l.name}" onerror="this.remove()">` : ''}
      <div class="location-name">${l.name}</div>
      <div class="location-subtitle">${l.subtitle || ''}</div>
      <span class="location-type-badge">${l.type || ''}</span>
      <div class="location-tone">${l.tone || ''}</div>
      ${controlText ? `<div class="location-control">Controlado por: ${controlText}</div>` : ''}
      ${hasSecrets(l) && STATE.isMaster ? '<span class="secret-icon" title="Tem segredos">🔒</span>' : ''}
      ${STATE.isMaster ? `<span class="vis-card-badge" title="Visibilidade">${visBadgeEmoji(l)}</span>` : ''}
    </div>`;
  }).join('');

  grid.querySelectorAll('.location-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, 'location'));
  });
  ensureAddBtn('tab-locais', 'location', 'Adicionar Local');
}

// ── EVENTS ────────────────────────────────────────────────────────────────────
function renderEvents() {
  const sorted = [...STATE.data.events].sort((a, b) => (a.order || 0) - (b.order || 0));
  const timeline = document.getElementById('events-timeline');
  if (!sorted.length) {
    timeline.innerHTML = `<div class="empty-state"><div class="empty-icon">📜</div><p>${!STATE.isMaster ? 'Você ainda não pode ver nada por aqui.' : 'Nenhum evento cadastrado.'}</p></div>`;
    ensureAddBtn('tab-eventos', 'event', 'Adicionar Evento');
    return;
  }
  timeline.innerHTML = sorted.map(e => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="event-card" data-id="${e.id}" style="position:relative;">
        <div class="event-period">${e.period || ''}</div>
        <div class="event-name">${e.name}</div>
        ${scaleBadgeHtml(e.scale)}
        ${hasSecrets(e) && STATE.isMaster ? '<span class="secret-icon" title="Tem segredos">🔒</span>' : ''}
        <div class="event-desc">${e.description || ''}</div>
        ${STATE.isMaster ? `<span class="vis-card-badge" title="Visibilidade">${visBadgeEmoji(e)}</span>` : ''}
      </div>
    </div>
  `).join('');

  timeline.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, 'event'));
  });
  ensureAddBtn('tab-eventos', 'event', 'Adicionar Evento');
}

// ── FACTIONS ──────────────────────────────────────────────────────────────────
function renderFactions() {
  const grid = document.getElementById('factions-grid');
  if (!STATE.data.factions.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">⚓</div><p>${!STATE.isMaster ? 'Você ainda não pode ver nada por aqui.' : 'Nenhuma facção cadastrada.'}</p></div>`;
    ensureAddBtn('tab-faccoes', 'faction', 'Adicionar Facção');
    return;
  }
  grid.innerHTML = STATE.data.factions.map(f => {
    const memberTags = (f.members || []).map(mid => {
      const c = getCharById(mid);
      return c ? `<span class="tag-chip" data-id="${mid}" data-type="character">${c.name}</span>` : '';
    }).join('');
    return `<div class="faction-card" data-id="${f.id}" style="position:relative;">
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
          ${hasSecrets(f) && STATE.isMaster ? '<span class="secret-icon" title="Tem segredos">🔒</span>' : ''}
        </div>
        <div class="faction-desc">${f.description || ''}</div>
        ${memberTags ? `<div class="faction-label">Membros notáveis</div><div class="tags-list">${memberTags}</div>` : ''}
      </div>
      ${STATE.isMaster ? `<span class="vis-card-badge" title="Visibilidade">${visBadgeEmoji(f)}</span>` : ''}
    </div>`;
  }).join('');

  grid.querySelectorAll('.faction-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, 'faction'));
  });
  ensureAddBtn('tab-faccoes', 'faction', 'Adicionar Facção');
  grid.querySelectorAll('.tag-chip').forEach(tag => {
    tag.addEventListener('click', e => {
      e.stopPropagation();
      openModal(tag.dataset.id, tag.dataset.type);
    });
  });
}

// ── JOGADORES TAB ─────────────────────────────────────────────────────────────
async function renderJogadores() {
  await loadAllPlayers();
  const grid = document.getElementById('jogadores-grid');
  const players = STATE.players.filter(p => p.role === 'player');

  if (!players.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">⚓</div><p>Nenhum jogador registrado ainda.</p></div>`;
    return;
  }

  grid.innerHTML = players.map(p => {
    const pc = p.playerCharacter;
    const initial = (p.displayName || '?').charAt(0).toUpperCase();
    return `<div class="jogador-card">
      <div style="display:flex;align-items:center;gap:14px;">
        <div class="jogador-avatar">${initial}</div>
        <div>
          <div class="jogador-name">${escHtml(p.displayName || '—')}</div>
          <div class="jogador-email">${escHtml(p.email || '')}</div>
        </div>
      </div>
      ${pc && pc.name
        ? `<div class="jogador-char-info">
            <div class="jogador-char-name">${escHtml(pc.name)}</div>
            <div>${[pc.race, pc.charClass, pc.background].filter(Boolean).map(escHtml).join(' · ')}</div>
           </div>`
        : `<div class="jogador-char-info" style="color:#3a4a5a;font-style:italic;">Ficha ainda não preenchida.</div>`
      }
    </div>`;
  }).join('');
}

// ── MEU PERSONAGEM TAB ────────────────────────────────────────────────────────
function renderMeuPersonagem() {
  const container = document.getElementById('meu-personagem-content');
  const pc  = STATE.profile?.playerCharacter || {};
  const myUid = STATE.user.uid;
  const otherPlayers = STATE.players.filter(p => p.role === 'player' && p.uid !== myUid);

  // Mutable state — saved together on form submit
  let sheetVis   = pc.sheetVisibility ? { ...pc.sheetVisibility, playerIds: [...(pc.sheetVisibility.playerIds || [])] }
                                       : { mode: 'all', playerIds: [] };
  let secretsList = Array.isArray(pc.secretsList)
    ? pc.secretsList.map(s => ({ ...s, visibility: { ...s.visibility, playerIds: [...(s.visibility?.playerIds || [])] } }))
    : (pc.secrets ? [{ id: '1', text: pc.secrets, visibility: { mode: 'hidden', playerIds: [] } }] : []);
  let pendingImageUrl = pc.imageUrl || null;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function visButtons(mode, prefix) {
    return `<button type="button" class="pc-vis-btn ${mode==='hidden'?'active':''}" data-prefix="${prefix}" data-mode="hidden">🔒 Só eu</button>
            <button type="button" class="pc-vis-btn ${mode==='specific'?'active':''}" data-prefix="${prefix}" data-mode="specific">👁 Específicos</button>
            <button type="button" class="pc-vis-btn ${mode==='all'?'active':''}" data-prefix="${prefix}" data-mode="all">🌐 Todos</button>`;
  }

  function playerChecks(selectedIds, name) {
    if (!otherPlayers.length) return `<span class="pc-no-players">Nenhum outro jogador ainda.</span>`;
    return otherPlayers.map(p =>
      `<label class="pc-player-check-label">
        <input type="checkbox" class="pc-player-check" data-name="${name}" data-uid="${p.uid}" ${selectedIds.includes(p.uid)?'checked':''}>
        ${escHtml(p.displayName)}
      </label>`
    ).join('');
  }

  const portraitHtml = pendingImageUrl
    ? `<img class="pc-portrait-img" id="pc-portrait-img" src="${pendingImageUrl}" alt="">`
    : `<div class="pc-portrait-placeholder" id="pc-portrait-img">${(pc.name||'?').charAt(0)}</div>`;

  // ── Render shell ─────────────────────────────────────────────────────────
  container.innerHTML = `<div class="my-char-container">
    <div class="my-char-header">
      <div class="my-char-title">Meu Personagem</div>
      <div class="my-char-subtitle">Preencha sua ficha e controle o que cada jogador pode ver</div>
    </div>
    <form class="my-char-form" id="my-char-form">

      <div class="pc-hero">
        <div class="pc-portrait-wrap">
          ${portraitHtml}
          <input type="file" id="pc-img-file" accept="image/*" style="display:none">
          <label class="pc-img-btn" for="pc-img-file">📷 Alterar foto</label>
          <div class="pc-img-uploading" id="pc-img-uploading" style="display:none">Enviando...</div>
        </div>
        <div class="pc-basic-fields">
          <div class="my-char-field">
            <label>Nome do Personagem</label>
            <input class="my-char-input pc-name-input" name="name" value="${escHtml(pc.name||'')}" placeholder="Nome do seu personagem">
          </div>
          <div class="my-char-row">
            <div class="my-char-field"><label>Raça</label>
              <input class="my-char-input" name="race" value="${escHtml(pc.race||'')}" placeholder="Ex: Humano, Elfo...">
            </div>
            <div class="my-char-field"><label>Classe</label>
              <input class="my-char-input" name="charClass" value="${escHtml(pc.charClass||'')}" placeholder="Ex: Guerreiro, Mago...">
            </div>
          </div>
          <div class="my-char-field"><label>Antecedente</label>
            <input class="my-char-input" name="background" value="${escHtml(pc.background||'')}" placeholder="Ex: Soldado, Sábio...">
          </div>
        </div>
      </div>

      <div class="pc-section">
        <div class="pc-section-title">Aparência</div>
        <textarea class="my-char-textarea" name="appearance" rows="3"
          placeholder="Como seu personagem parece, o que as pessoas notam ao vê-lo...">${escHtml(pc.appearance||'')}</textarea>
      </div>

      <div class="pc-section">
        <div class="pc-section-title">Personalidade &amp; Motivações</div>
        <textarea class="my-char-textarea" name="personality" rows="4"
          placeholder="O que quer, teme, acredita, como age sob pressão...">${escHtml(pc.personality||'')}</textarea>
      </div>

      <div class="pc-section">
        <div class="pc-section-title">História do Personagem</div>
        <textarea class="my-char-textarea" name="history" rows="6"
          placeholder="De onde veio, o que viveu, o que o moldou...">${escHtml(pc.history||'')}</textarea>
      </div>

      <!-- VISIBILIDADE DA FICHA -->
      <div class="pc-section">
        <div class="pc-section-title">Quem pode ver minha ficha</div>
        <div class="pc-vis-row" id="sheet-vis-btns">${visButtons(sheetVis.mode,'sheet')}</div>
        <div class="pc-vis-players-wrap${sheetVis.mode==='specific'?'':' pc-hidden'}" id="sheet-vis-players">
          ${playerChecks(sheetVis.playerIds,'sheet')}
        </div>
      </div>

      <div class="pc-save-bar">
        <button class="my-char-save-btn" type="submit" id="pc-save-btn">Salvar Ficha</button>
        <span class="my-char-saved-msg" id="my-char-saved-msg"></span>
      </div>

      <!-- SEGREDOS -->
      <div class="pc-section pc-section-private">
        <div class="pc-private-banner">🔒 Segredos — você decide quem pode ver cada um</div>
        <div id="pc-secrets-list"></div>
        <button type="button" class="pc-add-secret-btn" id="pc-add-secret">+ Adicionar Segredo</button>
      </div>

    </form>
    <div id="other-players-chars"></div>
  </div>`;

  // ── Render secrets list ───────────────────────────────────────────────────
  function renderSecrets() {
    const list = document.getElementById('pc-secrets-list');
    if (!list) return;
    if (!secretsList.length) {
      list.innerHTML = `<div class="pc-secrets-empty">Nenhum segredo adicionado ainda.</div>`;
      return;
    }
    list.innerHTML = secretsList.map((s, i) => {
      const vis = s.visibility || { mode: 'hidden', playerIds: [] };
      return `<div class="pc-secret-item" data-idx="${i}">
        <div class="pc-secret-head">
          <span class="pc-secret-num">Segredo ${i+1}</span>
          <button type="button" class="pc-secret-del" data-idx="${i}">✕ Remover</button>
        </div>
        <textarea class="my-char-textarea pc-secret-text" data-idx="${i}" rows="3"
          placeholder="Descreva o segredo...">${escHtml(s.text||'')}</textarea>
        <div class="pc-secret-vis-row">
          <span class="pc-secret-vis-label">Quem pode ver este segredo:</span>
          <div class="pc-vis-row" id="secret-vis-btns-${i}">${visButtons(vis.mode,'secret-'+i)}</div>
        </div>
        <div class="pc-vis-players-wrap${vis.mode==='specific'?'':' pc-hidden'}" id="secret-vis-players-${i}">
          ${playerChecks(vis.playerIds||[],'secret-'+i)}
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.pc-secret-text').forEach(ta =>
      ta.addEventListener('input', () => { secretsList[+ta.dataset.idx].text = ta.value; }));

    list.querySelectorAll('.pc-secret-del').forEach(btn =>
      btn.addEventListener('click', () => { secretsList.splice(+btn.dataset.idx,1); renderSecrets(); }));

    wireVisButtons(list);
    wirePlayerChecks(list);
  }

  // ── Visibility wiring helpers ─────────────────────────────────────────────
  function wireVisButtons(root) {
    root.querySelectorAll('.pc-vis-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const prefix = btn.dataset.prefix;
        const mode   = btn.dataset.mode;
        const row    = btn.closest('.pc-vis-row') || document.getElementById(`${prefix}-vis-btns`) || document.getElementById('sheet-vis-btns');
        row.querySelectorAll('.pc-vis-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

        if (prefix === 'sheet') {
          sheetVis.mode = mode;
          document.getElementById('sheet-vis-players').classList.toggle('pc-hidden', mode !== 'specific');
        } else if (prefix.startsWith('secret-')) {
          const idx = +prefix.split('-')[1];
          secretsList[idx].visibility.mode = mode;
          document.getElementById(`secret-vis-players-${idx}`).classList.toggle('pc-hidden', mode !== 'specific');
        }
      });
    });
  }

  function wirePlayerChecks(root) {
    root.querySelectorAll('.pc-player-check').forEach(chk => {
      chk.addEventListener('change', () => {
        const uid  = chk.dataset.uid;
        const name = chk.dataset.name;
        let arr;
        if (name === 'sheet') {
          arr = sheetVis.playerIds;
        } else if (name.startsWith('secret-')) {
          const idx = +name.split('-')[1];
          arr = secretsList[idx].visibility.playerIds;
        }
        if (!arr) return;
        if (chk.checked) { if (!arr.includes(uid)) arr.push(uid); }
        else { const i = arr.indexOf(uid); if (i !== -1) arr.splice(i,1); }
      });
    });
  }

  renderSecrets();
  wireVisButtons(container);
  wirePlayerChecks(container);

  // ── Add secret ────────────────────────────────────────────────────────────
  document.getElementById('pc-add-secret').addEventListener('click', () => {
    secretsList.push({ id: Date.now().toString(), text: '', visibility: { mode: 'hidden', playerIds: [] } });
    renderSecrets();
    wireVisButtons(document.getElementById('pc-secrets-list'));
    wirePlayerChecks(document.getElementById('pc-secrets-list'));
  });

  // ── Image upload ──────────────────────────────────────────────────────────
  document.getElementById('pc-img-file').addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    const up = document.getElementById('pc-img-uploading');
    up.style.display = 'block';
    try {
      const url = await uploadToCloudinary(file);
      pendingImageUrl = url;
      document.getElementById('pc-portrait-img').outerHTML =
        `<img class="pc-portrait-img" id="pc-portrait-img" src="${url}" alt="">`;
    } catch { alert('Erro ao enviar imagem. Tente novamente.'); }
    finally { up.style.display = 'none'; }
  });

  // ── Save ──────────────────────────────────────────────────────────────────
  document.getElementById('my-char-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('pc-save-btn');
    btn.disabled = true; btn.textContent = 'Salvando...';
    const fd = new FormData(e.target);
    const charData = { sheetVisibility: sheetVis, secretsList };
    fd.forEach((v, k) => { charData[k] = v.trim(); });
    if (pendingImageUrl) charData.imageUrl = pendingImageUrl;
    try {
      await updateDoc(doc(db, 'users', STATE.user.uid), { playerCharacter: charData });
      STATE.profile.playerCharacter = charData;
      const msg = document.getElementById('my-char-saved-msg');
      msg.textContent = '✓ Ficha salva!';
      setTimeout(() => { msg.textContent = ''; }, 3000);
    } finally { btn.disabled = false; btn.textContent = 'Salvar Ficha'; }
  });

  // ── Load other players (async, non-blocking) ──────────────────────────────
  buildAllPlayersCharHtml().then(html => {
    const el = document.getElementById('other-players-chars');
    if (el) el.innerHTML = html;
  }).catch(() => {});
}

async function buildAllPlayersCharHtml() {
  const myUid = STATE.user.uid;
  const snap  = await getDocs(collection(db, 'users'));
  const players = snap.docs
    .map(d => ({ uid: d.id, ...d.data() }))
    .filter(p => p.role === 'player' && p.playerCharacter?.name && p.uid !== myUid);

  // Filter by sheetVisibility
  const visible = players.filter(p => {
    const vis = p.playerCharacter.sheetVisibility;
    if (!vis || vis.mode === 'all') return true;
    if (vis.mode === 'specific') return (vis.playerIds||[]).includes(myUid);
    return false;
  });

  if (!visible.length) return '';

  const items = visible.map(p => {
    const pc = p.playerCharacter;
    const portrait = pc.imageUrl
      ? `<img class="pcc-portrait" src="${escHtml(pc.imageUrl)}" alt="" onerror="this.style.display='none'">`
      : `<div class="pcc-portrait-ph">${escHtml((pc.name||'?').charAt(0))}</div>`;

    // Visible secrets
    const sharedSecrets = (pc.secretsList||[]).filter(s => {
      const v = s.visibility;
      if (!v || v.mode === 'all') return true;
      if (v.mode === 'specific') return (v.playerIds||[]).includes(myUid);
      return false;
    });
    const secretsHtml = sharedSecrets.length
      ? `<div class="pcc-secrets-block">
          <div class="pcc-secrets-label">Segredos compartilhados</div>
          ${sharedSecrets.map(s => `<div class="pcc-secret-item">🔒 ${escHtml(s.text)}</div>`).join('')}
         </div>`
      : '';

    return `<div class="player-char-card">
      ${portrait}
      <div class="pcc-body">
        <div class="player-char-player">Jogador: ${escHtml(p.displayName)}</div>
        <div class="player-char-name">${escHtml(pc.name)}</div>
        <div class="player-char-details">
          ${[pc.race, pc.charClass, pc.background].filter(Boolean).map(escHtml).join(' · ')}
          ${pc.appearance ? `<div class="pcc-appearance">${escHtml(pc.appearance)}</div>` : ''}
        </div>
        ${secretsHtml}
      </div>
    </div>`;
  }).join('');

  return `<div class="all-chars-section">
    <div class="all-chars-title">Personagens dos Outros Jogadores</div>
    ${items}
  </div>`;
}

// ── MODAL ─────────────────────────────────────────────────────────────────────
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

  // Wire up edit button for master
  const editBtn = document.getElementById('modal-edit-btn');
  if (editBtn) {
    editBtn.innerHTML = '✏ Editar';
    editBtn.onclick = () => openEditMode(id, type);
  }

  updateBreadcrumb();
  attachModalEvents();
  attachVisibilityEvents();
  attachAnnotationEvents();
  if (type === 'character') attachSecretVisEvents(id);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal-panel').classList.remove('open');
  STATE.modal.stack   = [];
  STATE.modal.current = null;
}

function modalBack() {
  if (!STATE.modal.stack.length) return;
  const prev = STATE.modal.stack.pop();
  STATE.modal.current = prev;
  openModal(prev.id, prev.type, false);
}

function updateBreadcrumb() {
  const bc      = document.getElementById('modal-breadcrumb');
  const backBtn = document.getElementById('modal-back-btn');
  const trail   = [...STATE.modal.stack, STATE.modal.current];

  bc.innerHTML = trail.map((item, i) => {
    const name = item ? getEntityName(item.id, item.type) : '';
    const isCurr = i === trail.length - 1;
    return `<span class="bc-item${isCurr ? ' current' : ''}" data-idx="${i}">${name}</span>` +
      (isCurr ? '' : '<span class="bc-sep">›</span>');
  }).join('');

  backBtn.disabled = STATE.modal.stack.length === 0;
  bc.querySelectorAll('.bc-item:not(.current)').forEach(el => {
    el.addEventListener('click', () => {
      const idx    = parseInt(el.dataset.idx);
      const target = [...STATE.modal.stack, STATE.modal.current][idx];
      STATE.modal.stack   = STATE.modal.stack.slice(0, idx);
      STATE.modal.current = target;
      openModal(target.id, target.type, false);
    });
  });
}

function attachModalEvents() {
  document.getElementById('modal-body').querySelectorAll('[data-modal-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openModal(el.dataset.modalId, el.dataset.modalType);
    });
  });

  // Lightbox: click on character portrait to enlarge
  document.getElementById('modal-body').querySelectorAll('[data-lightbox]').forEach(img => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', e => {
      e.stopPropagation();
      openLightbox(img.dataset.lightbox);
    });
  });
}

function openLightbox(src) {
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.innerHTML = `<div class="lb-backdrop"></div><img class="lb-img" alt="Retrato">`;
    document.body.appendChild(lb);
    lb.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
  }
  lb.querySelector('.lb-img').src = src;
  lb.classList.add('lb-open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (lb) lb.classList.remove('lb-open');
  document.body.style.overflow = '';
}

function buildModalContent(id, type) {
  return ({
    character: buildCharModalContent,
    location:  buildLocationModalContent,
    event:     buildEventModalContent,
    faction:   buildFactionModalContent,
  })[type]?.(id) || '';
}

// ── MODAL: CHARACTER ──────────────────────────────────────────────────────────
function buildCharModalContent(id) {
  const c = getCharById(id);
  if (!c) return '';

  const rels = STATE.data.relations.filter(r =>
    (r.sourceId === id && r.sourceType === 'character') ||
    (r.targetId === id && r.targetType === 'character')
  ).filter(r => {
    if (!STATE.isMaster && r.secret) return false;
    const otherId   = r.sourceId === id ? r.targetId   : r.sourceId;
    const otherType = r.sourceId === id ? r.targetType  : r.sourceType;
    return getEntityName(otherId, otherType) !== otherId;
  });

  const relItems = rels.map(r => {
    const isSource     = r.sourceId === id;
    const otherId      = isSource ? r.targetId   : r.sourceId;
    const otherType    = isSource ? r.targetType  : r.sourceType;
    const displayLabel = isSource ? (r.label || '') : (r.labelTo || r.label || '');
    const color = relTypeColor(r.type);
    return `<div class="modal-relation-tag" data-modal-id="${otherId}" data-modal-type="${otherType}">
      <div class="rel-type-indicator" style="background:${color}"></div>
      <span class="rel-target-name">${getEntityName(otherId, otherType)}</span>
      <span class="rel-label-text">${displayLabel}</span>
      ${r.secret && STATE.isMaster ? '<span title="Relação secreta" style="opacity:.6;">🔒</span>' : ''}
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

  const _imgSrc = charImgSrc(c);
  const imgHtml = _imgSrc
    ? `<div class="modal-char-avatar modal-char-avatar-clickable" title="Clique para ampliar">
         <img src="${_imgSrc}" alt="${c.name}" data-lightbox="${_imgSrc}"
           onerror="this.parentElement.innerHTML='<div class=\\'modal-char-avatar-placeholder\\'>${c.name.charAt(0)}</div>'">
       </div>`
    : `<div class="modal-char-avatar"><div class="modal-char-avatar-placeholder">${c.name.charAt(0)}</div></div>`;

  return `
    ${buildVisibilitySection(c, 'characters')}
    <div class="modal-char-hero">
      ${imgHtml}
      <div class="modal-char-info">
        <div class="modal-char-name">${c.name}</div>
        <div class="modal-char-role">${c.role || ''}</div>
        <div class="badges">${statusBadgeHtml(c.status)} ${factionBadgeHtml(c.faction)}</div>
      </div>
    </div>
    ${c.description ? `<div class="modal-section"><div class="modal-section-title">Descrição Pública</div><div class="modal-section-text">${c.description}</div></div>` : ''}
    ${c.personality ? `<div class="modal-section"><div class="modal-section-title">Personalidade</div><div class="modal-section-text">${c.personality}</div></div>` : ''}
    ${buildCharSecretsHtml(c)}
    ${relItems ? `<div class="modal-section"><div class="modal-section-title">Relações</div><div class="modal-relations-list">${relItems}</div></div>` : ''}
    ${locItems ? `<div class="modal-section"><div class="modal-section-title">Locais Associados</div><div class="modal-link-list">${locItems}</div></div>` : ''}
    ${eventItems ? `<div class="modal-section"><div class="modal-section-title">Aparece nos Eventos</div><div class="modal-link-list">${eventItems}</div></div>` : ''}
    ${buildAnnotationsSection(id, 'character')}
  `;
}

// ── MODAL: LOCATION ───────────────────────────────────────────────────────────
function buildLocationModalContent(id) {
  const l = getLocationById(id);
  if (!l) return '';

  const controller = getCharById(l.controlledBy);
  const controlText = controller ? controller.name : (getFactionById(l.controlledBy)?.name || l.controlledBy || '—');
  const controlId   = controller ? l.controlledBy : null;
  const controlType = controller ? 'character' : (getFactionById(l.controlledBy) ? 'faction' : null);

  const poiHtml    = (l.pointsOfInterest || []).map(p => `<li class="poi-item">${p}</li>`).join('');
  const charItems  = (l.characters || []).map(cid => {
    const c = getCharById(cid);
    return c ? `<div class="modal-link-item" data-modal-id="${cid}" data-modal-type="character">${c.name}<span class="link-label-text">${c.role || ''}</span></div>` : '';
  }).join('');
  const eventItems = (l.events || []).map(eid => {
    const ev = getEventById(eid);
    return ev ? `<div class="modal-link-item" data-modal-id="${eid}" data-modal-type="event">${ev.name}</div>` : '';
  }).join('');

  return `
    ${buildVisibilitySection(l, 'locations')}
    ${l.imageUrl ? `<div class="modal-location-img-wrap"><img class="modal-location-img" src="${l.imageUrl}" alt="${l.name}" onerror="this.parentElement.remove()"></div>` : ''}
    <div class="modal-location-hero">
      <div class="modal-location-name">${l.name}</div>
      <div class="modal-location-subtitle">${l.subtitle || ''}</div>
      <div class="badges"><span class="location-type-badge">${l.type || ''}</span> ${factionBadgeHtml(l.faction)}</div>
      <div style="margin-top:8px;font-size:13px;color:var(--text-secondary);font-style:italic;">${l.tone || ''}</div>
      ${controlText ? `<div style="margin-top:6px;font-size:12px;color:var(--text-muted);">Controlado por: ${controlId && controlType ? `<span class="tag-chip" data-modal-id="${controlId}" data-modal-type="${controlType}" style="cursor:pointer;">${controlText}</span>` : controlText}</div>` : ''}
    </div>
    ${l.description ? `<div class="modal-section"><div class="modal-section-title">Descrição</div><div class="modal-section-text">${l.description}</div></div>` : ''}
    ${poiHtml ? `<div class="modal-section"><div class="modal-section-title">Pontos de Interesse</div><ul class="poi-list">${poiHtml}</ul></div>` : ''}
    ${hasSecrets(l) ? `<div class="modal-section secrets-section"><div class="modal-secrets"><div class="modal-section-title">🔒 Segredos do Mestre</div><div class="modal-section-text">${l.secrets}</div></div></div>` : ''}
    ${charItems ? `<div class="modal-section"><div class="modal-section-title">Personagens Associados</div><div class="modal-link-list">${charItems}</div></div>` : ''}
    ${eventItems ? `<div class="modal-section"><div class="modal-section-title">Eventos que Ocorreram Aqui</div><div class="modal-link-list">${eventItems}</div></div>` : ''}
    ${buildAnnotationsSection(id, 'location')}
  `;
}

// ── MODAL: EVENT ──────────────────────────────────────────────────────────────
function buildEventModalContent(id) {
  const e = getEventById(id);
  if (!e) return '';

  const loc      = e.location ? getLocationById(e.location) : null;
  const charItems = (e.characters || []).map(cid => {
    const c = getCharById(cid);
    return c ? `<div class="modal-link-item" data-modal-id="${cid}" data-modal-type="character">${c.name}</div>` : '';
  }).join('');
  const relEventItems = (e.relatedEvents || []).map(eid => {
    const ev = getEventById(eid);
    return ev ? `<div class="modal-link-item" data-modal-id="${eid}" data-modal-type="event">${ev.name}</div>` : '';
  }).join('');

  return `
    ${buildVisibilitySection(e, 'events')}
    <div class="modal-location-hero">
      <div class="event-period" style="margin-bottom:4px;">${e.period || ''}</div>
      <div class="modal-location-name">${e.name}</div>
      <div style="margin-top:8px;">${scaleBadgeHtml(e.scale)}</div>
    </div>
    <div class="modal-section"><div class="modal-section-title">Descrição Completa</div><div class="modal-section-text">${e.description || ''}</div></div>
    ${hasSecrets(e) ? `<div class="modal-section secrets-section"><div class="modal-secrets"><div class="modal-section-title">🔒 Segredos do Mestre</div><div class="modal-section-text">${e.secrets}</div></div></div>` : ''}
    ${charItems ? `<div class="modal-section"><div class="modal-section-title">Personagens Presentes</div><div class="modal-link-list">${charItems}</div></div>` : ''}
    ${loc ? `<div class="modal-section"><div class="modal-section-title">Local do Evento</div><div class="modal-link-list"><div class="modal-link-item" data-modal-id="${loc.id}" data-modal-type="location">${loc.name}</div></div></div>` : ''}
    ${relEventItems ? `<div class="modal-section"><div class="modal-section-title">Eventos Relacionados</div><div class="modal-link-list">${relEventItems}</div></div>` : ''}
    ${buildAnnotationsSection(id, 'event')}
  `;
}

// ── MODAL: FACTION ────────────────────────────────────────────────────────────
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

  const rels = STATE.data.relations.filter(r =>
    (r.sourceId === id && r.sourceType === 'faction') ||
    (r.targetId === id && r.targetType === 'faction')
  );
  const relItems = rels.map(r => {
    const isSource     = r.sourceId === id;
    const otherId      = isSource ? r.targetId   : r.sourceId;
    const otherType    = isSource ? r.targetType  : r.sourceType;
    const displayLabel = isSource ? (r.label || '') : (r.labelTo || r.label || '');
    const color = relTypeColor(r.type);
    return `<div class="modal-relation-tag" data-modal-id="${otherId}" data-modal-type="${otherType}">
      <div class="rel-type-indicator" style="background:${color}"></div>
      <span class="rel-target-name">${getEntityName(otherId, otherType)}</span>
      <span class="rel-label-text">${displayLabel}</span>
      ${r.secret && STATE.isMaster ? '<span title="Relação secreta" style="opacity:.6;">🔒</span>' : ''}
    </div>`;
  }).join('');

  return `
    ${buildVisibilitySection(f, 'factions')}
    <div class="modal-location-hero" style="border-left:3px solid ${f.color};">
      <div style="display:flex;gap:12px;align-items:center;">
        <span style="font-size:36px;">${f.symbol || '◆'}</span>
        <div>
          <div class="modal-location-name" style="color:${f.color};">${f.name}</div>
          <div class="faction-type">${f.type || ''}</div>
        </div>
      </div>
    </div>
    <div class="modal-section"><div class="modal-section-title">Descrição</div><div class="modal-section-text">${f.description || ''}</div></div>
    ${hasSecrets(f) ? `<div class="modal-section secrets-section"><div class="modal-secrets"><div class="modal-section-title">🔒 Segredos do Mestre</div><div class="modal-section-text">${f.secrets}</div></div></div>` : ''}
    ${memberItems ? `<div class="modal-section"><div class="modal-section-title">Membros</div><div class="modal-link-list">${memberItems}</div></div>` : ''}
    ${locItems ? `<div class="modal-section"><div class="modal-section-title">Locais Controlados</div><div class="modal-link-list">${locItems}</div></div>` : ''}
    ${relItems ? `<div class="modal-section"><div class="modal-section-title">Relações</div><div class="modal-relations-list">${relItems}</div></div>` : ''}
    ${buildAnnotationsSection(id, 'faction')}
  `;
}

// ── GLOBAL SEARCH ─────────────────────────────────────────────────────────────
function buildSearchIndex() {
  const idx = [];
  STATE.data.characters.forEach(c => idx.push({ id: c.id, type: 'character', name: c.name, sub: c.role }));
  STATE.data.locations.forEach(l => idx.push({ id: l.id, type: 'location', name: l.name, sub: l.subtitle }));
  STATE.data.events.forEach(e => idx.push({ id: e.id, type: 'event', name: e.name, sub: e.period }));
  STATE.data.factions.forEach(f => idx.push({ id: f.id, type: 'faction', name: f.name, sub: f.type }));
  return idx;
}

function setupSearch() {
  const overlay = document.getElementById('global-search-overlay');
  const input   = document.getElementById('global-search-input');
  const results = document.getElementById('global-search-results');

  document.getElementById('search-toggle').addEventListener('click', () => {
    overlay.classList.add('open');
    setTimeout(() => input.focus(), 50);
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
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
    const hits = buildSearchIndex().filter(i => i.name.toLowerCase().includes(q)).slice(0, 12);
    if (!hits.length) { results.innerHTML = '<div class="search-no-results">Nenhum resultado.</div>'; return; }
    results.innerHTML = hits.map(h => `
      <div class="search-result-item" data-id="${h.id}" data-type="${h.type}">
        <span class="search-result-type type-${h.type}">${{character:'Personagem',location:'Local',event:'Evento',faction:'Facção'}[h.type]}</span>
        <span class="search-result-name">${h.name}</span>
        <span class="search-result-sub">${h.sub || ''}</span>
      </div>`).join('');
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

const GRAPH_TYPE_LABEL = { character: 'Personagem', location: 'Local', event: 'Evento', faction: 'Facção' };
const GRAPH_GLYPH      = { location: '🏝', event: '📜' };

// Imagem do nó: retrato do personagem, ou imageUrl de qualquer entidade que tenha
function nodeImgSrc(d) {
  if (d.type === 'character') {
    const c = getCharById(d.id);
    return c ? charImgSrc(c) : null;
  }
  const item = getItemById(d.id, d.type);
  return item?.imageUrl || null;
}

// Conteúdo do nó quando não há imagem: inicial (personagem), símbolo (facção) ou ícone
function appendNodeGlyph(node, d, r) {
  if (d.type === 'character') {
    node.append('text').attr('class', 'node-initial')
      .attr('text-anchor', 'middle').attr('dy', '.36em')
      .attr('font-size', Math.round(r * 0.95))
      .text((d.name || '?').charAt(0).toUpperCase());
    return;
  }
  const glyph = d.type === 'faction'
    ? (getFactionById(d.id)?.symbol || '⚑')
    : (GRAPH_GLYPH[d.type] || '◆');
  node.append('text').attr('class', 'node-glyph')
    .attr('text-anchor', 'middle').attr('dy', '.36em')
    .attr('font-size', Math.round(r * 1.05))
    .text(glyph);
}

function graphTooltipSub(d) {
  const item = getItemById(d.id, d.type);
  if (!item) return '';
  return { character: item.role, location: item.subtitle, event: item.period, faction: item.type }[d.type] || '';
}

function renderGraph() {
  const wrapper = document.getElementById('graph-wrapper');
  const svg     = document.getElementById('graph-svg');
  svg.innerHTML = '';
  if (graphSimulation) graphSimulation.stop();

  const W = wrapper.clientWidth;
  const H = wrapper.clientHeight;
  const svgEl = d3.select('#graph-svg').attr('viewBox', `0 0 ${W} ${H}`);

  const defs = svgEl.append('defs');
  ['normal','secret','romantic','political','family','historical'].forEach(type => {
    defs.append('marker')
      .attr('id', `arrow-${type}`).attr('viewBox', '0 -5 10 10')
      .attr('refX', 8).attr('refY', 0).attr('markerWidth', 7).attr('markerHeight', 7)
      .attr('orient', 'auto').append('path').attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', relTypeColor(type)).attr('fill-opacity', 0.9);
  });

  const shadow = defs.append('filter').attr('id', 'node-shadow')
    .attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
  shadow.append('feDropShadow')
    .attr('dx', 0).attr('dy', 2).attr('stdDeviation', 3)
    .attr('flood-color', '#000').attr('flood-opacity', 0.55);

  const g    = svgEl.append('g');
  const zoom = d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => g.attr('transform', e.transform));
  svgEl.call(zoom);

  // Controles de zoom (reatribuídos a cada render para usar o zoom atual)
  const zoomInBtn    = document.getElementById('graph-zoom-in');
  const zoomOutBtn   = document.getElementById('graph-zoom-out');
  const zoomResetBtn = document.getElementById('graph-zoom-reset');
  if (zoomInBtn)    zoomInBtn.onclick    = () => svgEl.transition().duration(250).call(zoom.scaleBy, 1.35);
  if (zoomOutBtn)   zoomOutBtn.onclick   = () => svgEl.transition().duration(250).call(zoom.scaleBy, 1 / 1.35);
  if (zoomResetBtn) zoomResetBtn.onclick = () => svgEl.transition().duration(400).call(zoom.transform, d3.zoomIdentity);

  // Tooltip flutuante
  let tip = wrapper.querySelector('.graph-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'graph-tooltip';
    wrapper.appendChild(tip);
  }
  tip.classList.remove('visible');

  const { character, location, event, faction } = STATE.graphFilters;
  const nodes   = [];
  const nodeMap = {};
  const addNode = (id, type, name) => { if (!nodeMap[id]) { nodeMap[id] = { id, type, name, degree: 0 }; nodes.push(nodeMap[id]); } };

  if (character) STATE.data.characters.forEach(c => addNode(c.id, 'character', c.name));
  if (location)  STATE.data.locations.forEach(l => addNode(l.id, 'location', l.name));
  if (event)     STATE.data.events.forEach(e => addNode(e.id, 'event', e.name));
  if (faction)   STATE.data.factions.forEach(f => addNode(f.id, 'faction', f.name));

  const links = STATE.data.relations
    .filter(r => nodeMap[r.sourceId] && nodeMap[r.targetId])
    .map(r => ({ source: r.sourceId, target: r.targetId, label: r.label, type: r.type || 'historical', secret: r.secret || false }));

  links.forEach(l => { if (nodeMap[l.source]) nodeMap[l.source].degree++; if (nodeMap[l.target]) nodeMap[l.target].degree++; });

  const NODE_COLOR = { character: '#cfac6e', location: '#5a8ab0', event: '#7a9a6a', faction: '#9a5a5a' };
  const getNodeColor = d => d.type === 'faction' ? (getFactionById(d.id)?.color || NODE_COLOR.faction) : (NODE_COLOR[d.type] || '#9a5a5a');
  const radiusOf = d => Math.min(34, Math.max(17, 13 + d.degree * 2));

  graphSimulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(130))
    .force('charge', d3.forceManyBody().strength(-340))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide().radius(d => radiusOf(d) + 14));

  const linkG  = g.append('g').attr('class', 'links');
  const linkEl = linkG.selectAll('.graph-link').data(links).enter()
    .append('line').attr('class', 'graph-link')
    .attr('stroke', d => relTypeColor(d.type))
    .attr('stroke-dasharray', d => d.secret ? '5,4' : null)
    .style('opacity', 0.55)
    .attr('marker-end', d => `url(#arrow-${d.type})`);

  const linkLabelEl = g.append('g').attr('class', 'link-labels').selectAll('.graph-link-label')
    .data(links).enter().append('text').attr('class', 'graph-link-label')
    .attr('text-anchor', 'middle').attr('dy', -5)
    .text(d => STATE.graphShowLabels ? d.label : '');

  const nodeG  = g.append('g').attr('class', 'nodes');
  const nodeEl = nodeG.selectAll('.graph-node').data(nodes).enter()
    .append('g').attr('class', 'graph-node').style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) graphSimulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) graphSimulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  // Halo externo suave na cor do tipo
  nodeEl.append('circle').attr('class', 'node-halo')
    .attr('r', d => radiusOf(d) + 7)
    .attr('fill', d => getNodeColor(d))
    .attr('opacity', 0.08);

  // Medalhão base com anel na cor do tipo/facção
  nodeEl.append('circle').attr('class', 'node-base')
    .attr('r', radiusOf)
    .attr('fill', '#0a1d31')
    .attr('stroke', d => getNodeColor(d))
    .attr('stroke-width', 2)
    .attr('filter', 'url(#node-shadow)');

  // Conteúdo: retrato recortado em círculo, ou inicial/símbolo/ícone
  nodeEl.each(function(d) {
    const node = d3.select(this);
    const r    = radiusOf(d);
    const img  = nodeImgSrc(d);
    if (img) {
      const clipId = `node-clip-${d.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
      defs.append('clipPath').attr('id', clipId)
        .append('circle').attr('r', r - 1.5);
      node.append('image')
        .attr('href', img)
        .attr('x', -(r - 1.5)).attr('y', -(r - 1.5))
        .attr('width', (r - 1.5) * 2).attr('height', (r - 1.5) * 2)
        .attr('preserveAspectRatio', 'xMidYMin slice')
        .attr('clip-path', `url(#${clipId})`)
        .on('error', function() { d3.select(this).remove(); appendNodeGlyph(node, d, r); });
    } else {
      appendNodeGlyph(node, d, r);
    }
  });

  // Cadeado sobre nós com relações secretas (visível só na visão do mestre)
  if (STATE.isMaster) {
    const secretIds = new Set();
    links.forEach(l => { if (l.secret) { secretIds.add(l.source.id || l.source); secretIds.add(l.target.id || l.target); } });
    nodeEl.filter(d => secretIds.has(d.id))
      .append('text').attr('class', 'node-secret-mark')
      .attr('text-anchor', 'middle')
      .attr('x', d => radiusOf(d) * 0.72)
      .attr('y', d => -radiusOf(d) * 0.72)
      .attr('font-size', 11)
      .attr('opacity', 0.85)
      .text('🔒');
  }

  nodeEl.append('text').attr('class', 'node-label')
    .attr('text-anchor', 'middle')
    .attr('dy', d => radiusOf(d) + 16)
    .text(d => d.name.length > 16 ? d.name.substring(0, 15) + '…' : d.name);

  nodeEl
    .on('mouseover', (e, d) => {
      const connected = new Set([d.id]);
      links.forEach(l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        if (sid === d.id) connected.add(tid);
        if (tid === d.id) connected.add(sid);
      });
      nodeEl.style('opacity', n => connected.has(n.id) ? 1 : 0.12);
      linkEl.style('opacity', l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        return (sid === d.id || tid === d.id) ? 0.95 : 0.04;
      });
      linkLabelEl.style('opacity', l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        return (sid === d.id || tid === d.id) ? 1 : 0.05;
      });

      const sub = graphTooltipSub(d);
      tip.innerHTML = `
        <span class="tip-type" style="color:${getNodeColor(d)}">${GRAPH_TYPE_LABEL[d.type] || d.type}</span>
        <div class="tip-name">${escHtml(d.name)}</div>
        ${sub ? `<div class="tip-sub">${escHtml(sub)}</div>` : ''}
        <div class="tip-deg">${d.degree} ${d.degree === 1 ? 'conexão' : 'conexões'} · clique para abrir</div>`;
      tip.classList.add('visible');
    })
    .on('mousemove', e => {
      const [x, y] = d3.pointer(e, wrapper);
      const flipX = x > wrapper.clientWidth - 260;
      tip.style.left = flipX ? `${x - 252}px` : `${x + 18}px`;
      tip.style.top  = `${Math.min(y + 14, wrapper.clientHeight - 110)}px`;
    })
    .on('mouseout', () => {
      nodeEl.style('opacity', 1);
      linkEl.style('opacity', 0.55);
      linkLabelEl.style('opacity', 1);
      tip.classList.remove('visible');
    })
    .on('click', (e, d) => { e.stopPropagation(); tip.classList.remove('visible'); openModal(d.id, d.type); });

  graphSimulation.on('tick', () => {
    // Apara as linhas na borda dos medalhões para a seta ficar visível
    linkEl.each(function(d) {
      const dx = d.target.x - d.source.x;
      const dy = d.target.y - d.source.y;
      const dist = Math.hypot(dx, dy) || 1;
      const sr = radiusOf(d.source) + 3;
      const tr = radiusOf(d.target) + 7;
      d3.select(this)
        .attr('x1', d.source.x + (dx / dist) * sr)
        .attr('y1', d.source.y + (dy / dist) * sr)
        .attr('x2', d.target.x - (dx / dist) * tr)
        .attr('y2', d.target.y - (dy / dist) * tr);
    });
    linkLabelEl.attr('x', d => (d.source.x + d.target.x) / 2).attr('y', d => (d.source.y + d.target.y) / 2);
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

// ── CLOUDINARY IMAGE UPLOAD ───────────────────────────────────────────────────
async function uploadToCloudinary(file) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  const res  = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: 'POST', body: fd,
  });
  if (!res.ok) throw new Error('Falha no upload para Cloudinary');
  const data = await res.json();
  return data.secure_url;
}

// ── EDIT SYSTEM ───────────────────────────────────────────────────────────────

function typeLabel(type) {
  return { character: 'Personagem', location: 'Local', event: 'Evento', faction: 'Facção' }[type] || type;
}

function typeCollName(type) {
  return { character: 'characters', location: 'locations', event: 'events', faction: 'factions' }[type];
}

function getItemById(id, type) {
  return { character: getCharById, location: getLocationById, event: getEventById, faction: getFactionById }[type]?.(id);
}

function generateId(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .substring(0, 40);
}

// ─── Open edit mode (view → form) ────────────────────────────────────────────
function openEditMode(id, type) {
  const item = getItemById(id, type) || {};
  document.getElementById('modal-body').innerHTML = buildEditForm(id, type, item);
  const editBtn = document.getElementById('modal-edit-btn');
  if (editBtn) {
    editBtn.innerHTML = '👁 Ver';
    editBtn.onclick = () => openModal(id, type, false);
  }
  attachEditFormEvents(id, type);
}

// ─── Open blank form for new item ────────────────────────────────────────────
function openNewItemModal(type) {
  STATE.modal.current = { id: '__new__', type };
  STATE.modal.stack   = [];
  const overlay = document.getElementById('modal-overlay');
  const panel   = document.getElementById('modal-panel');
  document.getElementById('modal-body').innerHTML = buildEditForm(null, type, {});
  overlay.classList.add('open');
  panel.classList.add('open');
  const editBtn = document.getElementById('modal-edit-btn');
  if (editBtn) editBtn.style.visibility = 'hidden';
  document.getElementById('modal-breadcrumb').innerHTML =
    `<span class="bc-item current">Novo ${typeLabel(type)}</span>`;
  document.getElementById('modal-back-btn').disabled = true;
  attachEditFormEvents(null, type);
}

// ─── Build edit form HTML ────────────────────────────────────────────────────
function buildEditForm(id, type, item) {
  const isNew = !id;
  const fields = {
    character: buildCharEditFields,
    location:  buildLocationEditFields,
    event:     buildEventEditFields,
    faction:   buildFactionEditFields,
  }[type]?.(item) || '';

  return `<div class="edit-form-container">
    <form id="edit-form" class="edit-form">
      ${fields}
      <div class="edit-form-actions">
        <button type="submit" class="edit-save-btn">${isNew ? '✚ Criar' : '✔ Salvar Alterações'}</button>
        <button type="button" class="edit-cancel-btn">Cancelar</button>
        ${!isNew ? `<button type="button" class="edit-delete-btn">🗑 Excluir ${typeLabel(type)}</button>` : ''}
      </div>
    </form>
  </div>`;
}

// ─── Per-type field builders ─────────────────────────────────────────────────
function factionOptions(selected = '') {
  return STATE.data.factions.map(f =>
    `<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${f.name}</option>`
  ).join('');
}

function characterOptions(selectedIds = []) {
  return STATE.data.characters.map(c =>
    `<option value="${c.id}" ${selectedIds.includes(c.id) ? 'selected' : ''}>${c.name}</option>`
  ).join('');
}

function editField(label, html) {
  return `<div class="edit-field"><label class="edit-label">${label}</label>${html}</div>`;
}

function editInput(name, value = '', placeholder = '') {
  return `<input class="edit-input" name="${name}" value="${escHtml(value)}" placeholder="${placeholder}">`;
}

function editTextarea(name, value = '', placeholder = '', rows = 3) {
  return `<textarea class="edit-textarea" name="${name}" placeholder="${placeholder}" rows="${rows}">${escHtml(value)}</textarea>`;
}

function buildCharEditFields(c = {}) {
  const imgSrc = c.imageUrl || (c.image ? `assets/images/characters/${c.image}` : '');
  const imgPreview = imgSrc
    ? `<img class="edit-img-preview" id="img-preview" src="${imgSrc}" alt="">`
    : `<div class="edit-img-placeholder" id="img-preview">Sem imagem</div>`;

  return `
    <div class="edit-form-section-title">Dados Básicos</div>
    <div class="edit-row">
      ${editField('Nome *', editInput('name', c.name, 'Nome do personagem'))}
      ${editField('Cargo / Papel', editInput('role', c.role, 'Ex: Rei, Comerciante...'))}
    </div>
    <div class="edit-row">
      ${editField('Status', `<select class="edit-select" name="status">
        ${['Vivo','Morto','Desaparecido'].map(s => `<option ${c.status===s?'selected':''}>${s}</option>`).join('')}
      </select>`)}
      ${editField('Facção', `<select class="edit-select" name="faction">
        <option value="">— Sem facção —</option>${factionOptions(c.faction)}
      </select>`)}
    </div>

    <div class="edit-form-section-title">Retrato</div>
    <div class="edit-field">
      <label class="edit-label">Imagem do personagem</label>
      <div class="edit-img-wrap">
        ${imgPreview}
        <div class="edit-img-controls">
          <input class="edit-file-input" type="file" id="img-file" accept="image/*">
          <label class="edit-file-label" for="img-file">📁 Escolher do PC</label>
          <div class="edit-img-separator">ou</div>
          ${editField('Cole uma URL de imagem', editInput('imageUrl', c.imageUrl || '', 'https://i.imgur.com/...'))}
        </div>
      </div>
    </div>

    <div class="edit-form-section-title">Descrição</div>
    ${editField('Descrição Pública', editTextarea('description', c.description, 'Como os jogadores descrevem este personagem...', 4))}
    ${editField('Personalidade', editTextarea('personality', c.personality, 'Traços, maneiras, forma de falar...', 3))}

    <div class="edit-form-section-title">Segredos do Mestre</div>
    <div id="char-secrets-editor"></div>
    <button type="button" class="edit-add-secret-btn">+ Adicionar Segredo</button>

    ${c.id ? `
    <div class="edit-form-section-title" style="margin-top:20px;">Relações com Personagens</div>
    <div id="rel-editor" class="rel-editor"></div>
    <button type="button" class="edit-add-rel-btn">+ Adicionar Relação</button>
    ` : `<div class="edit-form-section-title" style="margin-top:20px;">Relações</div>
    <div style="font-size:12px;color:#5a7a8a;padding:2px 0;">Salve o personagem primeiro para gerenciar relações.</div>`}
  `;
}

function buildLocationEditFields(l = {}) {
  const poi = (l.pointsOfInterest || []).join('\n');
  const imgSrc = l.imageUrl || '';
  const imgPreview = imgSrc
    ? `<img class="edit-img-preview" id="img-preview" src="${imgSrc}" alt="">`
    : `<div class="edit-img-placeholder" id="img-preview">Sem imagem</div>`;

  return `
    <div class="edit-form-section-title">Dados Básicos</div>
    <div class="edit-row">
      ${editField('Nome *', editInput('name', l.name, 'Nome do local'))}
      ${editField('Subtítulo', editInput('subtitle', l.subtitle, 'Ex: A Grande Capital'))}
    </div>
    <div class="edit-row">
      ${editField('Tipo', editInput('type', l.type, 'Ex: Ilha urbana, Capital imperial...'))}
      ${editField('Facção Controladora', `<select class="edit-select" name="faction">
        <option value="">— Nenhuma —</option>${factionOptions(l.faction)}
      </select>`)}
    </div>
    ${editField('Tom / Atmosfera', editInput('tone', l.tone, 'Como este local se sente...'))}
    <div class="edit-row edit-row-check">
      <label class="edit-checkbox-label">
        <input type="checkbox" name="featured" ${l.featured ? 'checked' : ''}> Local em destaque (card largo)
      </label>
    </div>

    <div class="edit-form-section-title">Imagem</div>
    <div class="edit-field">
      <label class="edit-label">Imagem do local</label>
      <div class="edit-img-wrap">
        ${imgPreview}
        <div class="edit-img-controls">
          <input class="edit-file-input" type="file" id="img-file" accept="image/*">
          <label class="edit-file-label" for="img-file">📁 Escolher do PC</label>
          <div class="edit-img-separator">ou</div>
          ${editField('Cole uma URL de imagem', editInput('imageUrl', l.imageUrl || '', 'https://i.imgur.com/...'))}
        </div>
      </div>
    </div>

    <div class="edit-form-section-title">Descrição</div>
    ${editField('Descrição Completa', editTextarea('description', l.description, 'Descreva este local...', 5))}
    ${editField('Pontos de Interesse (um por linha)', editTextarea('pointsOfInterest', poi, 'Ex: O Porto Principal — navios de guerra...', 4))}

    <div class="edit-form-section-title">Segredos do Mestre</div>
    ${editField('Segredos (apenas você vê)', editTextarea('secrets', l.secrets, 'Informações ocultas sobre este local...', 4))}
  `;
}

function buildEventEditFields(e = {}) {
  return `
    <div class="edit-form-section-title">Dados Básicos</div>
    ${editField('Nome *', editInput('name', e.name, 'Nome do evento'))}
    <div class="edit-row">
      ${editField('Período / Data', editInput('period', e.period, 'Ex: Há 500 anos, Era da Maré Alta...'))}
      ${editField('Escala', `<select class="edit-select" name="scale">
        ${['Mundial','Regional','Local','Pessoal'].map(s => `<option ${e.scale===s?'selected':''}>${s}</option>`).join('')}
      </select>`)}
    </div>
    ${editField('Ordem na timeline', `<input class="edit-input" name="order" type="number" value="${e.order||0}">`)}

    <div class="edit-form-section-title">Descrição</div>
    ${editField('Descrição Completa', editTextarea('description', e.description, 'O que aconteceu neste evento...', 5))}

    <div class="edit-form-section-title">Segredos do Mestre</div>
    ${editField('Segredos (apenas você vê)', editTextarea('secrets', e.secrets, 'A verdade por trás do evento...', 4))}
  `;
}

function buildFactionEditFields(f = {}) {
  const memberIds = f.members || [];
  return `
    <div class="edit-form-section-title">Dados Básicos</div>
    <div class="edit-row">
      ${editField('Nome *', editInput('name', f.name, 'Nome da facção'))}
      ${editField('Tipo', editInput('type', f.type, 'Ex: Império, Guilda, Família...'))}
    </div>
    <div class="edit-row">
      ${editField('Símbolo (emoji)', editInput('symbol', f.symbol, '⚓'))}
      ${editField('Cor (hex)', `<div class="edit-color-wrap">
        <input class="edit-color-picker" type="color" name="colorPicker" value="${f.color || '#5a8ab0'}">
        <input class="edit-input" name="color" value="${f.color || '#5a8ab0'}" placeholder="#5a8ab0" style="flex:1">
      </div>`)}
    </div>

    <div class="edit-form-section-title">Descrição</div>
    ${editField('Descrição', editTextarea('description', f.description, 'História, objetivos, estrutura da facção...', 4))}

    <div class="edit-form-section-title">Membros</div>
    <div class="edit-field">
      <label class="edit-label">Membros notáveis (Ctrl+clique para múltiplos)</label>
      <select class="edit-select edit-select-multi" name="members" multiple size="5">
        ${characterOptions(memberIds)}
      </select>
    </div>

    <div class="edit-form-section-title">Segredos do Mestre</div>
    ${editField('Segredos (apenas você vê)', editTextarea('secrets', f.secrets, 'O que esta facção esconde...', 4))}
  `;
}

// ─── Attach edit form events ──────────────────────────────────────────────────
function attachEditFormEvents(id, type) {
  const form = document.getElementById('edit-form');
  if (!form) return;

  // File input → preview
  const fileInput = document.getElementById('img-file');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        const p = document.getElementById('img-preview');
        if (p) p.outerHTML = `<img class="edit-img-preview" id="img-preview" src="${e.target.result}" alt="">`;
      };
      reader.readAsDataURL(file);
    });
  }

  // URL input → live preview
  const imgUrlInput = form.querySelector('[name="imageUrl"]');
  if (imgUrlInput) {
    imgUrlInput.addEventListener('input', () => {
      const url = imgUrlInput.value.trim();
      const p   = document.getElementById('img-preview');
      if (!p || fileInput?.files[0]) return;
      if (url) p.outerHTML = `<img class="edit-img-preview" id="img-preview" src="${url}" alt="" onerror="this.style.opacity='.3'">`;
      else     p.outerHTML = `<div class="edit-img-placeholder" id="img-preview">Sem imagem</div>`;
    });
  }

  // Sync color picker ↔ text input
  const colorPicker = form.querySelector('[name="colorPicker"]');
  const colorInput  = form.querySelector('[name="color"]');
  if (colorPicker && colorInput) {
    colorPicker.addEventListener('input', () => { colorInput.value = colorPicker.value; });
    colorInput.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(colorInput.value)) colorPicker.value = colorInput.value;
    });
  }

  // Relation editor (existing characters only)
  let relEdits = [];
  if (type === 'character' && id) {
    relEdits = STATE.data.relations
      .filter(r =>
        (r.sourceId === id && r.sourceType === 'character') ||
        (r.targetId === id && r.targetType === 'character')
      )
      .map(r => ({ ...r, _delete: false, _isNew: false }));

    function renderRelRows() {
      const editor = document.getElementById('rel-editor');
      if (!editor) return;
      const visible = relEdits.filter(r => !r._delete);
      if (!visible.length) { editor.innerHTML = ''; return; }
      editor.innerHTML =
        `<div class="rel-header">
          <span>Personagem</span>
          <span>Rótulo na minha ficha</span>
          <span>Rótulo na ficha deles</span>
          <span title="Visibilidade para jogadores">Vis.</span>
          <span></span>
        </div>` +
        visible.map(r => {
          const idx      = relEdits.indexOf(r);
          const isSource = r.sourceId === id || r._isNew;
          const otherId  = isSource ? r.targetId : r.sourceId;
          const myLabel    = isSource ? (r.label   || '') : (r.labelTo || '');
          const theirLabel = isSource ? (r.labelTo || '') : (r.label   || '');
          const isSecret   = !!r.secret;
          return `<div class="rel-row">
            <select class="edit-select rel-target" data-idx="${idx}">
              <option value="">— Selecionar —</option>
              ${STATE.data.characters.filter(c => c.id !== id)
                .map(c => `<option value="${c.id}" ${c.id === otherId ? 'selected' : ''}>${c.name}</option>`)
                .join('')}
            </select>
            <input class="edit-input rel-label-mine"   data-idx="${idx}" value="${escHtml(myLabel)}"    placeholder="Ex: mãe de...">
            <input class="edit-input rel-label-theirs" data-idx="${idx}" value="${escHtml(theirLabel)}" placeholder="Ex: filha de...">
            <button type="button" class="rel-vis-toggle ${isSecret ? 'rel-vis-secret' : 'rel-vis-public'}"
              data-idx="${idx}" title="${isSecret ? 'Secreto — só você vê (clique para tornar público)' : 'Visível para jogadores (clique para tornar secreto)'}">
              ${isSecret ? '🔒' : '🌐'}
            </button>
            <button type="button" class="rel-del-btn" data-idx="${idx}">✕</button>
          </div>`;
        }).join('');

      editor.querySelectorAll('.rel-vis-toggle').forEach(btn =>
        btn.addEventListener('click', () => {
          const r = relEdits[+btn.dataset.idx];
          r.secret = !r.secret;
          renderRelRows();
        }));
      editor.querySelectorAll('.rel-del-btn').forEach(btn =>
        btn.addEventListener('click', () => { relEdits[+btn.dataset.idx]._delete = true; renderRelRows(); }));
      editor.querySelectorAll('.rel-target').forEach(sel =>
        sel.addEventListener('change', () => {
          const r = relEdits[+sel.dataset.idx];
          r.targetId = sel.value; r.sourceId = id;
          r.sourceType = 'character'; r.targetType = 'character';
        }));
      editor.querySelectorAll('.rel-label-mine').forEach(inp =>
        inp.addEventListener('input', () => {
          const r = relEdits[+inp.dataset.idx];
          if (r.sourceId === id || r._isNew) r.label   = inp.value;
          else                               r.labelTo = inp.value;
        }));
      editor.querySelectorAll('.rel-label-theirs').forEach(inp =>
        inp.addEventListener('input', () => {
          const r = relEdits[+inp.dataset.idx];
          if (r.sourceId === id || r._isNew) r.labelTo = inp.value;
          else                               r.label   = inp.value;
        }));
    }

    renderRelRows();

    form.querySelector('.edit-add-rel-btn')?.addEventListener('click', () => {
      relEdits.push({
        _isNew: true, _delete: false,
        sourceId: id, sourceType: 'character',
        targetId: '', targetType: 'character',
        label: '', labelTo: '', secret: true,
      });
      renderRelRows();
    });
  }

  // ── Character secrets editor (master-controlled) ───────────────────────────
  let charSecretsList = [];
  if (type === 'character') {
    const existingChar = getCharById(id);
    charSecretsList = Array.isArray(existingChar?.secretsList)
      ? existingChar.secretsList.map(s => ({
          ...s,
          visibility: { ...(s.visibility || { mode: 'hidden', playerIds: [] }), playerIds: [...(s.visibility?.playerIds || [])] }
        }))
      : (existingChar?.secrets ? [{ id: '1', text: existingChar.secrets, visibility: { mode: 'hidden', playerIds: [] } }] : []);

    const allPlayers = STATE.players.filter(p => p.role === 'player');

    function csecVisButtons(mode, prefix) {
      return ['hidden','specific','all'].map(m =>
        `<button type="button" class="pc-vis-btn char-sec-vis-btn ${mode===m?'active':''}" data-prefix="${prefix}" data-mode="${m}">${
          m==='hidden'?'🔒 Oculto':m==='specific'?'👁 Específicos':'🌐 Todos'
        }</button>`).join('');
    }

    function csecPlayerChecks(selectedIds, prefix) {
      if (!allPlayers.length) return `<span class="pc-no-players">Sem jogadores cadastrados.</span>`;
      return allPlayers.map(p =>
        `<label class="pc-player-check-label">
          <input type="checkbox" class="pc-player-check" data-prefix="${prefix}" data-uid="${p.uid}"${(selectedIds||[]).includes(p.uid)?' checked':''}>
          ${escHtml(p.displayName || p.email || p.uid)}
        </label>`).join('');
    }

    function renderCharSecrets() {
      const editor = document.getElementById('char-secrets-editor');
      if (!editor) return;
      editor.innerHTML = charSecretsList.map((s, i) => {
        const vis = s.visibility || { mode: 'hidden', playerIds: [] };
        return `<div class="char-secret-item" data-idx="${i}">
          <div class="char-secret-head">
            <span class="char-secret-num">Segredo ${i+1}</span>
            <button type="button" class="char-secret-del" data-idx="${i}">✕ Remover</button>
          </div>
          <textarea class="edit-textarea char-secret-text" data-idx="${i}" rows="3" placeholder="Descreva o segredo...">${escHtml(s.text||'')}</textarea>
          <div class="char-secret-vis-row">
            <span class="char-secret-vis-label">Visível para jogadores:</span>
            <div class="pc-vis-row" id="csec-vis-${i}">${csecVisButtons(vis.mode,'csec-'+i)}</div>
            <div class="pc-vis-players-wrap${vis.mode==='specific'?'':' pc-hidden'}" id="csec-players-${i}">
              ${csecPlayerChecks(vis.playerIds||[],'csec-'+i)}
            </div>
          </div>
        </div>`;
      }).join('');

      editor.querySelectorAll('.char-secret-text').forEach(ta =>
        ta.addEventListener('input', () => { charSecretsList[+ta.dataset.idx].text = ta.value; }));
      editor.querySelectorAll('.char-secret-del').forEach(btn =>
        btn.addEventListener('click', () => { charSecretsList.splice(+btn.dataset.idx, 1); renderCharSecrets(); }));
      editor.querySelectorAll('.char-sec-vis-btn').forEach(btn =>
        btn.addEventListener('click', () => {
          const prefix = btn.dataset.prefix;
          const mode   = btn.dataset.mode;
          const idx    = +prefix.split('-')[1];
          btn.closest('.pc-vis-row').querySelectorAll('.char-sec-vis-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
          charSecretsList[idx].visibility.mode = mode;
          document.getElementById(`csec-players-${idx}`).classList.toggle('pc-hidden', mode !== 'specific');
        }));
      editor.querySelectorAll('.pc-player-check').forEach(chk =>
        chk.addEventListener('change', () => {
          const prefix = chk.dataset.prefix;
          const idx    = +prefix.split('-')[1];
          const uid    = chk.dataset.uid;
          const arr    = charSecretsList[idx].visibility.playerIds;
          if (chk.checked) { if (!arr.includes(uid)) arr.push(uid); }
          else { const i = arr.indexOf(uid); if (i !== -1) arr.splice(i, 1); }
        }));
    }

    renderCharSecrets();

    form.querySelector('.edit-add-secret-btn')?.addEventListener('click', () => {
      charSecretsList.push({ id: Date.now().toString(), text: '', visibility: { mode: 'hidden', playerIds: [] } });
      renderCharSecrets();
    });
  }

  // Cancel
  form.querySelector('.edit-cancel-btn')?.addEventListener('click', () => {
    if (id) openModal(id, type, false);
    else closeModal();
    const editBtn = document.getElementById('modal-edit-btn');
    if (editBtn) editBtn.style.visibility = '';
  });

  // Delete
  form.querySelector('.edit-delete-btn')?.addEventListener('click', async () => {
    if (!confirm(`Excluir este ${typeLabel(type)} permanentemente? Esta ação não pode ser desfeita.`)) return;
    await deleteDoc(doc(db, 'campaigns', CAMPAIGN_ID, typeCollName(type), id));
    closeModal();
  });

  // Submit (save / create)
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const saveBtn = form.querySelector('.edit-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Salvando...';

    try {
      const fd   = new FormData(form);
      const data = buildDataFromForm(fd, type);

      // Inject secrets list (character only — managed outside FormData)
      if (type === 'character') data.secretsList = charSecretsList;

      // Upload de arquivo para Cloudinary (personagens)
      const fileInput = document.getElementById('img-file');
      if ((type === 'character' || type === 'location') && fileInput?.files[0]) {
        saveBtn.textContent = 'Enviando imagem...';
        data.imageUrl = await uploadToCloudinary(fileInput.files[0]);
      }

      if (id) {
        // Snapshot old secretsList before updating (for notification diff)
        const oldChar = type === 'character' ? getCharById(id) : null;
        const oldSecretsList = oldChar?.secretsList || [];

        await updateDoc(doc(db, 'campaigns', CAMPAIGN_ID, typeCollName(type), id), data);

        // Send secret reveal notifications for newly-visible secrets
        if (type === 'character' && charSecretsList.length) {
          const charName = data.name || oldChar?.name || '';
          const allPlayerUids = STATE.players.filter(p => p.role === 'player').map(p => p.uid);
          for (const newSec of charSecretsList) {
            const oldSec = oldSecretsList.find(s => s.id === newSec.id);
            const oldVis = oldSec?.visibility || { mode: 'hidden', playerIds: [] };
            const newVis = newSec.visibility || { mode: 'hidden', playerIds: [] };
            let newlyVisible = [];
            if (newVis.mode === 'all' && oldVis.mode !== 'all') {
              newlyVisible = allPlayerUids;
            } else if (newVis.mode === 'specific') {
              newlyVisible = (newVis.playerIds || []).filter(uid => !(oldVis.playerIds || []).includes(uid));
            }
            if (newlyVisible.length) {
              await sendRevealNotifications(newlyVisible, 'character', id, charName, 'secret');
            }
          }
        }

        // Save relation changes (characters only)
        if (type === 'character' && relEdits.length) {
          const defaultVis = { mode: 'hidden', playerIds: [] };
          const relBatch   = writeBatch(db);
          let changed = false;
          for (const r of relEdits) {
            if (r._delete && !r._isNew && r.id) {
              relBatch.delete(doc(db, 'campaigns', CAMPAIGN_ID, 'relations', r.id));
              changed = true;
            } else if (!r._delete && r._isNew && r.targetId) {
              const ref    = doc(collection(db, 'campaigns', CAMPAIGN_ID, 'relations'));
              const relVis = r.secret ? defaultVis : { mode: 'all', playerIds: [] };
              relBatch.set(ref, {
                sourceId: id, sourceType: 'character',
                targetId: r.targetId, targetType: 'character',
                label: r.label || '', labelTo: r.labelTo || '',
                type: 'neutral', secret: !!r.secret,
                visibility: relVis, secretsVisibility: defaultVis,
              });
              changed = true;
            } else if (!r._delete && !r._isNew && r.id) {
              const relVis = r.secret ? defaultVis : { mode: 'all', playerIds: [] };
              relBatch.update(doc(db, 'campaigns', CAMPAIGN_ID, 'relations', r.id), {
                label: r.label || '', labelTo: r.labelTo || '', secret: !!r.secret,
                visibility: relVis,
              });
              changed = true;
            }
          }
          if (changed) await relBatch.commit();
        }

        // Reopen in view mode after save
        const editBtn = document.getElementById('modal-edit-btn');
        if (editBtn) editBtn.style.visibility = '';
        openModal(id, type, false);
      } else {
        const newId = generateId(data.name || typeLabel(type));
        const docRef = doc(db, 'campaigns', CAMPAIGN_ID, typeCollName(type), newId);
        await setDoc(docRef, {
          id: newId,
          ...data,
          visibility:        { mode: 'hidden', playerIds: [] },
          secretsVisibility: { mode: 'hidden', playerIds: [] },
        });
        closeModal();
        const editBtn = document.getElementById('modal-edit-btn');
        if (editBtn) editBtn.style.visibility = '';
      }
    } catch (err) {
      console.error('Save error:', err);
      saveBtn.disabled = false;
      saveBtn.textContent = '✘ Erro — tentar novamente';
    }
  });
}

// ─── Extract clean data from form ────────────────────────────────────────────
function buildDataFromForm(fd, type) {
  const get  = k => fd.get(k) || '';
  const data = {};

  if (type === 'character') {
    data.name        = get('name').trim();
    data.role        = get('role').trim();
    data.status      = get('status');
    data.faction     = get('faction') || null;
    data.description = get('description').trim();
    data.personality = get('personality').trim();
    // secretsList is injected from attachEditFormEvents after this call
    const urlVal = get('imageUrl').trim();
    if (urlVal) data.imageUrl = urlVal;
  }

  if (type === 'location') {
    data.name             = get('name').trim();
    data.subtitle         = get('subtitle').trim();
    data.type             = get('type').trim();
    data.tone             = get('tone').trim();
    data.faction          = get('faction') || null;
    data.featured         = fd.get('featured') === 'on';
    data.description      = get('description').trim();
    data.pointsOfInterest = get('pointsOfInterest').split('\n').map(l => l.trim()).filter(Boolean);
    data.secrets          = get('secrets').trim();
    const locUrlVal = get('imageUrl').trim();
    if (locUrlVal) data.imageUrl = locUrlVal;
  }

  if (type === 'event') {
    data.name        = get('name').trim();
    data.period      = get('period').trim();
    data.scale       = get('scale');
    data.order       = parseInt(get('order')) || 0;
    data.description = get('description').trim();
    data.secrets     = get('secrets').trim();
  }

  if (type === 'faction') {
    data.name        = get('name').trim();
    data.type        = get('type').trim();
    data.symbol      = get('symbol').trim() || '◆';
    data.color       = get('color').trim() || '#5a8ab0';
    data.description = get('description').trim();
    data.secrets     = get('secrets').trim();
    data.members     = fd.getAll('members');
  }

  return data;
}

// ── SEED (first-time setup) ───────────────────────────────────────────────────
async function seedCampaign() {
  const statusEl = document.getElementById('seed-status');
  const seedBtn  = document.getElementById('seed-btn');
  seedBtn.disabled = true;
  statusEl.textContent = 'Carregando dados...';

  try {
    const [characters, locations, events, factions, relations] = await Promise.all([
      fetch('data/characters.json').then(r => r.json()),
      fetch('data/locations.json').then(r => r.json()),
      fetch('data/events.json').then(r => r.json()),
      fetch('data/factions.json').then(r => r.json()),
      fetch('data/relations.json').then(r => r.json()),
    ]);

    statusEl.textContent = 'Criando campanha no banco de dados...';
    const defaultVis = { mode: 'hidden', playerIds: [] };
    const campaignRef = doc(db, 'campaigns', CAMPAIGN_ID);
    const batch = writeBatch(db);

    batch.set(campaignRef, {
      name:      'Mares e Marés',
      world:     'Pelágos',
      masterId:  auth.currentUser.uid,
      createdAt: serverTimestamp(),
    });

    const addItems = (coll, items) => items.forEach((item, idx) => {
      const docRef = item.id
        ? doc(db, 'campaigns', CAMPAIGN_ID, coll, item.id)
        : doc(collection(db, 'campaigns', CAMPAIGN_ID, coll));
      batch.set(docRef, {
        ...item,
        visibility:        { ...defaultVis },
        secretsVisibility: { ...defaultVis },
      });
    });

    addItems('characters', characters);
    addItems('locations',  locations);
    addItems('events',     events);
    addItems('factions',   factions);
    addItems('relations',  relations);

    await batch.commit();
    statusEl.textContent = '✓ Campanha inicializada com sucesso!';
    setTimeout(() => {
      document.getElementById('seed-overlay').style.display = 'none';
    }, 1200);

  } catch (err) {
    console.error('Seed error:', err);
    statusEl.style.color = '#e07070';
    statusEl.textContent = 'Erro ao inicializar. Verifique o console.';
    seedBtn.disabled = false;
  }
}

// ── BOOTSTRAP ────────────────────────────────────────────────────────────────
function applyRoleUI() {
  document.body.classList.toggle('is-master', STATE.isMaster);
  document.body.classList.toggle('is-player', !STATE.isMaster);

  const badge = document.getElementById('user-badge');
  badge.textContent = `${STATE.isMaster ? '⚓ Mestre' : '⚔ Jogador'} — ${STATE.profile?.displayName || ''}`;
  badge.classList.toggle('is-master', STATE.isMaster);

  if (STATE.isMaster) applySecretsState();
}

async function onUserLoggedIn(user) {
  STATE.user = user;

  const profile = await loadUserProfile(user.uid);
  if (!profile) {
    // No Firestore profile — user was deleted or registration never completed.
    // Sign out to avoid an infinite reload loop, then show a clear error.
    await signOut(auth);
    const errEl = document.getElementById('login-error');
    if (errEl) {
      errEl.textContent = 'Conta não encontrada. Verifique com o mestre.';
      errEl.style.display = 'block';
    }
    return;
  }

  applyRoleUI();
  hideAuthOverlay();

  // Load all players (needed by everyone for visibility controls)
  await loadAllPlayers();

  // Check if campaign exists in Firestore
  if (STATE.isMaster) {
    const exists = await (async () => {
      const snap = await getDoc(doc(db, 'campaigns', CAMPAIGN_ID));
      return snap.exists();
    })();

    if (!exists) {
      document.getElementById('seed-overlay').style.display = 'flex';
      document.getElementById('seed-btn').addEventListener('click', seedCampaign);
      return;
    }
  }

  await setupFirestoreListeners();

  renderPainel();
  renderCharacters();
  renderLocations();
  renderEvents();
  renderFactions();
  buildCharacterFilters();
  setupGraphControls();

  // Notifications (players only)
  if (!STATE.isMaster) {
    subscribeToNotifications();
    await checkAndShowNotifications();
  }
}

function onUserLoggedOut() {
  STATE.user    = null;
  STATE.profile = null;
  STATE.isMaster = false;
  STATE.data = { characters: [], locations: [], events: [], factions: [], relations: [], annotations: [] };
  document.body.classList.remove('is-master', 'is-player');
  showAuthOverlay();
}

async function init() {
  setupAuthUI();
  showAuthOverlay();

  // Tab navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Modal controls
  document.getElementById('modal-overlay').addEventListener('click', closeModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-back-btn').addEventListener('click', modalBack);

  // Secrets toggle (master only)
  const secretsBtn = document.getElementById('secrets-float-btn');
  if (secretsBtn) secretsBtn.addEventListener('click', toggleSecrets);

  setupSearch();

  // Firebase auth state listener
  onAuthStateChanged(auth, user => {
    if (user) onUserLoggedIn(user);
    else      onUserLoggedOut();
  });
}

document.addEventListener('DOMContentLoaded', init);

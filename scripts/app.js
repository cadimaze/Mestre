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
  data: { characters: [], locations: [], events: [], factions: [], relations: [], annotations: [], documents: [], items: [] },

  activeTab:       'painel',
  secretsVisible:  localStorage.getItem('secretsVisible') !== 'false',
  modal:           { stack: [], current: null },
  graphFilters:    { character: true, location: true, event: true, faction: true, player: true },
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

  // Players: separate single-field queries merged by id.
  // Using multiple listeners avoids composite-index requirements and is provably
  // safe under the simplified isVisible() rule (mode==all OR uid in playerIds).
  const uid   = STATE.user.uid;
  const byId  = { all: new Map(), specific: new Map(), mine: new Map() };

  function merge() {
    const merged = new Map([...byId.all, ...byId.specific, ...byId.mine]);
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

  // Relações criadas pelo próprio jogador são sempre visíveis a ele,
  // mesmo que o mestre as oculte dos demais (regra createdBy == uid)
  if (collName === 'relations') {
    const unsubMine = onSnapshot(
      query(ref, where('createdBy', '==', uid)),
      snap => {
        byId.mine.clear();
        snap.docs.forEach(d => byId.mine.set(d.id, { ...d.data(), id: d.id }));
        merge();
      },
      err => console.error(`[${collName}/mine]`, err)
    );
    STATE.unsubscribers.push(unsubMine);
  }
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
    case 'relations':  renderPainel(); if (STATE.activeTab === 'relacoes') renderGraph(); break;
    case 'documents':  renderAcervo(); break;
    case 'items':      renderAcervo(); break;
  }
}

async function setupFirestoreListeners() {
  subscribeToCollection('characters');
  subscribeToCollection('locations');
  subscribeToCollection('events');
  subscribeToCollection('factions');
  subscribeToCollection('relations');
  subscribeToCollection('documents');
  subscribeToCollection('items');
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
const collNameToEntityType = { characters: 'character', locations: 'location', events: 'event', factions: 'faction', documents: 'document', items: 'item' };

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
            ? `O mestre revelou um segredo sobre <strong>${escHtml(notif.entityName)}</strong>. Clique para ver a ficha completa.`
            : `O mestre liberou o acesso a informações sobre ${escHtml(notif.entityName)}. Explore ${entityLabel} agora.`
        }</div>
        <div>
          <button class="reveal-toast-btn" id="rt-view">${isSecret ? 'Ver ficha' : 'Ver agora'}</button>
          <button class="reveal-toast-btn-secondary" id="rt-close">Fechar</button>
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
    const dataMap  = { characters: STATE.data.characters, locations: STATE.data.locations, events: STATE.data.events, factions: STATE.data.factions, documents: STATE.data.documents, items: STATE.data.items };
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

function attachPlayerSecretVisEvents(playerUid) {
  if (!STATE.isMaster) return;
  const sec = document.getElementById('char-secrets-modal-section');
  if (!sec) return;

  async function saveSecretVis(secretId, mode, playerIds) {
    const player = getPlayerByUid(playerUid);
    if (!player) return;
    const pc      = player.playerCharacter || {};
    const oldList = Array.isArray(pc.secretsList) ? pc.secretsList : [];
    const oldVis  = oldList.find(s => s.id === secretId)?.visibility || { mode: 'hidden', playerIds: [] };
    const newList = oldList.map(s => s.id === secretId ? { ...s, visibility: { mode, playerIds } } : s);

    await updateDoc(doc(db, 'users', playerUid), { 'playerCharacter.secretsList': newList });

    const allPlayerUids = STATE.players.filter(p => p.role === 'player').map(p => p.uid);
    let newlyVisible = [];
    if (mode === 'all' && oldVis.mode !== 'all') {
      newlyVisible = allPlayerUids;
    } else if (mode === 'specific') {
      newlyVisible = playerIds.filter(uid => !(oldVis.playerIds || []).includes(uid));
    }
    if (newlyVisible.length) {
      const charName = playerCharName(player);
      await sendRevealNotifications(newlyVisible, 'player', playerUid, charName, 'secret');
    }
  }

  sec.querySelectorAll('.sec-vis-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const secretId = btn.dataset.secretId;
      const mode     = btn.dataset.mode;
      sec.querySelectorAll(`.sec-vis-btn[data-secret-id="${secretId}"]`)
         .forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
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

function attachEntitySecretVisEvents(entityId, collName, entityType, getEntityFn) {
  if (!STATE.isMaster) return;
  const sec = document.getElementById('char-secrets-modal-section');
  if (!sec) return;

  async function saveSecretVis(secretId, mode, playerIds) {
    const entity = getEntityFn(entityId);
    if (!entity) return;
    const oldList = Array.isArray(entity.secretsList) ? entity.secretsList
                    : (entity.secrets ? [{ id: '0', text: entity.secrets, visibility: { mode: 'hidden', playerIds: [] } }] : []);
    const oldVis  = oldList.find(s => s.id === secretId)?.visibility || { mode: 'hidden', playerIds: [] };
    const newList = oldList.map(s => s.id === secretId ? { ...s, visibility: { mode, playerIds } } : s);
    await updateDoc(doc(db, 'campaigns', CAMPAIGN_ID, collName, entityId), { secretsList: newList });
    const allPlayerUids = STATE.players.filter(p => p.role === 'player').map(p => p.uid);
    let newlyVisible = [];
    if (mode === 'all' && oldVis.mode !== 'all') { newlyVisible = allPlayerUids; }
    else if (mode === 'specific') { newlyVisible = playerIds.filter(uid => !(oldVis.playerIds || []).includes(uid)); }
    if (newlyVisible.length) await sendRevealNotifications(newlyVisible, entityType, entityId, entity.name, 'secret');
  }

  sec.querySelectorAll('.sec-vis-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const secretId = btn.dataset.secretId;
      const mode     = btn.dataset.mode;
      sec.querySelectorAll(`.sec-vis-btn[data-secret-id="${secretId}"]`).forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
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
const getPlayerByUid  = uid => STATE.players.find(p => p.uid === uid);
const playerCharName  = p => p?.playerCharacter?.name || p?.displayName || '—';
const listPlayerChars = () => STATE.players.filter(p => p.role === 'player' && p.playerCharacter?.name);

function factionColor(factionId) {
  const f = getFactionById(factionId);
  return f ? f.color : '#3a5a7a';
}

function hasSecrets(item) {
  if (!item) return false;
  if (Array.isArray(item.secretsList) && item.secretsList.length > 0) return true;
  return !!(item.secrets && item.secrets.trim().length > 0);
}

// Generic secrets renderer for locations, events, factions (master-only, no per-player controls)
function buildEntitySecretsHtml(entity) {
  if (!STATE.isMaster || !hasSecrets(entity)) return '';
  const list = Array.isArray(entity.secretsList) && entity.secretsList.length
    ? entity.secretsList
    : [{ id: '0', text: entity.secrets }];
  const items = list.map((s, i) =>
    `<div class="modal-char-secret-item" style="margin-bottom:12px;">
      <div class="modal-char-secret-header"><span class="modal-char-secret-num">Camada ${i + 1}</span></div>
      <div class="modal-section-text">${escHtml(s.text)}</div>
    </div>`
  ).join('');
  return `<div class="modal-section secrets-section"><div class="modal-secrets">
    <div class="modal-section-title">🔒 Segredos do Mestre</div>${items}</div></div>`;
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
  return { family: '#ffffff', political: '#c8a96a', romantic: '#c07090', secret: '#c03030', historical: '#7a8a9a', neutral: '#5a7a9a' }[type] || '#5a7a9a';
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
  if (tab === 'roteiro')        renderRoteiro();
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

  // Conexões Recentes — exclusivo do Mestre; jogadores só veem relações
  // liberadas na aba Relações
  const relList = document.getElementById('recent-relations');
  if (!STATE.isMaster) {
    if (relList) relList.innerHTML = '';
    return;
  }
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
  if (type === 'player') {
    const p = getPlayerByUid(id);
    return p ? playerCharName(p) : id;
  }
  const fn = { character: getCharById, location: getLocationById, event: getEventById, faction: getFactionById, document: getDocumentById, item: getItemByIdFn }[type];
  return fn?.(id)?.name || id;
}

// ── SYNC CAMPAIGN CONTENT ─────────────────────────────────────────────────────
async function syncCampaignContent() {
  const btn = document.getElementById('sync-campaign-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando...'; }

  try {
    const [chars, locs, evts, facts, docs] = await Promise.all([
      fetch('data/characters.json').then(r => r.json()),
      fetch('data/locations.json').then(r => r.json()),
      fetch('data/events.json').then(r => r.json()),
      fetch('data/factions.json').then(r => r.json()),
      fetch('data/documents.json').then(r => r.json()),
    ]);

    // Preserve existing secret visibility when syncing secretsList
    function mergeSecretsList(newList, existing) {
      if (!newList?.length) return newList || [];
      const existingList = existing?.secretsList || [];
      const visByID = Object.fromEntries(existingList.map(s => [s.id, s.visibility]));
      return newList.map(s => ({ ...s, visibility: visByID[s.id] || s.visibility }));
    }

    const batch = writeBatch(db);
    const base  = `campaigns/${CAMPAIGN_ID}`;

    chars.forEach(c => {
      const ref      = doc(db, base, 'characters', c.id);
      const existing = STATE.data.characters.find(ch => ch.id === c.id);
      const update   = {
        name: c.name, role: c.role || '', status: c.status || '',
        description: c.description || '', personality: c.personality || '',
        secretsList: mergeSecretsList(c.secretsList, existing),
      };
      batch.set(ref, update, { merge: true });
    });

    locs.forEach(l => {
      const ref      = doc(db, base, 'locations', l.id);
      const existing = STATE.data.locations.find(x => x.id === l.id);
      const update   = {
        name: l.name, subtitle: l.subtitle || '', type: l.type || '',
        description: l.description || '', tone: l.tone || '',
        pointsOfInterest: l.pointsOfInterest || [], secrets: l.secrets || '',
        secretsList: mergeSecretsList(l.secretsList, existing),
      };
      batch.set(ref, update, { merge: true });
    });

    evts.forEach(e => {
      const ref      = doc(db, base, 'events', e.id);
      const existing = STATE.data.events.find(x => x.id === e.id);
      const update   = {
        name: e.name, period: e.period || '', scale: e.scale || '',
        description: e.description || '', secrets: e.secrets || '',
        secretsList: mergeSecretsList(e.secretsList, existing),
        relatedEvents: e.relatedEvents || [],
      };
      batch.set(ref, update, { merge: true });
    });

    facts.forEach(f => {
      const ref    = doc(db, base, 'factions', f.id);
      const update = {
        name: f.name, type: f.type || '', color: f.color || '',
        symbol: f.symbol || '', description: f.description || '',
        secrets: f.secrets || '',
      };
      batch.set(ref, update, { merge: true });
    });

    docs.forEach(d => {
      const ref      = doc(db, base, 'documents', d.id);
      const existing = STATE.data.documents.find(x => x.id === d.id);
      const update   = {
        name: d.name, docType: d.docType || '', period: d.period || '',
        author: d.author || '', description: d.description || '',
        content: d.content || '', rarity: d.rarity || '',
        secretsList: mergeSecretsList(d.secretsList, existing),
      };
      if (d.imageUrl) update.imageUrl = d.imageUrl;
      batch.set(ref, update, { merge: true });
    });

    await batch.commit();
    if (btn) { btn.textContent = '✓ Sincronizado!'; setTimeout(() => { btn.textContent = '🔄 Sincronizar Dados'; btn.disabled = false; }, 3000); }
  } catch (err) {
    console.error('Sync error:', err);
    alert('Erro ao sincronizar: ' + err.message);
    if (btn) { btn.textContent = '🔄 Sincronizar Dados'; btn.disabled = false; }
  }
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

// ── ROTEIRO TAB (master only) ─────────────────────────────────────────────────
function renderRoteiro() {
  if (!STATE.isMaster) return;
  const el = document.getElementById('roteiro-content');
  if (!el || el.dataset.rendered) return;
  el.dataset.rendered = '1';

  const arcos = [
    {
      id: 'arco1', num: '1', titulo: 'Kaldera: O Início', ilha: 'Kaldera',
      objetivo: 'Apresentação dos personagens, formação do grupo, fuga e gancho central da campanha.',
      cenas: [
        {
          titulo: 'A Cela',
          texto: 'A maioria dos jogadores acorda presa — cada um por motivo individual (história do personagem). Na cela está Soren Mael: cartógrafo de trinta e poucos anos, preso por velejamento em águas proibidas. Oferece suas habilidades de navegação a quem o ajudar a sair. Revela que encontrou referências a um artefato guardado pela Casa Varek em Velmyr e acredita que foi preso por isso.',
          nota: 'Sinais sutis de Soren a plantar: quando fala sobre profundidades oceânicas, o tremor na mão direita para de existir. Às vezes completa uma frase e franze o cenho, como se ela tivesse chegado de outro lugar.'
        },
        {
          titulo: 'As Docas (paralela à Cela)',
          texto: 'Cid chega ao porto com carga. Bjorn está nas docas descarregando — os dois não se conhecem. Um guarda da Corrente aborda Cid por dívidas com Velmarch; a discussão escala, Bjorn testemunha. Cid é preso e termina na mesma cela. Bjorn é a incógnita: pode ser preso por interferir, seguir solto ou desaparecer e reaparecer na fuga.'
        },
        {
          titulo: 'Tulo Bresh',
          texto: 'Levados ao escritório do governador. Tulo está com uma cortesã (membro da Corte das Cortesãs, operando como informante de Gloria Vittar) e um orc grande que faz sua guarda. Tulo quer extorquir antes de qualquer decisão sobre os prisioneiros.',
          nota: 'Erro fatal de Soren: menciona o artefato durante a audiência — talvez como moeda de troca, talvez porque não consegue se conter. A cortesã ouve. E entende exatamente o que está ouvindo.'
        },
        {
          titulo: 'O Orc',
          texto: 'Combate com armas improvisadas. O escritório de Tulo tem: garrafas de bebida cara, estatuetas pesadas, candelabros de ferro, mobília pesada. O orc é grande e forte mas lento — exige criatividade, não força bruta. Durante o combate, a cortesã se retira discretamente. Não há motivo aparente para notar isso no calor da luta.'
        },
        {
          titulo: 'A Fuga',
          texto: 'Quando o combate termina, Tulo é encontrado morto — envenenado. A cortesã sumiu. A Corrente fecha o porto. Os jogadores são os suspeitos óbvios. Fuga por Kaldera: becos, mercado, porto. O barco de Cid está no cais — ele conhece cada canto. Bjorn pode estar esperando, ou ser encontrado nos cais. Escapam sob perseguição da Corrente.',
          nota: 'A cortesã foi a Marvosa. Não foi enviada para matar Tulo — foi uma decisão de campo baseada no que ouviu sobre o artefato. Gloria ficará irritada. E usará isso como ferramenta contra os jogadores.'
        }
      ],
      documentos: [
        { nome: 'A Guerra que Partiu o Mundo (Vol. I)', como: 'Parede de taverna como curiosidade; mercado por centavos; deixado numa cela anterior' },
        { nome: 'Registros do Purgo (Vol. I)', como: 'Panfleto anti-elfo distribuído livremente pelas ruas de Kaldera' },
        { nome: 'Canção da Maré Alta (Vol. I)', como: 'Escutada em taverna ou cantada por marinheiros no porto; folha avulsa' }
      ]
    },
    {
      id: 'arco2', num: '2', titulo: 'O Mar Aberto: Primeiras Decisões', ilha: 'Mar Aberto',
      objetivo: 'Primeiros momentos livres. Soren aprofunda o que sabe. Os jogadores escolhem o próximo destino.',
      cenas: [
        {
          titulo: 'A Conversa no Barco',
          texto: 'Soren revela mais: o artefato é um tomo, guardado na Câmara Selada do palácio de Velmyr. Referências antigas o descrevem como "o registro que não pode ser lido por mãos que não merecem". A Casa Varek guarda esse segredo há gerações — sem saber por quê.',
          nota: 'A rota que Soren sugere leva, eventualmente, a Velmyr — passando por pontos específicos que ele justifica como "melhores rotas". Cada sugestão é tecnicamente válida. Cada uma foi calculada.'
        },
        {
          titulo: 'A Primeira Decisão',
          texto: 'Os jogadores escolhem para onde vão. Ganchos: Aethon ("há ferreiros que fazem instrumentos náuticos — poderia atualizar meus mapas"), Kesvar ("há um arquivo lá — se os documentos sobre o tomo existem fora de Velmyr, é em Kesvar"), Marvosa (surgirá quando descobrirem que estão sendo culpados pela morte de Tulo).'
        }
      ],
      documentos: []
    },
    {
      id: 'arco3', num: '3', titulo: 'Ilhas Livres: Aethon e Kesvar', ilha: 'Aethon / Kesvar',
      objetivo: 'Recursos e informação. Primeiras revelações históricas sobre a Grande Guerra e o nome Himmel Varek.',
      cenas: [
        {
          titulo: 'Aethon — O Ancoradouro de Latão',
          texto: 'Ilha metalúrgica e independente de Velmarch. Ferreiros, mercadores de metal, estaleiros. Rumores: a história dos fugitivos de Kaldera já circula nos portos. Bom lugar para reparação do barco, equipamento melhor. Possível NPC relevante para a história pessoal de algum jogador.'
        },
        {
          titulo: 'Kesvar — A Ilha dos Arquivos',
          texto: 'Melhor arquivo histórico acessível fora de Velmyr. Um arquivista lembra de Maren Krill — pesquisadora que veio décadas atrás buscando "os magistas da língua alta". Documentos fragmentados sobre a Grande Guerra sem nomear Selavin, mas descrevendo "os que convocaram o que não devia ser convocado". O nome Himmel Varek aparece pela primeira vez: "sacerdote-rei de uma ilha pequena que encontrou um método".'
        }
      ],
      documentos: [
        { nome: 'Investigações sobre a Guerra Antiga (Vol. II — Maren Krill)', como: 'Arquivo de Kesvar (primário) ou comerciante de relíquias em Aethon' },
        { nome: 'Uma Investigação Histórica (Vol. II — Telvis Oran)', como: 'Arquivo de Kesvar — um dos únicos registros formais sobre a Caça aos Elfos' },
        { nome: 'Canção da Maré Alta (Vol. I)', como: 'Se não encontrada antes: qualquer taverna portuária' }
      ]
    },
    {
      id: 'arco4', num: '4', titulo: 'Marvosa: A Corte das Sombras', ilha: 'Marvosa',
      objetivo: 'Confronto político com Gloria Vittar. Revelação parcial da Corte das Cortesãs. Proposta que define a segunda metade da campanha.',
      cenas: [
        {
          titulo: 'Como Chegam',
          texto: 'Os jogadores descobrem que estão sendo culpados pela morte de Tulo Bresh — e que a acusação vem de Marvosa. Chegam para limpar o nome, negociar ou seguindo pista sobre o artefato.'
        },
        {
          titulo: 'Gloria Vittar',
          texto: 'Os recebe. Surpreendentemente, não os prende. "Vocês não mataram Tulo Bresh. Eu sei disso. A questão é que a Corrente não sabe — e o que a Corrente acredita depende do que eu disser." Gloria quer o tomo de Velmyr por razões políticas — algo no tomo pode desestabilizar o fundamento do Domínio. A proposta: "Trabalhem para mim. Contrabandeiem o tomo. Em troca, vos livro da acusação." Os jogadores podem aceitar, recusar ou negociar. Gloria é paciente.',
          nota: 'A Corte das Cortesãs: mencionada mas não completamente revelada. Gloria não havia ordenado a morte de Tulo — foi decisão de campo. Ela está irritada com isso mas não vai admitir. O que ficará claro: há uma rede de informantes espalhada pelos portos de Pelágos.'
        }
      ],
      documentos: [
        { nome: 'Especulações de um Monge Costeiro (Vol. II — Frei Assolvan)', como: 'Coleção particular de Gloria Vittar — dado como boa fé ou como pagamento' }
      ]
    },
    {
      id: 'arco5', num: '5', titulo: 'Reva: A Memória do Mundo', ilha: 'Reva',
      objetivo: 'A revelação mais profunda da campanha. Frieren sabe o que ninguém mais sabe. Fern guarda o que Frieren não consegue mais guardar sozinha.',
      cenas: [
        {
          titulo: 'Como Chegam',
          texto: 'Soren tem mapas que mencionam Reva como ponto de rota. Ou os jogadores seguem pistas dos documentos sobre sobreviventes da Caça. Ou Fern aparece como compradora de suprimentos em algum porto anterior. Reva parece uma ilha pequena e simples. A família Talion parece uma família de curandeiros isolados.'
        },
        {
          titulo: 'Frieren e Fern',
          texto: 'Fern é a administradora prática, cordial, eficiente. Frieren é uma velha quase senil que às vezes diz coisas que não fazem sentido de uma maneira que faz sentido demais. Conquistando a confiança de Fern (gradualmente): (1) ela revela que são elfos; (2) que Frieren estava presente no Abraço das Águas Eternas; (3) Frieren, em momento lúcido: "Himmel sacrificou tudo. O que está selado tem nome. Não digam o nome perto da água."',
          nota: 'O momento lúcido de Frieren pode ser provocado por: um documento histórico lido em voz alta na sua presença; alguém mencionar o nome "Himmel Varek"; presença de sensibilidade arcana próxima ao tomo de Himmel.'
        }
      ],
      documentos: [
        { nome: 'Palavras de Frieren (Vol. III — Frieren Talion)', como: 'Carta entre os pertences de Frieren; dado por Fern como sinal de confiança' },
        { nome: 'Memória dos Derradeiros Dias (Vol. III — Aelindra)', como: 'Frieren guardou uma cópia que Aelindra lhe entregou durante o selamento' },
        { nome: 'Lamento de Galadriel Cass (Vol. III)', como: 'Aqui ou obtido no Arco 4' }
      ]
    },
    {
      id: 'arco6', num: '6', titulo: 'A Revelação de Soren', ilha: 'Qualquer lugar',
      objetivo: 'Os sinais acumulados ao longo da campanha tornam-se impossíveis de ignorar. Soren é uma vítima — e uma ferramenta.',
      cenas: [
        {
          titulo: 'Os Sinais Acumulam',
          texto: 'As rotas de Soren têm uma direção consistente: sempre em direção ao centro geográfico do oceano de Pelágos. Seus mapas de profundidade oceânica têm marcações precisíssimas exatamente na área do selamento descrita no Tomo de Himmel. Em algum momento, ele "sabe" algo que não poderia saber — e quando questionado, franze o cenho e não consegue explicar.'
        },
        {
          titulo: 'O Confronto',
          texto: 'Se os jogadores confrontam Soren: ele genuinamente não sabe. Acredita em tudo que diz. Quando pressionado, fica perturbado — há algo, mas não consegue nomear. Se investigam magicamente: um fio de influência que vai muito fundo. Não é possessão — é infiltração. Como água por uma rachadura.',
          nota: 'Soren não é o inimigo. É uma vítima que também é uma ferramenta. O que o usa tem nome: Selavin Doss — o magista que se fundiu com o Thurvael no instante do selamento e usa essa fresta para conduzir os jogadores até o tomo.'
        }
      ],
      documentos: []
    },
    {
      id: 'arco7', num: '7', titulo: 'Velmyr: O Coração do Império', ilha: 'Velmyr',
      objetivo: 'A verdade completa. O Tomo de Himmel Varek. A preparação para a escolha final.',
      cenas: [
        {
          titulo: 'Entrando em Velmyr',
          texto: 'Os jogadores chegam com documentos suficientes para entender o que está em jogo. A cidade é grande, policiada, e os nomes deles provavelmente ainda circulam em mandados. Abordagens possíveis: com apoio de Gloria Vittar; com disfarce ou documentação falsa; pela rede de Gangplank; com apoio improvável de alguém dentro da Casa Varek.'
        },
        {
          titulo: 'Aldric XIV',
          texto: 'Não é o vilão que imaginavam. É um homem que administra um poder que não entende. Sabe que o tomo existe e que deve ser guardado. Nunca leu. Cada rei da linhagem Varek, ao assumir, recebe a mesma instrução: "Guarde o tomo. Não o abra. Não pergunte o que há dentro." Pode ser obstáculo, aliado relutante ou irrelevante — depende de como os jogadores chegam.'
        },
        {
          titulo: 'A Câmara Selada',
          texto: 'Nas fundações do palácio. As inscrições de Himmel nas paredes são a confirmação final — escritas por ele antes do ritual. O tomo está aqui.'
        }
      ],
      documentos: [
        { nome: 'Tomo de Himmel Varek (Lendário)', como: 'Câmara Selada nas fundações do Palácio de Velmyr — a verdade completa sobre o Thurvael, o selamento e o aviso' }
      ]
    },
    {
      id: 'arco-final', num: '∞', titulo: 'A Escolha Impossível', ilha: 'O Ponto de Selamento',
      objetivo: 'A decisão final. Não há resposta certa.',
      cenas: [
        {
          titulo: 'Depois de Ler o Tomo',
          texto: 'Os jogadores sabem: a Maré Alta foi intencional — Himmel afogou o mundo para selar o Thurvael. O oceano de Pelágos inteiro é um cárcere. O que está selado tem o rosto de Selavin Doss — não uma força amorfa, mas um homem com séculos de planejamento e o poder integral de uma entidade primordial. E Soren foi o instrumento que os trouxe até aqui sem saber.'
        },
        {
          titulo: 'Quebrar o Selo',
          texto: 'Selavin Doss emerge. Vai tentar convencer os jogadores de que foi vítima — os elfos foram perseguidos, Himmel destruiu o mundo deles para salvar um mundo que os exterminou. Ele não está completamente errado. Mas tem o poder do Thurvael e passou séculos planejando.'
        },
        {
          titulo: 'Manter o Selo',
          texto: 'Velmarch continua. O oceano permanece como cárcere. Os elfos continuam sendo perseguidos. O erro de Selavin permanece enterrado com ele.'
        },
        {
          titulo: 'Uma Terceira Opção',
          texto: 'A existência de uma terceira saída depende das escolhas ao longo da campanha — dos aliados construídos, dos documentos encontrados, do que Frieren revelou em Reva, de se encontraram Galadriel Cass, de como trataram Soren.',
          nota: 'Planejar a terceira opção junto com o que os jogadores construíram. Ela não existe de forma fixa — emerge das escolhas deles.'
        }
      ],
      documentos: []
    }
  ];

  const docMapHtml = `
    <div class="roteiro-doc-map">
      <h3 class="roteiro-section-title">Mapa de Documentos</h3>
      <table class="roteiro-table">
        <thead><tr><th>Documento</th><th>Volume</th><th>Arco</th></tr></thead>
        <tbody>
          <tr><td>A Guerra que Partiu o Mundo</td><td>I</td><td>Arco 1 — Kaldera</td></tr>
          <tr><td>Registros do Purgo</td><td>I</td><td>Arco 1 — Kaldera</td></tr>
          <tr><td>Canção da Maré Alta</td><td>I</td><td>Arco 1 / 2 / 3</td></tr>
          <tr><td>Investigações sobre a Guerra Antiga</td><td>II</td><td>Arco 3 — Kesvar / Aethon</td></tr>
          <tr><td>Uma Investigação Histórica</td><td>II</td><td>Arco 3 — Kesvar</td></tr>
          <tr><td>Especulações de um Monge Costeiro</td><td>II</td><td>Arco 4 — Marvosa</td></tr>
          <tr><td>Memória dos Derradeiros Dias</td><td>III</td><td>Arco 5 — Reva</td></tr>
          <tr><td>Palavras de Frieren</td><td>III</td><td>Arco 5 — Reva</td></tr>
          <tr><td>Lamento de Galadriel Cass</td><td>III</td><td>Arco 4 ou 5</td></tr>
          <tr><td>Tomo de Himmel Varek</td><td>Lendário</td><td>Arco 7 — Velmyr</td></tr>
        </tbody>
      </table>
    </div>`;

  el.innerHTML = `
    <div class="roteiro-wrap">
      <div class="roteiro-header">
        <div class="roteiro-title">Roteiro — Mares e Marés</div>
        <div class="roteiro-subtitle">Documento exclusivo do Mestre · Esboço linear da campanha</div>
      </div>

      <div class="roteiro-arcos">
        ${arcos.map(a => `
          <div class="roteiro-arco" id="${a.id}">
            <div class="roteiro-arco-header" onclick="this.parentElement.classList.toggle('open')">
              <span class="roteiro-arco-num">Arco ${a.num}</span>
              <span class="roteiro-arco-titulo">${a.titulo}</span>
              <span class="roteiro-arco-ilha">${a.ilha}</span>
              <span class="roteiro-arco-chevron">▸</span>
            </div>
            <div class="roteiro-arco-body">
              <p class="roteiro-objetivo">${a.objetivo}</p>
              ${a.cenas.map(c => `
                <div class="roteiro-cena">
                  <div class="roteiro-cena-titulo">${c.titulo}</div>
                  <p class="roteiro-cena-texto">${c.texto}</p>
                  ${c.nota ? `<div class="roteiro-nota">📌 ${c.nota}</div>` : ''}
                </div>
              `).join('')}
              ${a.documentos.length ? `
                <div class="roteiro-docs-box">
                  <div class="roteiro-docs-label">📄 Documentos neste arco</div>
                  ${a.documentos.map(d => `
                    <div class="roteiro-doc-item">
                      <span class="roteiro-doc-nome">${d.nome}</span>
                      <span class="roteiro-doc-como">${d.como}</span>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          </div>
        `).join('')}
      </div>

      ${docMapHtml}
    </div>`;
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
    return `<div class="jogador-card" data-uid="${p.uid}" title="Abrir ficha">
      <div style="display:flex;align-items:center;gap:14px;">
        <div class="jogador-avatar">${initial}</div>
        <div style="flex:1;min-width:0;">
          <div class="jogador-name">${escHtml(p.displayName || '—')}</div>
          <div class="jogador-email">${escHtml(p.email || '')}</div>
        </div>
        <button class="jogador-edit-btn" data-uid="${p.uid}" title="Editar ficha deste jogador">✏ Editar ficha</button>
      </div>
      ${pc && pc.name
        ? `<div class="jogador-char-info">
            <div class="jogador-char-name">${escHtml(pc.name)}</div>
            <div>${[pc.race, pc.charClass, pc.background].filter(Boolean).map(escHtml).join(' · ')}</div>
           </div>`
        : `<div class="jogador-char-info" style="color:#3a4a5a;font-style:italic;">Ficha ainda não preenchida — clique em Editar para preenchê-la pelo Mestre.</div>`
      }
    </div>`;
  }).join('');

  // Card abre a ficha; botão abre direto em modo de edição
  grid.querySelectorAll('.jogador-card').forEach(card => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => openModal(card.dataset.uid, 'player'));
  });
  grid.querySelectorAll('.jogador-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openModal(btn.dataset.uid, 'player');
      openEditMode(btn.dataset.uid, 'player');
    });
  });
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

  const FIELD_VIS_KEYS = ['appearance', 'personality', 'history'];
  let fieldVis = {};
  FIELD_VIS_KEYS.forEach(k => {
    const saved = pc.fieldVisibility?.[k];
    fieldVis[k] = saved ? { ...saved, playerIds: [...(saved.playerIds || [])] } : { mode: 'all', playerIds: [] };
  });

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
    ? `<img class="pc-portrait-img pc-portrait-zoomable" id="pc-portrait-img" src="${pendingImageUrl}" alt="" title="Clique para ampliar">`
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
        <div class="pc-field-header">
          <div class="pc-section-title">Aparência</div>
          <div class="pc-vis-row pc-field-vis-row" id="field-vis-btns-appearance">${visButtons(fieldVis.appearance.mode,'appearance')}</div>
        </div>
        <div class="pc-vis-players-wrap${fieldVis.appearance.mode==='specific'?'':' pc-hidden'}" id="field-vis-players-appearance">
          ${playerChecks(fieldVis.appearance.playerIds,'appearance')}
        </div>
        <textarea class="my-char-textarea" name="appearance" rows="3"
          placeholder="Como seu personagem parece, o que as pessoas notam ao vê-lo...">${escHtml(pc.appearance||'')}</textarea>
      </div>

      <div class="pc-section">
        <div class="pc-field-header">
          <div class="pc-section-title">Personalidade &amp; Motivações</div>
          <div class="pc-vis-row pc-field-vis-row" id="field-vis-btns-personality">${visButtons(fieldVis.personality.mode,'personality')}</div>
        </div>
        <div class="pc-vis-players-wrap${fieldVis.personality.mode==='specific'?'':' pc-hidden'}" id="field-vis-players-personality">
          ${playerChecks(fieldVis.personality.playerIds,'personality')}
        </div>
        <textarea class="my-char-textarea" name="personality" rows="4"
          placeholder="O que quer, teme, acredita, como age sob pressão...">${escHtml(pc.personality||'')}</textarea>
      </div>

      <div class="pc-section">
        <div class="pc-field-header">
          <div class="pc-section-title">História do Personagem</div>
          <div class="pc-vis-row pc-field-vis-row" id="field-vis-btns-history">${visButtons(fieldVis.history.mode,'history')}</div>
        </div>
        <div class="pc-vis-players-wrap${fieldVis.history.mode==='specific'?'':' pc-hidden'}" id="field-vis-players-history">
          ${playerChecks(fieldVis.history.playerIds,'history')}
        </div>
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
        } else if (FIELD_VIS_KEYS.includes(prefix)) {
          fieldVis[prefix].mode = mode;
          document.getElementById(`field-vis-players-${prefix}`).classList.toggle('pc-hidden', mode !== 'specific');
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
        } else if (FIELD_VIS_KEYS.includes(name)) {
          arr = fieldVis[name].playerIds;
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

  // ── Portrait lightbox ─────────────────────────────────────────────────────
  function wirePortraitLightbox() {
    const img = document.getElementById('pc-portrait-img');
    if (img && img.tagName === 'IMG') {
      img.addEventListener('click', () => openLightbox(img.src));
    }
  }
  wirePortraitLightbox();

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
        `<img class="pc-portrait-img pc-portrait-zoomable" id="pc-portrait-img" src="${url}" alt="" title="Clique para ampliar">`;
      wirePortraitLightbox();
    } catch { alert('Erro ao enviar imagem. Tente novamente.'); }
    finally { up.style.display = 'none'; }
  });

  // ── Save ──────────────────────────────────────────────────────────────────
  document.getElementById('my-char-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('pc-save-btn');
    btn.disabled = true; btn.textContent = 'Salvando...';
    const fd = new FormData(e.target);
    const charData = { sheetVisibility: sheetVis, fieldVisibility: fieldVis, secretsList };
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
    if (el) {
      el.innerHTML = html;
      el.querySelectorAll('.pcc-portrait').forEach(img => {
        img.addEventListener('click', () => openLightbox(img.src));
      });
      el.querySelectorAll('.pcc-secret-link').forEach(div => {
        div.addEventListener('click', () => openModal(div.dataset.playerUid, 'player'));
      });
    }
  }).catch(() => {});
}

function isFieldVisible(pc, field, viewerUid) {
  const fv = pc.fieldVisibility?.[field];
  if (!fv || fv.mode === 'all') return true;
  if (fv.mode === 'specific') return (fv.playerIds || []).includes(viewerUid);
  return false;
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
      ? `<img class="pcc-portrait pcc-portrait-zoomable" src="${escHtml(pc.imageUrl)}" alt="" title="Clique para ampliar" onerror="this.style.display='none'">`
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
          ${sharedSecrets.map(s => `<div class="pcc-secret-item pcc-secret-link" data-player-uid="${p.uid}" title="Clique para abrir a ficha">🔒 ${escHtml(s.text)}</div>`).join('')}
         </div>`
      : '';

    return `<div class="player-char-card">
      ${portrait}
      <div class="pcc-body">
        <div class="player-char-player">Jogador: ${escHtml(p.displayName)}</div>
        <div class="player-char-name">${escHtml(pc.name)}</div>
        <div class="player-char-details">
          ${[pc.race, pc.charClass, pc.background].filter(Boolean).map(escHtml).join(' · ')}
          ${pc.appearance && isFieldVisible(pc, 'appearance', myUid) ? `<div class="pcc-appearance">${escHtml(pc.appearance)}</div>` : ''}
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

// ── ACERVO ────────────────────────────────────────────────────────────────────
const DOC_TYPE_ICON  = { tomo: '📕', carta: '✉', diário: '📖', pergaminho: '📜', mapa: '🗺', proclamação: '📣', decreto: '⚖', inscrição: '🔏', anotação: '📝' };
const ITEM_TYPE_ICON = { chave: '🗝', joia: '💎', artefato: '✨', amuleto: '🔮', relíquia: '⚜', moeda: '🪙', símbolo: '🔱', fragmento: '🪨' };
const ITEM_RARITY_COLOR = { comum: '#7a9aaa', incomum: '#5a9a60', raro: '#4a70c0', 'muito raro': '#9a50c0', lendário: '#c0882a' };

function renderAcervo() {
  const docs  = STATE.data.documents || [];
  const items = STATE.data.items || [];
  const myUid = STATE.user?.uid;

  function docVisible(d) {
    if (STATE.isMaster) return true;
    const v = d.visibility;
    if (!v || v.mode === 'all') return true;
    if (v.mode === 'specific') return (v.playerIds || []).includes(myUid);
    return false;
  }

  const visibleDocs  = docs.filter(docVisible);
  const visibleItems = items.filter(docVisible);

  const docsGrid = document.getElementById('docs-grid');
  const itemsGrid = document.getElementById('items-grid');
  if (!docsGrid || !itemsGrid) return;

  docsGrid.innerHTML = visibleDocs.length
    ? visibleDocs.map(d => {
        const icon = DOC_TYPE_ICON[d.docType] || '📄';
        const secretBadge = STATE.isMaster && hasSecrets(d) ? `<span class="secret-icon" title="Tem segredos">🔒</span>` : '';
        const visBadge = STATE.isMaster ? `<span class="vis-card-badge" title="Visibilidade">${visBadgeEmoji(d)}</span>` : '';
        const docImgHtml = d.imageUrl
          ? `<img class="acervo-card-img" src="${escHtml(d.imageUrl)}" alt="" onerror="this.style.display='none'">`
          : '';
        return `<div class="acervo-card doc-card" data-id="${d.id}" data-type="document">
          ${docImgHtml}
          <div class="acervo-card-body">
            ${!d.imageUrl ? `<span class="acervo-card-icon">${icon}</span>` : ''}
            <div class="acervo-card-name">${escHtml(d.name)}${secretBadge}</div>
            ${d.docType ? `<div class="acervo-card-type">${escHtml(d.docType)}</div>` : ''}
            <div class="acervo-card-meta">
              ${d.author ? `<span>por ${escHtml(d.author)}</span>` : ''}
              ${d.period ? `<span>${escHtml(d.period)}</span>` : ''}
              ${visBadge}
            </div>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty-state"><div class="empty-icon">📜</div><p>${STATE.isMaster ? 'Nenhum documento cadastrado.' : 'Nenhum documento disponível ainda.'}</p></div>`;

  itemsGrid.innerHTML = visibleItems.length
    ? visibleItems.map(i => {
        const icon = ITEM_TYPE_ICON[i.itemType] || '🗡';
        const rarityColor = ITEM_RARITY_COLOR[i.rarity] || '#7a9aaa';
        const secretBadge = STATE.isMaster && hasSecrets(i) ? `<span class="secret-icon" title="Tem segredos">🔒</span>` : '';
        const visBadge = STATE.isMaster ? `<span class="vis-card-badge" title="Visibilidade">${visBadgeEmoji(i)}</span>` : '';
        const imgHtml = i.imageUrl
          ? `<img class="acervo-card-img" src="${escHtml(i.imageUrl)}" alt="" onerror="this.style.display='none'">`
          : '';
        return `<div class="acervo-card item-card" data-id="${i.id}" data-type="item">
          ${imgHtml}
          <div class="acervo-card-body">
            ${!i.imageUrl ? `<span class="acervo-card-icon">${icon}</span>` : ''}
            <div class="acervo-card-name">${escHtml(i.name)}${secretBadge}</div>
            <div class="acervo-card-meta">
              ${i.rarity ? `<span class="acervo-card-rarity" style="color:${rarityColor}">${escHtml(i.rarity)}</span>` : ''}
              ${i.itemType ? `<span class="acervo-card-type">${escHtml(i.itemType)}</span>` : ''}
              ${visBadge}
            </div>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty-state"><div class="empty-icon">🗝</div><p>${STATE.isMaster ? 'Nenhum item cadastrado.' : 'Nenhum item disponível ainda.'}</p></div>`;

  docsGrid.querySelectorAll('.acervo-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, card.dataset.type));
  });
  itemsGrid.querySelectorAll('.acervo-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.id, card.dataset.type));
  });

  ensureAddBtn('docs-section',  'document', 'Novo Documento');
  ensureAddBtn('items-section', 'item',     'Novo Item');
}

function buildDocumentModalContent(id) {
  const d = getDocumentById(id);
  if (!d) return '';
  const icon = DOC_TYPE_ICON[d.docType] || '📄';
  const visSec = STATE.isMaster ? buildVisibilitySection(d, 'documents') : '';

  const imgHtml = d.imageUrl
    ? `<div class="modal-doc-img-wrap">
         <img src="${escHtml(d.imageUrl)}" alt="${escHtml(d.name)}" class="modal-doc-img"
              data-lightbox="${escHtml(d.imageUrl)}" style="cursor:zoom-in;"
              onerror="this.parentElement.style.display='none'">
       </div>`
    : '';

  const cv = d.contentVisibility || { mode: 'hidden', playerIds: [] };
  const myUid = STATE.user?.uid;
  const playerCanSeeContent = cv.mode === 'all' || (cv.mode === 'specific' && (cv.playerIds || []).includes(myUid));
  const showContent = STATE.isMaster || playerCanSeeContent;

  const contentVisSection = STATE.isMaster ? buildDocContentVisSection(d) : '';

  return `
    <div class="modal-doc-header">
      <span class="modal-doc-icon">${icon}</span>
      <div>
        <div class="modal-char-name">${escHtml(d.name)}</div>
        <div class="modal-char-role">${[d.docType, d.period].filter(Boolean).map(escHtml).join(' · ')}</div>
        ${d.author ? `<div class="modal-char-role" style="margin-top:2px;">por ${escHtml(d.author)}</div>` : ''}
      </div>
    </div>
    ${imgHtml}
    ${d.description ? `<div class="modal-section"><div class="modal-section-title">Descrição</div><div class="modal-section-text">${escHtml(d.description)}</div></div>` : ''}
    ${showContent && d.content ? `<div class="modal-section"><div class="modal-section-title">Conteúdo</div><div class="modal-doc-content">${escHtml(d.content)}</div></div>` : ''}
    ${contentVisSection}
    ${buildRelationsSectionFor(id, 'document')}
    ${visSec}
    ${buildCharSecretsHtml({ ...d, id })}
    ${buildAnnotationsSection(id, 'document')}
  `;
}

function buildDocContentVisSection(d) {
  const cv = d.contentVisibility || { mode: 'hidden', playerIds: [] };
  const isAll  = cv.mode === 'all';
  const isSpec = cv.mode === 'specific';
  const checks = STATE.players.filter(p => p.role === 'player').map(p => {
    const checked = (cv.playerIds || []).includes(p.uid) ? 'checked' : '';
    return `<label class="player-vis-label">
      <input type="checkbox" class="cv-player-check" data-uid="${p.uid}" ${checked}>
      <span>${escHtml(p.displayName || '')}</span>
    </label>`;
  }).join('') || '<span style="font-size:12px;color:var(--text-muted)">Nenhum jogador registrado.</span>';

  return `<div class="modal-section" id="doc-content-vis-section">
    <div class="modal-section-title">Visibilidade do Conteúdo</div>
    <div class="vis-row" id="doc-cv-btns" style="display:flex;gap:6px;margin-bottom:8px;">
      <button class="vis-btn ${!isAll && !isSpec ? 'active' : ''}" data-cv-mode="hidden">🔒 Oculto</button>
      <button class="vis-btn ${isAll ? 'active' : ''}" data-cv-mode="all">🌐 Todos</button>
      <button class="vis-btn ${isSpec ? 'active' : ''}" data-cv-mode="specific">👁 Específicos</button>
    </div>
    <div class="vis-players ${isSpec ? '' : 'vis-players-hidden'}" id="doc-cv-players">${checks}</div>
  </div>`;
}

function attachDocContentVisEvents(id) {
  if (!STATE.isMaster) return;
  const sec = document.getElementById('doc-content-vis-section');
  if (!sec) return;

  const d = getDocumentById(id);
  let currentMode     = (d?.contentVisibility?.mode)      || 'hidden';
  let currentPlayers  = [...(d?.contentVisibility?.playerIds || [])];

  async function save() {
    const oldCv  = d?.contentVisibility || { mode: 'hidden', playerIds: [] };
    const newVis = { mode: currentMode, playerIds: currentPlayers };
    await updateDoc(doc(db, 'campaigns', CAMPAIGN_ID, 'documents', id), { contentVisibility: newVis });
    const newlyVisible = STATE.players.filter(p => p.role === 'player').map(p => p.uid).filter(uid => {
      const was = oldCv.mode === 'all' || (oldCv.mode === 'specific' && (oldCv.playerIds || []).includes(uid));
      const now = currentMode === 'all' || (currentMode === 'specific' && currentPlayers.includes(uid));
      return !was && now;
    });
    if (newlyVisible.length) {
      const fresh = getDocumentById(id);
      await sendRevealNotifications(newlyVisible, 'document', id, fresh?.name || d?.name || '', 'content');
    }
  }

  sec.querySelectorAll('[data-cv-mode]').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentMode = btn.dataset.cvMode;
      sec.querySelectorAll('[data-cv-mode]').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('doc-cv-players').classList.toggle('vis-players-hidden', currentMode !== 'specific');
      await save();
    });
  });

  sec.querySelectorAll('.cv-player-check').forEach(chk => {
    chk.addEventListener('change', async () => {
      currentPlayers = [...sec.querySelectorAll('.cv-player-check:checked')].map(c => c.dataset.uid);
      await save();
    });
  });
}

function buildItemModalContent(id) {
  const item = getItemByIdFn(id);
  if (!item) return '';
  const icon = ITEM_TYPE_ICON[item.itemType] || '🗡';
  const rarityColor = ITEM_RARITY_COLOR[item.rarity] || '#7a9aaa';
  const imgHtml = item.imageUrl
    ? `<div class="modal-item-img-wrap"><img src="${escHtml(item.imageUrl)}" alt="${escHtml(item.name)}" class="modal-item-img" data-lightbox="${escHtml(item.imageUrl)}" style="cursor:zoom-in;"></div>`
    : `<div class="modal-item-icon-large">${icon}</div>`;
  const visSec = STATE.isMaster ? buildVisibilitySection(item, 'items') : '';
  return `
    <div class="modal-char-hero">
      ${imgHtml}
      <div class="modal-char-info">
        <div class="modal-char-name">${escHtml(item.name)}</div>
        ${item.rarity ? `<div class="modal-char-role" style="color:${rarityColor}">${escHtml(item.rarity)}</div>` : ''}
        ${item.itemType ? `<div class="modal-char-role">${escHtml(item.itemType)}</div>` : ''}
      </div>
    </div>
    ${item.description ? `<div class="modal-section"><div class="modal-section-title">Descrição</div><div class="modal-section-text">${escHtml(item.description)}</div></div>` : ''}
    ${buildRelationsSectionFor(id, 'item')}
    ${visSec}
    ${buildCharSecretsHtml({ ...item, id })}
    ${buildAnnotationsSection(id, 'item')}
  `;
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

  // Wire up edit button (ficha de jogador: só o mestre edita por aqui)
  const editBtn = document.getElementById('modal-edit-btn');
  if (editBtn) {
    editBtn.style.visibility = (type === 'player' && !STATE.isMaster) ? 'hidden' : '';
    editBtn.innerHTML = '✏ Editar';
    editBtn.onclick = () => openEditMode(id, type);
  }

  updateBreadcrumb();
  attachModalEvents();
  attachVisibilityEvents();
  attachAnnotationEvents();
  if (type === 'character') attachSecretVisEvents(id);
  if (type === 'player')    attachPlayerSecretVisEvents(id);
  if (type === 'document')  { attachEntitySecretVisEvents(id, 'documents', 'document', getDocumentById); attachDocContentVisEvents(id); }
  if (type === 'item')      attachEntitySecretVisEvents(id, 'items',     'item',     getItemByIdFn);
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

  // Gerenciar relação direto da ficha (mestre)
  document.getElementById('modal-body').querySelectorAll('.rel-manage-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const rel = STATE.data.relations.find(r => r.id === btn.dataset.relId);
      if (rel) openRelationDialog(rel);
    });
  });

  // Criar relação com origem pré-selecionada na ficha aberta (mestre)
  document.getElementById('modal-body').querySelectorAll('.modal-add-rel-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openRelationDialog(null, btn.dataset.relSource);
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
    player:    buildPlayerModalContent,
    document:  buildDocumentModalContent,
    item:      buildItemModalContent,
  })[type]?.(id) || '';
}

// ── MODAL: seção de Relações compartilhada ────────────────────────────────────
// Lista os laços de qualquer entidade; para o mestre inclui badge de
// visibilidade, botão ⚙ de gerenciamento e atalho para criar novo laço
function buildRelationsSectionFor(id, type) {
  const rels = STATE.data.relations.filter(r =>
    (r.sourceId === id && r.sourceType === type) ||
    (r.targetId === id && r.targetType === type)
  ).filter(r => {
    if (!STATE.isMaster && r.secret) return false;
    const otherId   = r.sourceId === id ? r.targetId   : r.sourceId;
    const otherType = r.sourceId === id ? r.targetType : r.sourceType;
    return getEntityName(otherId, otherType) !== otherId; // entidade visível
  });

  const relItems = rels.map(r => {
    const isSource     = r.sourceId === id;
    const otherId      = isSource ? r.targetId   : r.sourceId;
    const otherType    = isSource ? r.targetType : r.sourceType;
    const displayLabel = isSource ? (r.label || '') : (r.labelTo || r.label || '');
    const color = relTypeColor(r.type);
    return `<div class="modal-relation-tag" data-modal-id="${otherId}" data-modal-type="${otherType}">
      <div class="rel-type-indicator" style="background:${color}"></div>
      <span class="rel-target-name">${escHtml(getEntityName(otherId, otherType))}</span>
      <span class="rel-label-text">${escHtml(displayLabel)}</span>
      ${r.secret && STATE.isMaster ? '<span title="Relação secreta" style="opacity:.6;">🔒</span>' : ''}
      ${STATE.isMaster ? `<span class="rel-vis-badge" title="Visibilidade para jogadores">${visBadgeEmoji(r)}</span>
        <button class="rel-manage-btn" data-rel-id="${r.id}" title="Gerenciar esta relação">⚙</button>` : ''}
    </div>`;
  }).join('');

  if (!relItems && !STATE.isMaster) return '';
  return `<div class="modal-section"><div class="modal-section-title">Relações</div>
    <div class="modal-relations-list">${relItems}</div>
    ${!relItems && STATE.isMaster ? '<div class="rd-empty-note" style="margin-bottom:4px;">Nenhuma relação ainda.</div>' : ''}
    ${STATE.isMaster ? `<button class="add-new-btn modal-add-rel-btn" data-rel-source="${type}:${id}" style="margin:10px 0 0;">✚ Nova relação</button>` : ''}
  </div>`;
}

// ── MODAL: CHARACTER ──────────────────────────────────────────────────────────
function buildCharModalContent(id) {
  const c = getCharById(id);
  if (!c) return '';

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
    ${buildRelationsSectionFor(id, 'character')}
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
    ${buildEntitySecretsHtml(l)}
    ${buildRelationsSectionFor(id, 'location')}
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
    ${buildEntitySecretsHtml(e)}
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
    ${buildEntitySecretsHtml(f)}
    ${memberItems ? `<div class="modal-section"><div class="modal-section-title">Membros</div><div class="modal-link-list">${memberItems}</div></div>` : ''}
    ${locItems ? `<div class="modal-section"><div class="modal-section-title">Locais Controlados</div><div class="modal-link-list">${locItems}</div></div>` : ''}
    ${buildRelationsSectionFor(id, 'faction')}
    ${buildAnnotationsSection(id, 'faction')}
  `;
}

// ── MODAL: PLAYER ─────────────────────────────────────────────────────────────
function buildPlayerModalContent(uid) {
  const p = getPlayerByUid(uid);
  if (!p) return '';
  const pc   = p.playerCharacter || {};
  const name = playerCharName(p);

  const details = [pc.race, pc.charClass, pc.background].filter(Boolean).map(escHtml).join(' · ');

  const avatarHtml = pc.imageUrl
    ? `<div class="modal-char-avatar modal-char-avatar-clickable" title="Clique para ampliar">
         <img src="${escHtml(pc.imageUrl)}" alt="${escHtml(name)}" data-lightbox="${escHtml(pc.imageUrl)}"
           onerror="this.parentElement.innerHTML='<div class=\\'modal-char-avatar-placeholder\\'>${escHtml(name.charAt(0).toUpperCase())}</div>'">
       </div>`
    : `<div class="modal-char-avatar"><div class="modal-char-avatar-placeholder">${escHtml(name.charAt(0).toUpperCase())}</div></div>`;

  return `
    <div class="modal-char-hero">
      ${avatarHtml}
      <div class="modal-char-info">
        <div class="modal-char-name">${escHtml(name)}</div>
        <div class="modal-char-role">${details}</div>
        <div class="badges"><span class="badge player-badge">⚔ Jogador: ${escHtml(p.displayName || '')}</span></div>
      </div>
    </div>
    ${pc.appearance && (STATE.isMaster || isFieldVisible(pc, 'appearance', STATE.user.uid)) ? `<div class="modal-section"><div class="modal-section-title">Aparência</div><div class="modal-section-text">${escHtml(pc.appearance)}</div></div>` : ''}
    ${pc.personality && (STATE.isMaster || isFieldVisible(pc, 'personality', STATE.user.uid)) ? `<div class="modal-section"><div class="modal-section-title">Personalidade &amp; Motivações</div><div class="modal-section-text">${escHtml(pc.personality)}</div></div>` : ''}
    ${pc.history && (STATE.isMaster || isFieldVisible(pc, 'history', STATE.user.uid)) ? `<div class="modal-section"><div class="modal-section-title">História</div><div class="modal-section-text">${escHtml(pc.history)}</div></div>` : ''}
    ${pc.notes ? `<div class="modal-section"><div class="modal-section-title">Notas</div><div class="modal-section-text">${escHtml(pc.notes)}</div></div>` : ''}
    ${buildCharSecretsHtml({ ...pc, id: uid })}
    ${buildRelationsSectionFor(uid, 'player')}
    ${buildAnnotationsSection(uid, 'player')}
  `;
}

// ── GLOBAL SEARCH ─────────────────────────────────────────────────────────────
function buildSearchIndex() {
  const idx = [];
  STATE.data.characters.forEach(c => idx.push({ id: c.id, type: 'character', name: c.name, sub: c.role }));
  STATE.data.locations.forEach(l => idx.push({ id: l.id, type: 'location', name: l.name, sub: l.subtitle }));
  STATE.data.events.forEach(e => idx.push({ id: e.id, type: 'event', name: e.name, sub: e.period }));
  STATE.data.factions.forEach(f => idx.push({ id: f.id, type: 'faction', name: f.name, sub: f.type }));
  STATE.data.documents.forEach(d => idx.push({ id: d.id, type: 'document', name: d.name, sub: d.docType }));
  STATE.data.items.forEach(i => idx.push({ id: i.id, type: 'item', name: i.name, sub: i.itemType }));
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
        <span class="search-result-type type-${h.type}">${{character:'Personagem',location:'Local',event:'Evento',faction:'Facção',document:'Documento',item:'Item'}[h.type]}</span>
        <span class="search-result-name">${h.name}</span>
        <span class="search-result-sub">${h.sub || ''}</span>
      </div>`).join('');
    results.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', () => {
        overlay.classList.remove('open');
        input.value = '';
        results.innerHTML = '';
        const tabMap = { character: 'personagens', location: 'locais', event: 'eventos', faction: 'faccoes', document: 'acervo', item: 'acervo' };
        switchTab(tabMap[el.dataset.type]);
        setTimeout(() => openModal(el.dataset.id, el.dataset.type), 100);
      });
    });
  });
}

// ── GRAPH ─────────────────────────────────────────────────────────────────────
let graphSimulation = null;

const GRAPH_TYPE_LABEL = { character: 'Personagem', location: 'Local', event: 'Evento', faction: 'Facção', player: 'Jogador' };
const GRAPH_GLYPH      = { location: '🏝', event: '📜' };

// Imagem do nó: retrato do personagem, ou imageUrl de qualquer entidade que tenha
function nodeImgSrc(d) {
  if (d.type === 'character') {
    const c = getCharById(d.id);
    return c ? charImgSrc(c) : null;
  }
  if (d.type === 'player') return getPlayerByUid(d.id)?.playerCharacter?.imageUrl || null;
  const item = getItemById(d.id, d.type);
  return item?.imageUrl || null;
}

// Conteúdo do nó quando não há imagem: inicial (personagem/jogador), símbolo (facção) ou ícone
function appendNodeGlyph(node, d, r) {
  if (d.type === 'character' || d.type === 'player') {
    node.append('text').attr('class', 'node-initial')
      .attr('text-anchor', 'middle').attr('dy', '.36em')
      .attr('font-size', Math.round(r * 0.95))
      .attr('fill', d.type === 'player' ? 'rgba(106,198,198,.6)' : null)
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
  if (d.type === 'player') {
    const pc = getPlayerByUid(d.id)?.playerCharacter || {};
    return [pc.race, pc.charClass].filter(Boolean).join(' · ') || 'Personagem de jogador';
  }
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
  ['normal','secret','romantic','political','family','historical','neutral'].forEach(type => {
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

  const { character, location, event, faction, player } = STATE.graphFilters;
  const nodes   = [];
  const nodeMap = {};
  const addNode = (id, type, name) => { if (!nodeMap[id]) { nodeMap[id] = { id, type, name, degree: 0 }; nodes.push(nodeMap[id]); } };

  if (character) STATE.data.characters.forEach(c => addNode(c.id, 'character', c.name));
  if (location)  STATE.data.locations.forEach(l => addNode(l.id, 'location', l.name));
  if (event)     STATE.data.events.forEach(e => addNode(e.id, 'event', e.name));
  if (faction)   STATE.data.factions.forEach(f => addNode(f.id, 'faction', f.name));
  if (player)    listPlayerChars().forEach(p => addNode(p.uid, 'player', playerCharName(p)));

  const links = STATE.data.relations
    .filter(r => nodeMap[r.sourceId] && nodeMap[r.targetId])
    .map(r => ({ rel: r, source: r.sourceId, target: r.targetId, label: r.label, type: r.type || 'historical', secret: r.secret || false }));

  links.forEach(l => { if (nodeMap[l.source]) nodeMap[l.source].degree++; if (nodeMap[l.target]) nodeMap[l.target].degree++; });

  const NODE_COLOR = { character: '#cfac6e', location: '#5a8ab0', event: '#7a9a6a', faction: '#9a5a5a', player: '#4aa3a3' };
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

  // Área de toque invisível sobre cada aresta — clique abre o painel da relação
  const linkHitEl = linkG.selectAll('.graph-link-hit').data(links).enter()
    .append('line').attr('class', 'graph-link-hit')
    .attr('stroke', 'transparent').attr('stroke-width', 16)
    .style('cursor', 'pointer')
    .on('click', (e, d) => { e.stopPropagation(); openRelationDialog(d.rel); });

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
    linkHitEl
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
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

  const addRelBtn = document.getElementById('relation-add-btn');
  if (addRelBtn) addRelBtn.onclick = () => openRelationDialog(null);
}

// ── RELATION DIALOG (criar / ver / gerenciar laços) ───────────────────────────
const REL_TYPE_OPTIONS = [
  ['neutral',    'Neutra'],
  ['family',     'Família'],
  ['romantic',   'Romântica'],
  ['political',  'Política'],
  ['historical', 'Histórica'],
  ['secret',     'Secreta'],
];

function closeRelationDialog() {
  document.getElementById('relation-dialog-overlay')?.classList.remove('open');
}

function entityOptionsHtml(selectedVal = '') {
  const group = (label, items, type, nameFn) => {
    const opts = items.map(it => {
      const id  = type === 'player' ? it.uid : it.id;
      const val = `${type}:${id}`;
      return `<option value="${val}" ${val === selectedVal ? 'selected' : ''}>${escHtml(nameFn(it))}</option>`;
    }).join('');
    return opts ? `<optgroup label="${label}">${opts}</optgroup>` : '';
  };
  return group('Personagens', STATE.data.characters, 'character', c => c.name)
       + group('Jogadores',   listPlayerChars(),     'player',    playerCharName)
       + group('Locais',      STATE.data.locations,  'location',  l => l.name)
       + group('Eventos',     STATE.data.events,     'event',     e => e.name)
       + group('Facções',     STATE.data.factions,   'faction',   f => f.name)
       + group('Documentos',  STATE.data.documents,  'document',  d => d.name)
       + group('Itens',       STATE.data.items,      'item',      i => i.name);
}

function relVisibilityControlsHtml(rel) {
  if (!STATE.isMaster) return '';
  const mode   = rel?.visibility?.mode || 'hidden';
  const isAll  = mode === 'all';
  const isSpec = mode === 'specific';
  const checks = STATE.players.filter(p => p.role === 'player').map(p => {
    const checked = (rel?.visibility?.playerIds || []).includes(p.uid) ? 'checked' : '';
    return `<label class="player-vis-label">
      <input type="checkbox" class="rd-vis-check" data-uid="${p.uid}" ${checked}>
      <span>${escHtml(p.displayName || '')}</span>
    </label>`;
  }).join('') || '<span class="rd-empty-note">Nenhum jogador registrado ainda.</span>';

  return `<div class="rd-vis-section">
    <label class="edit-label">Quais jogadores podem ver esta relação?</label>
    <div class="vis-controls">
      <button type="button" class="vis-btn vis-btn-all ${isAll ? 'active' : ''}" data-mode="all">🌐 Todos</button>
      <button type="button" class="vis-btn ${isSpec ? 'active' : ''}" data-mode="specific">👁 Específicos</button>
      <button type="button" class="vis-btn ${!isAll && !isSpec ? 'active' : ''}" data-mode="hidden">🔒 Oculta</button>
    </div>
    <div class="vis-players ${isSpec ? '' : 'vis-players-hidden'}" id="rd-vis-players">${checks}</div>
  </div>`;
}

function openRelationDialog(rel = null, presetSource = '') {
  const overlay = document.getElementById('relation-dialog-overlay');
  const box     = document.getElementById('relation-dialog');
  if (!overlay || !box) return;

  const isNew   = !rel;
  const isOwner = !!rel && rel.createdBy === STATE.user?.uid;
  const canEdit = STATE.isMaster || isNew || isOwner;
  const me      = getPlayerByUid(STATE.user?.uid);
  const myVal   = `player:${STATE.user?.uid}`;

  // Jogador sem ficha preenchida não tem origem para criar laços
  if (isNew && !STATE.isMaster && !me?.playerCharacter?.name) {
    box.innerHTML = `
      <div class="rd-header"><div class="rd-title">✚ Nova Relação</div>
        <button class="rd-close" type="button">✕</button></div>
      <p class="rd-note">Preencha o nome do seu personagem na aba <strong>Meu Personagem</strong> antes de criar laços de relação.</p>`;
    overlay.classList.add('open');
    box.querySelector('.rd-close').onclick = closeRelationDialog;
    return;
  }

  const srcVal = rel ? `${rel.sourceType}:${rel.sourceId}` : (STATE.isMaster ? presetSource : myVal);
  const tgtVal = rel ? `${rel.targetType}:${rel.targetId}` : '';
  const typeOptions = REL_TYPE_OPTIONS
    .filter(([v]) => STATE.isMaster || v !== 'secret')
    .map(([v, l]) => `<option value="${v}" ${(rel?.type || 'neutral') === v ? 'selected' : ''}>${l}</option>`).join('');

  // Jogador criando: a origem é sempre o próprio personagem
  const sourceField = (!STATE.isMaster && isNew)
    ? `<div class="edit-field"><label class="edit-label">Origem</label>
         <div class="rd-fixed-source">⚔ ${escHtml(playerCharName(me))} <span>(seu personagem)</span></div>
         <input type="hidden" name="source" value="${myVal}"></div>`
    : `<div class="edit-field"><label class="edit-label">Origem *</label>
         <select class="edit-select" name="source" ${canEdit ? '' : 'disabled'}>
           <option value="">— Selecione —</option>${entityOptionsHtml(srcVal)}
         </select></div>`;

  box.innerHTML = `
    <div class="rd-header">
      <div class="rd-title">${isNew ? '✚ Nova Relação' : '🔗 Relação'}</div>
      <button class="rd-close" type="button">✕</button>
    </div>
    <form id="rd-form" class="rd-form">
      <div class="rd-row">
        ${sourceField}
        <div class="edit-field"><label class="edit-label">Alvo *</label>
          <select class="edit-select" name="target" ${canEdit ? '' : 'disabled'}>
            <option value="">— Selecione —</option>${entityOptionsHtml(tgtVal)}
          </select></div>
      </div>
      <div class="rd-row">
        <div class="edit-field"><label class="edit-label">Rótulo (origem → alvo) *</label>
          <input class="edit-input" name="label" value="${escHtml(rel?.label || '')}"
            placeholder="Ex: amigo de, deve favores a..." ${canEdit ? '' : 'disabled'}></div>
        <div class="edit-field"><label class="edit-label">Rótulo inverso (opcional)</label>
          <input class="edit-input" name="labelTo" value="${escHtml(rel?.labelTo || '')}"
            placeholder="Ex: credor de..." ${canEdit ? '' : 'disabled'}></div>
      </div>
      <div class="rd-row">
        <div class="edit-field"><label class="edit-label">Tipo</label>
          <select class="edit-select" name="type" ${canEdit ? '' : 'disabled'}>${typeOptions}</select></div>
        <div class="edit-field"><label class="edit-label">Descrição</label>
          <textarea class="edit-textarea" name="description" rows="2"
            placeholder="A história por trás deste laço..." ${canEdit ? '' : 'disabled'}>${escHtml(rel?.description || '')}</textarea></div>
      </div>
      ${STATE.isMaster ? `<label class="edit-checkbox-label rd-secret-check">
        <input type="checkbox" name="secret" ${rel?.secret ? 'checked' : ''}> Relação secreta (linha tracejada, marcada com 🔒)
      </label>` : ''}
      ${relVisibilityControlsHtml(rel)}
      <div class="rd-actions">
        ${canEdit ? `<button type="submit" class="edit-save-btn">${isNew ? '✚ Criar Relação' : '✔ Salvar'}</button>` : ''}
        <button type="button" class="edit-cancel-btn rd-cancel">Fechar</button>
        ${!isNew && (STATE.isMaster || isOwner) ? '<button type="button" class="edit-delete-btn rd-delete">🗑 Excluir</button>' : ''}
      </div>
    </form>`;

  overlay.classList.add('open');
  box.querySelector('.rd-close').onclick  = closeRelationDialog;
  box.querySelector('.rd-cancel').onclick = closeRelationDialog;

  // Controles de visibilidade (mestre)
  box.querySelectorAll('.rd-vis-section .vis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      box.querySelectorAll('.rd-vis-section .vis-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('rd-vis-players')
        ?.classList.toggle('vis-players-hidden', btn.dataset.mode !== 'specific');
    });
  });

  // Reabre o modal de entidade (se aberto) para refletir a mudança na ficha
  function refreshOpenModal() {
    const panelOpen = document.getElementById('modal-panel')?.classList.contains('open');
    if (panelOpen && STATE.modal.current) {
      openModal(STATE.modal.current.id, STATE.modal.current.type, false);
    }
  }

  const delBtn = box.querySelector('.rd-delete');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm('Excluir esta relação permanentemente?')) return;
    await deleteDoc(doc(db, 'campaigns', CAMPAIGN_ID, 'relations', rel.id));
    closeRelationDialog();
    refreshOpenModal();
  };

  document.getElementById('rd-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!canEdit) return;
    const form   = e.target;
    const fd     = new FormData(form);
    const source = String(fd.get('source') || '').split(':');
    const target = String(fd.get('target') || '').split(':');
    const label  = String(fd.get('label') || '').trim();
    if (source.length !== 2 || target.length !== 2 || !label) return;
    if (fd.get('source') === fd.get('target')) { alert('Origem e alvo devem ser diferentes.'); return; }

    const data = {
      sourceType: source[0], sourceId: source[1],
      targetType: target[0], targetId: target[1],
      label,
      labelTo:     String(fd.get('labelTo') || '').trim(),
      type:        fd.get('type') || 'neutral',
      description: String(fd.get('description') || '').trim(),
      secret:      STATE.isMaster ? fd.get('secret') === 'on' : (rel?.secret || false),
    };

    if (STATE.isMaster) {
      const mode = box.querySelector('.rd-vis-section .vis-btn.active')?.dataset.mode || 'hidden';
      // playerIds só é mantido no modo 'specific' — invariante das regras
      data.visibility = {
        mode,
        playerIds: mode === 'specific'
          ? [...box.querySelectorAll('.rd-vis-check:checked')].map(c => c.dataset.uid)
          : [],
      };
    }

    const saveBtn = form.querySelector('.edit-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Salvando...';

    try {
      if (isNew) {
        data.createdBy = STATE.user.uid;
        data.secretsVisibility = { mode: 'hidden', playerIds: [] };
        // Laços criados por jogadores nascem visíveis a todos; o mestre pode ocultar depois
        if (!STATE.isMaster) data.visibility = { mode: 'all', playerIds: [] };
        await addDoc(collection(db, 'campaigns', CAMPAIGN_ID, 'relations'), data);
      } else {
        await updateDoc(doc(db, 'campaigns', CAMPAIGN_ID, 'relations', rel.id), data);
      }
      closeRelationDialog();
      refreshOpenModal();
    } catch (err) {
      console.error('Relation save error:', err);
      saveBtn.disabled = false;
      saveBtn.textContent = '✘ Erro — tentar novamente';
    }
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
  return { character: 'Personagem', location: 'Local', event: 'Evento', faction: 'Facção', player: 'Jogador', document: 'Documento', item: 'Item' }[type] || type;
}

function typeCollName(type) {
  return { character: 'characters', location: 'locations', event: 'events', faction: 'factions', document: 'documents', item: 'items' }[type];
}

const getDocumentById = id => STATE.data.documents.find(d => d.id === id);
const getItemByIdFn   = id => STATE.data.items.find(i => i.id === id);

function getItemById(id, type) {
  return { character: getCharById, location: getLocationById, event: getEventById, faction: getFactionById, player: getPlayerByUid, document: getDocumentById, item: getItemByIdFn }[type]?.(id);
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
    player:    buildPlayerEditFields,
    document:  buildDocumentEditFields,
    item:      buildItemEditFields,
  }[type]?.(item) || '';

  return `<div class="edit-form-container">
    <form id="edit-form" class="edit-form">
      ${fields}
      <div class="edit-form-actions">
        <button type="submit" class="edit-save-btn">${isNew ? '✚ Criar' : '✔ Salvar Alterações'}</button>
        <button type="button" class="edit-cancel-btn">Cancelar</button>
        ${!isNew && type !== 'player' ? `<button type="button" class="edit-delete-btn">🗑 Excluir ${typeLabel(type)}</button>` : ''}
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

function buildDocumentEditFields(d = {}) {
  const imgSrc = d.imageUrl || '';
  const imgPreview = imgSrc
    ? `<img class="edit-img-preview" id="img-preview" src="${imgSrc}" alt="">`
    : `<div class="edit-img-placeholder" id="img-preview">Sem imagem</div>`;
  const docTypes = ['tomo','carta','diário','pergaminho','mapa','proclamação','decreto','inscrição','anotação','outro'];
  return `
    <div class="edit-form-section-title">Dados Básicos</div>
    ${editField('Nome *', editInput('name', d.name, 'Título do documento'))}
    <div class="edit-row">
      ${editField('Tipo', `<select class="edit-select" name="docType">
        ${docTypes.map(t => `<option ${d.docType===t?'selected':''}>${t}</option>`).join('')}
      </select>`)}
      ${editField('Período / Data', editInput('period', d.period, 'Ex: Pré-Maré Alta, Século III...'))}
    </div>
    ${editField('Autor', editInput('author', d.author, 'Quem escreveu este documento'))}
    ${editField('Descrição breve', editTextarea('description', d.description, 'Resumo público do documento...', 2))}

    <div class="edit-form-section-title">Conteúdo</div>
    ${editField('Texto do Documento', editTextarea('content', d.content, 'O texto que os jogadores leem ao encontrar este documento...', 8))}

    <div class="edit-form-section-title">Imagem (opcional)</div>
    <div class="edit-field">
      <label class="edit-label">Imagem / digitalização</label>
      <div class="edit-img-wrap">
        ${imgPreview}
        <div class="edit-img-controls">
          <input class="edit-file-input" type="file" id="img-file" accept="image/*">
          <label class="edit-file-label" for="img-file">📁 Escolher do PC</label>
          <div class="edit-img-separator">ou</div>
          ${editField('Cole uma URL de imagem', editInput('imageUrl', d.imageUrl || '', 'https://i.imgur.com/...'))}
        </div>
      </div>
    </div>

    <div class="edit-form-section-title">Segredos do Mestre</div>
    <div id="char-secrets-editor"></div>
    <button type="button" class="edit-add-secret-btn">+ Adicionar Segredo</button>
  `;
}

function buildItemEditFields(item = {}) {
  const imgSrc = item.imageUrl || '';
  const imgPreview = imgSrc
    ? `<img class="edit-img-preview" id="img-preview" src="${imgSrc}" alt="">`
    : `<div class="edit-img-placeholder" id="img-preview">Sem imagem</div>`;
  const itemTypes = ['chave','joia','artefato','amuleto','relíquia','moeda','símbolo','fragmento','outro'];
  const rarities  = ['comum','incomum','raro','muito raro','lendário'];
  return `
    <div class="edit-form-section-title">Dados Básicos</div>
    ${editField('Nome *', editInput('name', item.name, 'Nome do item'))}
    <div class="edit-row">
      ${editField('Tipo', `<select class="edit-select" name="itemType">
        ${itemTypes.map(t => `<option ${item.itemType===t?'selected':''}>${t}</option>`).join('')}
      </select>`)}
      ${editField('Raridade', `<select class="edit-select" name="rarity">
        ${rarities.map(r => `<option ${item.rarity===r?'selected':''}>${r}</option>`).join('')}
      </select>`)}
    </div>
    ${editField('Descrição', editTextarea('description', item.description, 'O que os jogadores sabem sobre este item...', 4))}

    <div class="edit-form-section-title">Imagem</div>
    <div class="edit-field">
      <label class="edit-label">Ilustração do item</label>
      <div class="edit-img-wrap">
        ${imgPreview}
        <div class="edit-img-controls">
          <input class="edit-file-input" type="file" id="img-file" accept="image/*">
          <label class="edit-file-label" for="img-file">📁 Escolher do PC</label>
          <div class="edit-img-separator">ou</div>
          ${editField('Cole uma URL de imagem', editInput('imageUrl', item.imageUrl || '', 'https://i.imgur.com/...'))}
        </div>
      </div>
    </div>

    <div class="edit-form-section-title">Segredos do Mestre</div>
    <div id="char-secrets-editor"></div>
    <button type="button" class="edit-add-secret-btn">+ Adicionar Segredo</button>
  `;
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
    <div id="char-secrets-editor"></div>
    <button type="button" class="edit-add-secret-btn">+ Adicionar Segredo</button>
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
    <div id="char-secrets-editor"></div>
    <button type="button" class="edit-add-secret-btn">+ Adicionar Segredo</button>
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
    <div id="char-secrets-editor"></div>
    <button type="button" class="edit-add-secret-btn">+ Adicionar Segredo</button>
  `;
}

function buildPlayerEditFields(p = {}) {
  const pc     = p.playerCharacter || {};
  const imgSrc = pc.imageUrl || '';
  const imgPreview = imgSrc
    ? `<img class="edit-img-preview" id="img-preview" src="${imgSrc}" alt="">`
    : `<div class="edit-img-placeholder" id="img-preview">Sem imagem</div>`;

  const sheetVis = pc.sheetVisibility || { mode: 'all', playerIds: [] };
  const allPlayers = STATE.players.filter(pp => pp.role === 'player' && pp.uid !== p.uid);

  function visBtn(mode, label) {
    return `<button type="button" class="pc-vis-btn pev-vis-btn${sheetVis.mode === mode ? ' active' : ''}" data-mode="${mode}">${label}</button>`;
  }
  const playerChecks = allPlayers.map(pp =>
    `<label class="pc-player-check-label">
      <input type="checkbox" class="pev-player-check" data-uid="${pp.uid}" ${(sheetVis.playerIds||[]).includes(pp.uid) ? 'checked' : ''}>
      ${escHtml(pp.displayName || pp.email)}
    </label>`
  ).join('') || '<span class="pc-no-players">Nenhum outro jogador ainda.</span>';

  return `
    <div class="edit-form-section-title">Foto do Personagem</div>
    <div class="edit-img-wrap">
      ${imgPreview}
      <div class="edit-img-actions">
        <label class="edit-img-upload-btn">📷 Enviar foto<input type="file" id="img-file" accept="image/*" style="display:none"></label>
        <div class="edit-img-uploading" id="edit-img-uploading" style="display:none;font-size:12px;color:var(--text-muted);">Enviando...</div>
      </div>
    </div>

    <div class="edit-form-section-title">Ficha de ${escHtml(p.displayName || 'Jogador')}</div>
    <div class="edit-row">
      ${editField('Nome do Personagem *', editInput('pcName', pc.name, 'Nome do personagem'))}
      ${editField('Raça', editInput('pcRace', pc.race, 'Ex: Humano, Elfo...'))}
    </div>
    <div class="edit-row">
      ${editField('Classe', editInput('pcClass', pc.charClass, 'Ex: Guerreiro, Mago...'))}
      ${editField('Antecedente', editInput('pcBackground', pc.background, 'Ex: Soldado, Sábio...'))}
    </div>
    ${editField('Aparência', editTextarea('pcAppearance', pc.appearance, 'Como o personagem parece...', 3))}
    ${editField('Personalidade & Motivações', editTextarea('pcPersonality', pc.personality, 'O que o personagem quer, teme, acredita...', 3))}
    ${editField('História do Personagem', editTextarea('pcHistory', pc.history, 'De onde veio, o que viveu, o que o moldou...', 4))}
    ${editField('Notas (visíveis a todos)', editTextarea('pcNotes', pc.notes, 'Anotações públicas da jornada...', 3))}

    <div class="edit-form-section-title">Visibilidade da Ficha</div>
    <div class="pc-vis-row" id="pev-sheet-vis-btns">
      ${visBtn('hidden','🔒 Só o jogador')}${visBtn('specific','👁 Específicos')}${visBtn('all','🌐 Todos')}
    </div>
    <div class="pc-vis-players-wrap${sheetVis.mode === 'specific' ? '' : ' pc-hidden'}" id="pev-sheet-vis-players">
      ${playerChecks}
    </div>

    <div class="edit-form-section-title">Segredos do Mestre</div>
    <div id="char-secrets-editor"></div>
    <button type="button" class="edit-add-secret-btn">+ Adicionar Segredo</button>
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
          <span>Personagem / Local</span>
          <span>Rótulo na minha ficha</span>
          <span>Rótulo no outro lado</span>
          <span title="Visibilidade para jogadores">Vis.</span>
          <span></span>
        </div>` +
        visible.map(r => {
          const idx       = relEdits.indexOf(r);
          const isSource  = r.sourceId === id || r._isNew;
          const otherId   = isSource ? r.targetId   : r.sourceId;
          const otherType = isSource ? (r.targetType || 'character') : (r.sourceType || 'character');
          const myLabel    = isSource ? (r.label   || '') : (r.labelTo || '');
          const theirLabel = isSource ? (r.labelTo || '') : (r.label   || '');
          const isSecret   = !!r.secret;
          const charOpts = STATE.data.characters.filter(c => c.id !== id)
            .map(c => `<option value="character:${c.id}" ${otherType === 'character' && c.id === otherId ? 'selected' : ''}>${c.name}</option>`)
            .join('');
          const locOpts = STATE.data.locations
            .map(l => `<option value="location:${l.id}" ${otherType === 'location' && l.id === otherId ? 'selected' : ''}>${l.name}</option>`)
            .join('');
          return `<div class="rel-row">
            <select class="edit-select rel-target" data-idx="${idx}">
              <option value="">— Selecionar —</option>
              <optgroup label="Personagens">${charOpts}</optgroup>
              ${locOpts ? `<optgroup label="Locais">${locOpts}</optgroup>` : ''}
            </select>
            <input class="edit-input rel-label-mine"   data-idx="${idx}" value="${escHtml(myLabel)}"    placeholder="Ex: mãe de, nasceu em...">
            <input class="edit-input rel-label-theirs" data-idx="${idx}" value="${escHtml(theirLabel)}" placeholder="Ex: filha de, berço de...">
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
          const [tType, tId] = sel.value ? sel.value.split(':') : ['character', ''];
          r.targetId = tId; r.targetType = tType;
          r.sourceId = id;  r.sourceType = 'character';
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

  // ── Player edit: sheet visibility wiring ──────────────────────────────────
  if (type === 'player') {
    const player = getPlayerByUid(id) || {};
    const pc     = player.playerCharacter || {};
    let   pevSheetVis = { ...(pc.sheetVisibility || { mode: 'all', playerIds: [] }), playerIds: [...(pc.sheetVisibility?.playerIds || [])] };

    document.getElementById('pev-sheet-vis-btns')?.querySelectorAll('.pev-vis-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        pevSheetVis.mode = mode;
        document.getElementById('pev-sheet-vis-btns').querySelectorAll('.pev-vis-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        document.getElementById('pev-sheet-vis-players').classList.toggle('pc-hidden', mode !== 'specific');
      });
    });
    document.getElementById('pev-sheet-vis-players')?.querySelectorAll('.pev-player-check').forEach(chk => {
      chk.addEventListener('change', () => {
        const uid = chk.dataset.uid;
        if (chk.checked) { if (!pevSheetVis.playerIds.includes(uid)) pevSheetVis.playerIds.push(uid); }
        else { const i = pevSheetVis.playerIds.indexOf(uid); if (i !== -1) pevSheetVis.playerIds.splice(i, 1); }
      });
    });
    // Expose to save path via closure on the form element
    form._pevSheetVis = pevSheetVis;
  }

  // ── Character / entity secrets editor (master-controlled) ─────────────────
  const SECRETS_EDITOR_TYPES = ['character', 'player', 'location', 'event', 'faction', 'document', 'item'];
  let charSecretsList = [];
  if (SECRETS_EDITOR_TYPES.includes(type)) {
    const getExisting = {
      character: () => getCharById(id),
      player:    () => getPlayerByUid(id)?.playerCharacter || null,
      location:  () => getLocationById(id),
      event:     () => getEventById(id),
      faction:   () => getFactionById(id),
      document:  () => getDocumentById(id),
      item:      () => getItemByIdFn(id),
    };
    const existingChar = getExisting[type]?.() || null;
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

    // Ficha de jogador: o mestre grava direto no perfil do usuário
    if (type === 'player') {
      try {
        const fd  = new FormData(form);
        const get = k => String(fd.get(k) || '').trim();
        const player = getPlayerByUid(id) || {};
        const merged = {
          ...(player.playerCharacter || {}),
          name:           get('pcName'),
          race:           get('pcRace'),
          charClass:      get('pcClass'),
          background:     get('pcBackground'),
          appearance:     get('pcAppearance'),
          personality:    get('pcPersonality'),
          history:        get('pcHistory'),
          notes:          get('pcNotes'),
          secretsList:    charSecretsList,
          sheetVisibility: form._pevSheetVis || (player.playerCharacter?.sheetVisibility || { mode: 'all', playerIds: [] }),
        };
        // Image upload
        const fileInput = document.getElementById('img-file');
        if (fileInput?.files[0]) {
          saveBtn.textContent = 'Enviando imagem...';
          merged.imageUrl = await uploadToCloudinary(fileInput.files[0]);
        }
        await updateDoc(doc(db, 'users', id), { playerCharacter: merged });
        if (player.uid) player.playerCharacter = merged;
        if (STATE.activeTab === 'relacoes') renderGraph();
        openModal(id, type, false);
      } catch (err) {
        console.error('Player sheet save error:', err);
        saveBtn.disabled = false;
        saveBtn.textContent = '✘ Erro — tentar novamente';
      }
      return;
    }

    try {
      const fd   = new FormData(form);
      const data = buildDataFromForm(fd, type);

      // Inject secrets list — managed outside FormData for all entity types
      if (SECRETS_EDITOR_TYPES.includes(type) && type !== 'player') data.secretsList = charSecretsList;

      // Upload de arquivo para Cloudinary (personagens, locais, documentos e itens)
      const fileInput = document.getElementById('img-file');
      if ((type === 'character' || type === 'location' || type === 'document' || type === 'item') && fileInput?.files[0]) {
        saveBtn.textContent = 'Enviando imagem...';
        data.imageUrl = await uploadToCloudinary(fileInput.files[0]);
      }

      if (id) {
        // Snapshot old secretsList before updating (for notification diff)
        const getOldEntity = { character: getCharById, location: getLocationById, event: getEventById, faction: getFactionById };
        const oldEntity = getOldEntity[type]?.(id) || null;
        const oldSecretsList = oldEntity?.secretsList || [];

        await updateDoc(doc(db, 'campaigns', CAMPAIGN_ID, typeCollName(type), id), data);

        // Send secret reveal notifications for newly-visible secrets
        const secretNotifTypes = ['character', 'location', 'event', 'faction'];
        if (secretNotifTypes.includes(type) && charSecretsList.length) {
          const entityName = data.name || oldEntity?.name || '';
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
              await sendRevealNotifications(newlyVisible, type, id, entityName, 'secret');
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
                targetId: r.targetId, targetType: r.targetType || 'character',
                label: r.label || '', labelTo: r.labelTo || '',
                type: 'neutral', secret: !!r.secret,
                visibility: relVis, secretsVisibility: defaultVis,
              });
              changed = true;
            } else if (!r._delete && !r._isNew && r.id) {
              // Só sobrescreve a visibilidade se o cadeado mudou — preserva
              // o modo "Específicos" configurado no diálogo de relação
              const orig = STATE.data.relations.find(x => x.id === r.id);
              const upd  = { label: r.label || '', labelTo: r.labelTo || '', secret: !!r.secret };
              if (!orig || !!orig.secret !== !!r.secret) {
                upd.visibility = r.secret ? defaultVis : { mode: 'all', playerIds: [] };
              }
              relBatch.update(doc(db, 'campaigns', CAMPAIGN_ID, 'relations', r.id), upd);
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
    // secretsList is injected from attachEditFormEvents
    const locUrlVal = get('imageUrl').trim();
    if (locUrlVal) data.imageUrl = locUrlVal;
  }

  if (type === 'event') {
    data.name        = get('name').trim();
    data.period      = get('period').trim();
    data.scale       = get('scale');
    data.order       = parseInt(get('order')) || 0;
    data.description = get('description').trim();
    // secretsList is injected from attachEditFormEvents
  }

  if (type === 'faction') {
    data.name        = get('name').trim();
    data.type        = get('type').trim();
    data.symbol      = get('symbol').trim() || '◆';
    data.color       = get('color').trim() || '#5a8ab0';
    data.description = get('description').trim();
    // secretsList is injected from attachEditFormEvents
    data.members     = fd.getAll('members');
  }

  if (type === 'document') {
    data.name        = get('name').trim();
    data.docType     = get('docType');
    data.period      = get('period').trim();
    data.author      = get('author').trim();
    data.description = get('description').trim();
    data.content     = get('content').trim();
    // secretsList is injected from attachEditFormEvents
    const urlVal = get('imageUrl').trim();
    if (urlVal) data.imageUrl = urlVal;
  }

  if (type === 'item') {
    data.name        = get('name').trim();
    data.itemType    = get('itemType');
    data.rarity      = get('rarity');
    data.description = get('description').trim();
    // secretsList is injected from attachEditFormEvents
    const urlVal = get('imageUrl').trim();
    if (urlVal) data.imageUrl = urlVal;
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
    showAuthError('Conta não encontrada. Verifique com o mestre.');
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
  renderAcervo();
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

  // Relation dialog: clique fora fecha
  const rdOverlay = document.getElementById('relation-dialog-overlay');
  if (rdOverlay) rdOverlay.addEventListener('click', e => { if (e.target === rdOverlay) closeRelationDialog(); });

  // Sync campaign data (master only)
  const syncBtn = document.getElementById('sync-campaign-btn');
  if (syncBtn) syncBtn.addEventListener('click', syncCampaignContent);

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

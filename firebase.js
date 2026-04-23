/**
 * DOM SUB HUB — Firebase Backend v2
 * Patched with improved error handling and auth recovery
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  linkWithCredential,
  EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBvSU5SpjuDBNn1BoH7p_njyaMOHxJwxgs",
  authDomain: "dom-sub-hub.firebaseapp.com",
  projectId: "dom-sub-hub",
  storageBucket: "dom-sub-hub.firebasestorage.app",
  messagingSenderId: "409837369295",
  appId: "1:409837369295:web:e7efef07a0b267936084ba",
  measurementId: "G-13NYW9WHHB"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

enableIndexedDbPersistence(db).catch(err => {
  console.warn('DSH persistence:', err.code);
});

let _currentUser      = null;
let _subUID           = null;
let _role             = null;
let _syncListeners    = {};
let _onReadyCallbacks = [];
let _isReady          = false;
let _authFailed       = false;

function subPath() {
  if (!_subUID) throw new Error('DSH: No sub UID — not authenticated yet.');
  return `users/${_subUID}`;
}

async function syncWrite(localKey, data) {
  try { localStorage.setItem(localKey, JSON.stringify(data)); } catch (e) {}
  if (!_subUID) return;
  try {
    await setDoc(doc(db, subPath(), 'data', localKey), {
      value: JSON.stringify(data),
      updatedAt: serverTimestamp(),
      updatedBy: _currentUser?.uid || 'unknown'
    }, { merge: true });
  } catch (e) {
    console.info('DSH: Firestore write queued:', e.code);
  }
}

async function syncRead(localKey) {
  if (_subUID) {
    try {
      const snap = await getDoc(doc(db, subPath(), 'data', localKey));
      if (snap.exists()) {
        const val = JSON.parse(snap.data().value);
        try { localStorage.setItem(localKey, JSON.stringify(val)); } catch {}
        return val;
      }
    } catch (e) {
      console.info('DSH: Firestore read failed, using localStorage:', e.code);
    }
  }
  try {
    const raw = localStorage.getItem(localKey);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function syncListen(localKey, callback) {
  if (!_subUID) return () => {};
  if (_syncListeners[localKey]) _syncListeners[localKey]();
  const unsub = onSnapshot(doc(db, subPath(), 'data', localKey), snap => {
    if (snap.exists()) {
      try {
        const val = JSON.parse(snap.data().value);
        try { localStorage.setItem(localKey, JSON.stringify(val)); } catch {}
        callback(val);
      } catch (e) {}
    }
  }, err => console.warn('DSH onSnapshot error:', err));
  _syncListeners[localKey] = unsub;
  return unsub;
}

function _markReady() {
  _isReady = true;
  _onReadyCallbacks.forEach(fn => { try { fn(_currentUser, _role); } catch (e) {} });
  _onReadyCallbacks = [];
  window.dispatchEvent(new CustomEvent('dsh:ready', {
    detail: { user: _currentUser, role: _role, subUID: _subUID, authFailed: _authFailed }
  }));
}

const DSH_auth = {

  async signInAnon() {
    try {
      const cred   = await signInAnonymously(auth);
      _currentUser = cred.user;
      _subUID      = cred.user.uid;
      _role        = 'sub';
      localStorage.setItem('dsh_uid',  _subUID);
      localStorage.setItem('dsh_role', 'sub');
      console.log('DSH: Anonymous sign-in OK:', _subUID);
      return cred.user;
    } catch (e) {
      console.error('DSH: Anonymous sign-in FAILED:', e.code, e.message);
      _authFailed = true;
      throw e;
    }
  },

  async createAccount(email, password) {
    if (!email || !password) throw new Error('Email and password are required.');
    try {
      let user;
      if (_currentUser && _currentUser.isAnonymous) {
        const credential = EmailAuthProvider.credential(email, password);
        const result     = await linkWithCredential(_currentUser, credential);
        user = result.user;
      } else {
        const result = await createUserWithEmailAndPassword(auth, email, password);
        user = result.user;
      }
      _currentUser = user;
      _subUID      = user.uid;
      _role        = 'sub';
      localStorage.setItem('dsh_uid',  _subUID);
      localStorage.setItem('dsh_role', 'sub');

      await setDoc(doc(db, 'accounts', email.toLowerCase()), {
        uid: _subUID, role: 'sub', createdAt: serverTimestamp()
      });

      console.log('DSH: Account created:', email);
      return user;
    } catch (e) {
      console.error('DSH: createAccount failed:', e.code, e.message);
      throw e;
    }
  },

  async signIn(email, password) {
    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      _currentUser = result.user;
      const domDoc = await getDoc(doc(db, 'domLinks', result.user.uid));
      if (domDoc.exists()) {
        _subUID = domDoc.data().subUID;
        _role   = 'dom';
        localStorage.setItem('dsh_uid',    result.user.uid);
        localStorage.setItem('dsh_subuid', _subUID);
        localStorage.setItem('dsh_role',   'dom');
      } else {
        _subUID = result.user.uid;
        _role   = 'sub';
        localStorage.setItem('dsh_uid',  _subUID);
        localStorage.setItem('dsh_role', 'sub');
      }
      return result.user;
    } catch (e) {
      console.error('DSH: signIn failed:', e.code, e.message);
      throw e;
    }
  },

  async signOut() {
    await signOut(auth);
    _currentUser = null; _subUID = null; _role = null;
    Object.values(_syncListeners).forEach(u => u());
    _syncListeners = {};
    ['dsh_uid','dsh_subuid','dsh_role'].forEach(k => localStorage.removeItem(k));
  },

  async linkDomToSub(subEmail) {
    try {
      const accountDoc = await getDoc(doc(db, 'accounts', subEmail.toLowerCase()));
      if (!accountDoc.exists()) throw new Error('No sub account found for that email.');
      const subUID = accountDoc.data().uid;
      await setDoc(doc(db, 'domLinks', _currentUser.uid), {
        subUID, subEmail: subEmail.toLowerCase(), linkedAt: serverTimestamp()
      });
      _subUID = subUID; _role = 'dom';
      localStorage.setItem('dsh_subuid', subUID);
      localStorage.setItem('dsh_role',   'dom');
      return subUID;
    } catch (e) {
      console.error('DSH: linkDomToSub failed:', e.code, e.message);
      throw e;
    }
  },

  getRole()   { return _role; },
  getUser()   { return _currentUser; },
  isAuthed()  { return !!_currentUser; },
  onReady(fn) { if (_isReady) fn(_currentUser, _role); else _onReadyCallbacks.push(fn); }
};

const DSH_data = {
  async getSettings()        { return await syncRead('sp_settings') || {}; },
  async saveSettings(d)      { await syncWrite('sp_settings', d); },
  watchSettings(cb)          { return syncListen('sp_settings', cb); },

  async getKegelTraining()   { return await syncRead('sirender_kegel_training') || {}; },
  async saveKegelTraining(d) { await syncWrite('sirender_kegel_training', d); },
  watchKegelTraining(cb)     { return syncListen('sirender_kegel_training', cb); },

  async get5Training()       { return await syncRead('sirender_5_training') || {}; },
  async save5Training(d)     { await syncWrite('sirender_5_training', d); },
  watch5Training(cb)         { return syncListen('sirender_5_training', cb); },

  async getPlugTraining()    { return await syncRead('sirender_plug_training') || {}; },
  async savePlugTraining(d)  { await syncWrite('sirender_plug_training', d); },
  watchPlugTraining(cb)      { return syncListen('sirender_plug_training', cb); },

  async getPosTraining()     { return await syncRead('sirender_pos_training') || {}; },
  async savePosTraining(d)   { await syncWrite('sirender_pos_training', d); },
  watchPosTraining(cb)       { return syncListen('sirender_pos_training', cb); },

  async getBdsmChecklist()   { return await syncRead('bdsm_checklist') || {}; },
  async saveBdsmChecklist(d) { await syncWrite('bdsm_checklist', d); },
  watchBdsmChecklist(cb)     { return syncListen('bdsm_checklist', cb); },

  async getSceneHistory()    { return await syncRead('sp_history') || []; },
  async saveSceneHistory(d)  { await syncWrite('sp_history', d); },

  async get(k)    { return await syncRead(k); },
  async set(k, d) { await syncWrite(k, d); },
  watch(k, cb)    { return syncListen(k, cb); },

  async migrateLocalToFirestore() {
    const keys = ['sp_settings','sirender_kegel_training','sirender_5_training',
                  'sirender_plug_training','sirender_pos_training','bdsm_checklist','sp_history'];
    let migrated = 0;
    for (const key of keys) {
      try {
        const raw = localStorage.getItem(key);
        if (raw) { await syncWrite(key, JSON.parse(raw)); migrated++; }
      } catch (e) { console.warn('DSH: migrate failed for', key, e); }
    }
    return migrated;
  }
};

// ── Auth state observer ──────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (user) {
    _currentUser = user;
    const cachedRole   = localStorage.getItem('dsh_role');
    const cachedSubUID = localStorage.getItem('dsh_subuid');
    if (cachedRole === 'dom' && cachedSubUID) {
      _subUID = cachedSubUID; _role = 'dom';
    } else {
      _subUID = user.uid;
      _role   = user.isAnonymous ? 'sub' : (cachedRole || 'sub');
      localStorage.setItem('dsh_uid',  _subUID);
      localStorage.setItem('dsh_role', _role);
    }
    console.log(`DSH: Auth ready — role:${_role} uid:${_subUID.slice(0,8)}...`);
    _markReady();
  } else {
    console.log('DSH: No session — attempting anonymous sign-in...');
    try {
      await DSH_auth.signInAnon();
    } catch (e) {
      // Anonymous auth not enabled — fall through to localStorage-only mode
      console.error('DSH: Anonymous auth failed. Go to Firebase Console → Authentication → Sign-in method → Enable Anonymous.');
      _markReady();
    }
  }
});

// ── Global export ────────────────────────────────────────
window.DSH = {
  auth: DSH_auth,
  data: DSH_data,
  get role()       { return _role; },
  get isDom()      { return _role === 'dom'; },
  get isSub()      { return _role === 'sub'; },
  get authFailed() { return _authFailed; }
};

export { DSH_auth as auth, DSH_data as data, db, auth };

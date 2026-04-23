/**
 * ╔══════════════════════════════════════════════════════╗
 * ║           DOM SUB HUB — Firebase Backend             ║
 * ║   Drop this file into your repo root, then add       ║
 * ║   <script type="module" src="firebase.js"></script>  ║
 * ║   to every HTML page (before your page script).      ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * FEATURES:
 *  - Anonymous auth (no login required, auto-persists)
 *  - Email/password auth for partner linking
 *  - localStorage-first (works offline, syncs when online)
 *  - Partner (Dom) read/write access to Sub's data
 *  - Real-time sync via Firestore onSnapshot
 *  - Exposes window.DSH global for all pages to use
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
  updateDoc,
  onSnapshot,
  collection,
  query,
  orderBy,
  serverTimestamp,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Your Firebase config ──────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBvSU5SpjuDBNn1BoH7p_njyaMOHxJwxgs",
  authDomain: "dom-sub-hub.firebaseapp.com",
  projectId: "dom-sub-hub",
  storageBucket: "dom-sub-hub.firebasestorage.app",
  messagingSenderId: "409837369295",
  appId: "1:409837369295:web:e7efef07a0b267936084ba",
  measurementId: "G-13NYW9WHHB"
};

// ── Initialize Firebase ───────────────────────────────────
const app   = initializeApp(firebaseConfig);
const auth  = getAuth(app);
const db    = getFirestore(app);

// Enable offline persistence (IndexedDB cache)
enableIndexedDbPersistence(db).catch(err => {
  if (err.code === 'failed-precondition') {
    console.warn('DSH: Multiple tabs open — offline persistence disabled for this tab.');
  } else if (err.code === 'unimplemented') {
    console.warn('DSH: Browser does not support offline persistence.');
  }
});

// ─────────────────────────────────────────────────────────
// INTERNAL STATE
// ─────────────────────────────────────────────────────────
let _currentUser   = null;   // Firebase User object
let _subUID        = null;   // UID of the Sub (data owner)
let _role          = null;   // 'sub' | 'dom'
let _syncListeners = {};     // active onSnapshot unsubscribe fns
let _onReadyCallbacks = [];  // fns to run once auth is ready
let _isReady       = false;

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

/** The Firestore path prefix for the active sub's data */
function subPath() {
  if (!_subUID) throw new Error('DSH: No sub UID set. Call DSH.auth.signIn() first.');
  return `users/${_subUID}`;
}

/** Write to localStorage AND Firestore (localStorage is source of truth offline) */
async function syncWrite(localKey, data) {
  // 1. Always write to localStorage immediately
  try {
    localStorage.setItem(localKey, JSON.stringify(data));
  } catch (e) {
    console.warn('DSH: localStorage write failed', e);
  }

  // 2. Write to Firestore if online & authed
  if (!_subUID) return;
  try {
    const ref = doc(db, subPath(), 'data', localKey);
    await setDoc(ref, {
      value: JSON.stringify(data),
      updatedAt: serverTimestamp(),
      updatedBy: _currentUser?.uid || 'unknown'
    }, { merge: true });
  } catch (e) {
    // Firestore offline — IndexedDB will queue it and sync when back online
    console.info('DSH: Firestore write queued (offline or error):', e.code);
  }
}

/** Read from Firestore first, fall back to localStorage */
async function syncRead(localKey) {
  // Try Firestore first if we're authed
  if (_subUID) {
    try {
      const ref  = doc(db, subPath(), 'data', localKey);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const val = JSON.parse(snap.data().value);
        // Update localStorage to keep in sync
        try { localStorage.setItem(localKey, JSON.stringify(val)); } catch {}
        return val;
      }
    } catch (e) {
      console.info('DSH: Firestore read failed, using localStorage:', e.code);
    }
  }

  // Fallback to localStorage
  try {
    const raw = localStorage.getItem(localKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Subscribe to real-time Firestore updates for a key */
function syncListen(localKey, callback) {
  if (!_subUID) return () => {};

  // Unsubscribe any existing listener for this key
  if (_syncListeners[localKey]) {
    _syncListeners[localKey]();
  }

  const ref = doc(db, subPath(), 'data', localKey);
  const unsub = onSnapshot(ref, snap => {
    if (snap.exists()) {
      try {
        const val = JSON.parse(snap.data().value);
        try { localStorage.setItem(localKey, JSON.stringify(val)); } catch {}
        callback(val);
      } catch (e) {
        console.warn('DSH: onSnapshot parse error', e);
      }
    }
  }, err => {
    console.warn('DSH: onSnapshot error', err);
  });

  _syncListeners[localKey] = unsub;
  return unsub;
}

// ─────────────────────────────────────────────────────────
// AUTH MODULE
// ─────────────────────────────────────────────────────────
const DSH_auth = {

  /**
   * Sign in anonymously (no email/password needed).
   * Sub uses this by default — data is tied to device UID.
   * Call once on app load; Firebase persists the session.
   */
  async signInAnon() {
    try {
      const cred = await signInAnonymously(auth);
      _currentUser = cred.user;
      _subUID      = cred.user.uid;
      _role        = 'sub';
      localStorage.setItem('dsh_uid', _subUID);
      localStorage.setItem('dsh_role', 'sub');
      console.log('DSH: Signed in anonymously as sub:', _subUID);
      return cred.user;
    } catch (e) {
      console.error('DSH: Anonymous sign-in failed:', e);
      throw e;
    }
  },

  /**
   * Create a named account (email/password).
   * Use this when Sub wants cross-device sync or to share with Dom.
   * If already signed in anonymously, this LINKS the account (preserves data).
   */
  async createAccount(email, password) {
    try {
      let user;
      if (_currentUser && _currentUser.isAnonymous) {
        // Upgrade anonymous → real account (keeps existing Firestore data)
        const credential = EmailAuthProvider.credential(email, password);
        const result = await linkWithCredential(_currentUser, credential);
        user = result.user;
      } else {
        const result = await createUserWithEmailAndPassword(auth, email, password);
        user = result.user;
      }
      _currentUser = user;
      _subUID      = user.uid;
      _role        = 'sub';
      localStorage.setItem('dsh_uid', _subUID);
      localStorage.setItem('dsh_role', 'sub');

      // Save the sub's UID to a public lookup doc so Dom can find it
      await setDoc(doc(db, 'accounts', email.toLowerCase()), {
        uid: _subUID,
        role: 'sub',
        createdAt: serverTimestamp()
      });

      console.log('DSH: Account created:', email);
      return user;
    } catch (e) {
      console.error('DSH: Create account failed:', e);
      throw e;
    }
  },

  /**
   * Sign in with email/password.
   * Both Sub and Dom use this after account creation.
   */
  async signIn(email, password) {
    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      _currentUser = result.user;

      // Check if this person is a Dom (linked to a sub's account)
      const domDoc = await getDoc(doc(db, 'domLinks', result.user.uid));
      if (domDoc.exists()) {
        _subUID = domDoc.data().subUID;
        _role   = 'dom';
        localStorage.setItem('dsh_uid', result.user.uid);
        localStorage.setItem('dsh_subuid', _subUID);
        localStorage.setItem('dsh_role', 'dom');
        console.log('DSH: Dom signed in, linked to sub:', _subUID);
      } else {
        _subUID = result.user.uid;
        _role   = 'sub';
        localStorage.setItem('dsh_uid', _subUID);
        localStorage.setItem('dsh_role', 'sub');
        console.log('DSH: Sub signed in:', _subUID);
      }

      return result.user;
    } catch (e) {
      console.error('DSH: Sign-in failed:', e);
      throw e;
    }
  },

  /**
   * Sign out and clear session.
   */
  async signOut() {
    await signOut(auth);
    _currentUser = null;
    _subUID      = null;
    _role        = null;
    Object.values(_syncListeners).forEach(unsub => unsub());
    _syncListeners = {};
    localStorage.removeItem('dsh_uid');
    localStorage.removeItem('dsh_subuid');
    localStorage.removeItem('dsh_role');
  },

  /**
   * Link a Dom account to a Sub's data.
   * Dom calls this with the Sub's email to get full read/write access.
   *
   * Usage: await DSH.auth.linkDomToSub('sub@example.com')
   */
  async linkDomToSub(subEmail) {
    try {
      // Look up the sub's UID from the public accounts collection
      const accountDoc = await getDoc(doc(db, 'accounts', subEmail.toLowerCase()));
      if (!accountDoc.exists()) {
        throw new Error('No sub account found for that email.');
      }
      const subUID = accountDoc.data().uid;

      // Save the link: Dom UID → Sub UID
      await setDoc(doc(db, 'domLinks', _currentUser.uid), {
        subUID,
        subEmail: subEmail.toLowerCase(),
        linkedAt: serverTimestamp()
      });

      _subUID = subUID;
      _role   = 'dom';
      localStorage.setItem('dsh_subuid', subUID);
      localStorage.setItem('dsh_role', 'dom');

      console.log('DSH: Dom linked to sub:', subUID);
      return subUID;
    } catch (e) {
      console.error('DSH: Dom link failed:', e);
      throw e;
    }
  },

  /** Returns current role: 'sub' | 'dom' | null */
  getRole() { return _role; },

  /** Returns current user object */
  getUser() { return _currentUser; },

  /** Returns true if there's an active session */
  isAuthed() { return !!_currentUser; },

  /** Register a callback to run once auth is ready */
  onReady(fn) {
    if (_isReady) fn(_currentUser, _role);
    else _onReadyCallbacks.push(fn);
  }
};

// ─────────────────────────────────────────────────────────
// DATA MODULE — mirrors all localStorage keys used in the app
// ─────────────────────────────────────────────────────────
const DSH_data = {

  // ── Settings (sp_settings) ──────────────────────────────
  async getSettings() {
    return await syncRead('sp_settings') || {};
  },
  async saveSettings(data) {
    await syncWrite('sp_settings', data);
  },
  watchSettings(callback) {
    return syncListen('sp_settings', callback);
  },

  // ── Training: Kegel ─────────────────────────────────────
  async getKegelTraining() {
    return await syncRead('sirender_kegel_training') || {};
  },
  async saveKegelTraining(data) {
    await syncWrite('sirender_kegel_training', data);
  },
  watchKegelTraining(callback) {
    return syncListen('sirender_kegel_training', callback);
  },

  // ── Training: The 5 ─────────────────────────────────────
  async get5Training() {
    return await syncRead('sirender_5_training') || {};
  },
  async save5Training(data) {
    await syncWrite('sirender_5_training', data);
  },
  watch5Training(callback) {
    return syncListen('sirender_5_training', callback);
  },

  // ── Training: Plug ──────────────────────────────────────
  async getPlugTraining() {
    return await syncRead('sirender_plug_training') || {};
  },
  async savePlugTraining(data) {
    await syncWrite('sirender_plug_training', data);
  },
  watchPlugTraining(callback) {
    return syncListen('sirender_plug_training', callback);
  },

  // ── Training: Positions ─────────────────────────────────
  async getPosTraining() {
    return await syncRead('sirender_pos_training') || {};
  },
  async savePosTraining(data) {
    await syncWrite('sirender_pos_training', data);
  },
  watchPosTraining(callback) {
    return syncListen('sirender_pos_training', callback);
  },

  // ── BDSM Checklists ─────────────────────────────────────
  async getBdsmChecklist() {
    return await syncRead('bdsm_checklist') || {};
  },
  async saveBdsmChecklist(data) {
    await syncWrite('bdsm_checklist', data);
  },
  watchBdsmChecklist(callback) {
    return syncListen('bdsm_checklist', callback);
  },

  // ── Scene History ───────────────────────────────────────
  async getSceneHistory() {
    return await syncRead('sp_history') || [];
  },
  async saveSceneHistory(data) {
    await syncWrite('sp_history', data);
  },

  // ── Generic: read/write any key ─────────────────────────
  async get(localKey) {
    return await syncRead(localKey);
  },
  async set(localKey, data) {
    await syncWrite(localKey, data);
  },
  watch(localKey, callback) {
    return syncListen(localKey, callback);
  },

  // ── Migration: push all localStorage to Firestore ───────
  async migrateLocalToFirestore() {
    const keys = [
      'sp_settings',
      'sirender_kegel_training',
      'sirender_5_training',
      'sirender_plug_training',
      'sirender_pos_training',
      'bdsm_checklist',
      'sp_history'
    ];

    let migrated = 0;
    for (const key of keys) {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const data = JSON.parse(raw);
          await syncWrite(key, data);
          migrated++;
          console.log(`DSH: Migrated '${key}' to Firestore`);
        }
      } catch (e) {
        console.warn(`DSH: Failed to migrate '${key}':`, e);
      }
    }
    console.log(`DSH: Migration complete — ${migrated} keys synced.`);
    return migrated;
  }
};

// ─────────────────────────────────────────────────────────
// AUTH STATE OBSERVER — runs on every page load
// ─────────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (user) {
    _currentUser = user;

    // Restore role from localStorage (fast path, avoids Firestore read)
    const cachedRole   = localStorage.getItem('dsh_role');
    const cachedSubUID = localStorage.getItem('dsh_subuid');

    if (cachedRole === 'dom' && cachedSubUID) {
      _subUID = cachedSubUID;
      _role   = 'dom';
    } else {
      _subUID = user.uid;
      _role   = user.isAnonymous ? 'sub' : (cachedRole || 'sub');
      localStorage.setItem('dsh_uid', _subUID);
      localStorage.setItem('dsh_role', _role);
    }

    console.log(`DSH: Auth ready — role: ${_role}, subUID: ${_subUID}`);
  } else {
    // Not signed in — auto sign in anonymously
    console.log('DSH: No session found, signing in anonymously...');
    await DSH_auth.signInAnon();
  }

  // Fire all onReady callbacks
  _isReady = true;
  _onReadyCallbacks.forEach(fn => fn(_currentUser, _role));
  _onReadyCallbacks = [];

  // Dispatch a DOM event so pages can listen without importing this module
  window.dispatchEvent(new CustomEvent('dsh:ready', {
    detail: { user: _currentUser, role: _role, subUID: _subUID }
  }));
});

// ─────────────────────────────────────────────────────────
// GLOBAL EXPORT
// ─────────────────────────────────────────────────────────
window.DSH = {
  auth: DSH_auth,
  data: DSH_data,

  /** Convenience: get current role */
  get role() { return _role; },

  /** Convenience: true if Dom is viewing */
  get isDom() { return _role === 'dom'; },

  /** Convenience: true if Sub is viewing */
  get isSub() { return _role === 'sub'; }
};

export { DSH_auth as auth, DSH_data as data, db, auth };

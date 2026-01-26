const admin = require("firebase-admin");
const crypto = require('crypto');

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
  const svc = JSON.parse(raw);

  // Fix private_key newlines (common env-var issue)
  if (svc.private_key) {
    svc.private_key = svc.private_key.replace(/\\n/g, "\n");
  }
  return svc;
}

function initAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(getServiceAccount()),
      projectId: process.env.FIREBASE_PROJECT_ID,
    });
  }
  return admin.firestore();
}

async function saveHistory(record) {
  const db = initAdmin();
  const nowIso = new Date().toISOString();
  const id = String(record.id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`));
  const createdAt = record.createdAt || nowIso;
  const nickname = String(record.nickname || '').trim().toLowerCase();
  const toSave = Object.assign({}, record, { id, createdAt, nickname });
  await db.collection("resume_history").doc(id).set(toSave, { merge: true });

  // Also upsert user index so lobby can list users cross-device
  try {
    if (nickname) {
      await db.collection('users').doc(nickname).set({
        nickname,
        updatedAt: createdAt,
        lastTitle: record.title || '',
      }, { merge: true });
    }
  } catch (_) {}
}

async function listUsers({ limit = 50 } = {}) {
  const db = initAdmin();
  // Prefer dedicated users collection
  try {
    // Only works reliably if updatedAt exists; keep but add a fallback below.
    const snap = await db.collection('users').orderBy('updatedAt', 'desc').limit(limit).get();
    const out = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      if (d.nickname) out.push({ nickname: d.nickname, updatedAt: d.updatedAt || '', lastTitle: d.lastTitle || '' });
    });
    if (out.length) return out;
    // If collection exists but empty (or missing updatedAt on docs), fall back to history derivation
  } catch (_) {}

  // Robust fallback: derive from resume_history even if the users query returned 0
  const snap = await db.collection('resume_history').orderBy('createdAt', 'desc').limit(limit * 10).get();
  const seen = new Set();
  const out = [];
  snap.forEach(doc => {
    const d = doc.data() || {};
    const n = String(d.nickname || '').trim().toLowerCase();
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push({ nickname: n, updatedAt: d.createdAt || d.updatedAt || '', lastTitle: d.title || '' });
  });
  return out.slice(0, limit);
}

function initDb() {
  return initAdmin();
}

module.exports = { saveHistory, listUsers, initDb };

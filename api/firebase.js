const admin = require("firebase-admin");

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
  const id = String(record.id || Date.now());
  await db.collection("resume_history").doc(id).set(record, { merge: true });

  // Also upsert user index so lobby can list users cross-device
  try {
    const nickname = String(record.nickname || '').trim().toLowerCase();
    if (nickname) {
      await db.collection('users').doc(nickname).set({
        nickname,
        updatedAt: record.createdAt || new Date().toISOString(),
        lastTitle: record.title || '',
      }, { merge: true });
    }
  } catch (_) {}
}

async function listUsers({ limit = 50 } = {}) {
  const db = initAdmin();
  // Prefer dedicated users collection
  try {
    const snap = await db.collection('users').orderBy('updatedAt', 'desc').limit(limit).get();
    const out = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      if (d.nickname) out.push({ nickname: d.nickname, updatedAt: d.updatedAt || '', lastTitle: d.lastTitle || '' });
    });
    return out;
  } catch (_) {
    // Fallback: derive from resume_history
    const snap = await db.collection('resume_history').orderBy('createdAt', 'desc').limit(limit * 5).get();
    const seen = new Set();
    const out = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      const n = String(d.nickname || '').trim().toLowerCase();
      if (!n || seen.has(n)) return;
      seen.add(n);
      out.push({ nickname: n, updatedAt: d.createdAt || '', lastTitle: d.title || '' });
    });
    return out.slice(0, limit);
  }
}

function initDb() {
  return initAdmin();
}

module.exports = { saveHistory, listUsers, initDb };

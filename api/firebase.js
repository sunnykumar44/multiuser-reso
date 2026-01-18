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
}

module.exports = { saveHistory };

const { initDb } = require('./firebase');

function normalizeNickname(n) {
  return String(n || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '');
}

// GET /api/history?limit=20&nickname=someNick
module.exports = async (req, res) => {
  // CORS (ok for testing; restrict later)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const nickname = normalizeNickname(req.query && req.query.nickname ? req.query.nickname : '');
    if (!nickname) return res.status(400).json({ ok: false, error: 'Missing nickname' });
    const limitRaw = (req.query && req.query.limit) ? Number(req.query.limit) : 20;
    const limit = Math.max(1, Math.min(limitRaw || 20, 50));

    const db = initDb();
    const snap = await db
      .collection('resume_history')
      .where('nickname', '==', nickname)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const items = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      items.push({
        id: String(d.id || doc.id),
        title: String(d.title || ''),
        createdAt: String(d.createdAt || ''),
        html: String(d.html || ''),
        jd: String(d.jd || ''),
        finalJD: String(d.finalJD || ''),
      });
    });

    return res.status(200).json({ ok: true, nickname, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? e.message : 'Failed to load history' });
  }
};

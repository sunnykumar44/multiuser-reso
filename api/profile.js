const { saveEncryptedProfile, getEncryptedProfile } = require('./firebase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const nickname = (req.query && req.query.nickname) ? String(req.query.nickname) : '';
      const out = await getEncryptedProfile({ nickname });
      if (!out) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.status(200).json({ ok: true, nickname: out.nickname, blob: out.blob, updatedAt: out.updatedAt });
    }

    if (req.method === 'PUT') {
      const body = (typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}');
      const nickname = String(body.nickname || '');
      const blob = body.blob;
      const createdAt = body.createdAt ? String(body.createdAt) : undefined;
      const out = await saveEncryptedProfile({ nickname, blob, createdAt });
      return res.status(200).json({ ok: true, nickname: out.nickname, updatedAt: out.updatedAt });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? e.message : 'Profile sync failed' });
  }
};

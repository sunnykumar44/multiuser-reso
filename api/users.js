const { listUsers } = require('./firebase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const limitRaw = (req.query && req.query.limit) ? req.query.limit : 50;
    const limit = Math.max(1, Math.min(Number(limitRaw || 50), 200));
    const users = await listUsers({ limit });
    const debug = (req.query && String(req.query.debug || '') === '1');
    return res.status(200).json({ ok: true, users, ...(debug ? { count: users.length } : {}) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : 'Failed to list users' });
  }
};

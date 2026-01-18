const { initDb } = require("./firebase");

// GET /api/history?limit=20
module.exports = async (req, res) => {
  // CORS (ok for testing; restrict later)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const limit = Math.min(
    50,
    Math.max(1, Number(req.query?.limit || 20))
  );

  try {
    const db = initDb();
    const snap = await db
      .collection("resume_history")
      .orderBy("date", "desc")
      .limit(limit)
      .get();

    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.status(200).json({ ok: true, items });
  } catch (e) {
    console.error("History fetch failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Failed to load history" });
  }
};

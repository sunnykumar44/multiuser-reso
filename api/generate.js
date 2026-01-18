const { saveHistory } = require("./firebase");

/**
 * POST /api/generate
 * Body: { profile, jd, mode, template, scope, nickname }
 */
module.exports = async (req, res) => {
  // CORS (ok for testing; restrict later)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = {};
  try {
    body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { profile, jd, mode, template, scope, nickname } = body;
  if (!jd || typeof jd !== "string") {
    return res.status(400).json({ error: "Missing job description (jd)" });
  }

  // --- STUB (replace later with Gemini call) ---
  const nameForDisplay = (profile && profile.fullName) || nickname || "User";
  const generatedHtml =
    `<div class="generated-resume">` +
    `<h2>Generated resume for ${escapeHtml(nameForDisplay)}</h2>` +
    `<p>Mode: ${escapeHtml(mode || "ats")}, Template: ${escapeHtml(template || "classic")}</p>` +
    `<pre>${escapeHtml(jd.slice(0, 400))}</pre>` +
    `</div>`;
  const generatedText = `Generated resume (stub) for ${nameForDisplay}`;
  // -------------------------------------------

  const record = {
    id: Date.now(),
    nickname: nickname || (profile && profile.nickname) || "anon",
    date: new Date().toISOString(),
    jdPreview: jd.slice(0, 140),
    mode: mode || "ats",
    template: template || "classic",
    scope: scope || null,
    htmlSnapshot: generatedHtml,
  };

  let historySaved = false;
  try {
    await saveHistory(record);
    historySaved = true;
  } catch (e) {
    console.error("Firestore save failed:", e?.message || e);
  }

  return res.status(200).json({
    ok: true,
    generated: { html: generatedHtml, text: generatedText },
    historySaved,
  });
};

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

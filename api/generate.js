// Simple Vercel / Netlify-style serverless function (Node)
const { saveHistory } = require("./upstash");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = {};
  try {
    body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  } catch (e) {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { profile, jd, mode, template, scope, nickname } = body;

  if (!jd || typeof jd !== "string") {
    return res.status(400).json({ error: "Missing job description (jd)" });
  }

  // --- STUB: replace this with real AI call (Vertex/Gemini) later ---
  // Use server-side GCP key (process.env.GCP_API_KEY) to call your AI provider.
  // For now return a safe stub so frontend wiring can be tested.
  const generatedHtml = `<div class="generated-resume"><h2>Generated resume for ${profile?.fullName || nickname || "User"}</h2><p>Mode: ${mode || "ats"}, Template: ${template || "classic"}</p><pre>${jd.slice(0, 400)}</pre></div>`;
  const generatedText = `Generated resume (stub) for ${profile?.fullName || nickname || "User"}`;

  // Prepare history record
  const rec = {
    id: Date.now(),
    nickname: nickname || profile?.nickname || "anon",
    date: new Date().toISOString(),
    jdPreview: (jd || "").slice(0, 140),
    mode: mode || "ats",
    template: template || "classic",
    htmlSnapshot: generatedHtml // optional; remove if you don't want snapshots
  };

  // Try to save to Upstash if configured (helper is a no-op if env not set)
  try {
    await saveHistory(rec);
  } catch (e) {
    console.error("Upstash save failed:", e?.message || e);
    // don't fail the request — history is best-effort
  }

  return res.status(200).json({
    ok: true,
    generated: {
      html: generatedHtml,
      text: generatedText,
    },
    historySaved: !!process.env.UPSTASH_REDIS_REST_URL,
  });
};
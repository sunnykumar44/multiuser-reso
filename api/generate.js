const { saveHistory } = require("./firebase");

const GCP_API_KEY = process.env.GCP_API_KEY || process.env.GOOGLE_API_KEY || null;

async function callGcpGenerate(promptText, maxTokens = 1024) {
  if (!GCP_API_KEY) throw new Error('GCP_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generate?key=${encodeURIComponent(GCP_API_KEY)}`;
  const body = { prompt: { text: promptText }, maxOutputTokens: Math.min(2048, maxTokens) };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`GCP generate failed ${resp.status}: ${txt}`);
  }
  const j = await resp.json();
  // Attempt to extract text from known response shapes
  const candidate = j?.candidates && j.candidates[0];
  if (candidate) {
    if (typeof candidate.output === 'string') return candidate.output;
    if (typeof candidate.content === 'string') return candidate.content;
    if (candidate?.message?.content && Array.isArray(candidate.message.content)) {
      // join message content pieces
      return candidate.message.content.map(c => c?.text || '').join('\n');
    }
  }
  // Fallback: return full JSON string
  return JSON.stringify(j);
}

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

  // Build strict prompt for the AI
  const safeProfile = profile && typeof profile === 'object' ? profile : {};
  const safeScope = Array.isArray(scope) ? scope : [];
  const promptLines = [];
  promptLines.push("You are an assistant that generates an HTML resume fragment.");
  promptLines.push("Follow these rules exactly:");
  promptLines.push("1) Output only valid HTML markup for the resume content — no explanations or commentary.");
  promptLines.push("2) Wrap the entire resume in a single <div class=\"generated-resume\">...</div>.");
  promptLines.push("3) Use semantic headings and lists where appropriate. Keep styling minimal and inline-free.");
  promptLines.push("4) Include only sections selected in the 'scope' array or those that have content in the profile.");
  promptLines.push("5) Do not include any API keys, tokens, or sensitive data in the output.");
  promptLines.push("");
  promptLines.push(`Job description:\n${jd.trim().slice(0,4000)}`);
  promptLines.push("");
  promptLines.push(`Profile (JSON):\n${JSON.stringify(safeProfile).slice(0,8000)}`);
  promptLines.push("");
  promptLines.push(`Requested mode: ${mode || 'ats'}, template: ${template || 'classic'}`);
  if (safeScope.length) promptLines.push(`Scope: ${safeScope.join(', ')}`);
  promptLines.push("");
  promptLines.push("Produce concise, well-structured HTML only.");

  const fullPrompt = promptLines.join('\n');

  let generatedHtml = null;
  let generatedText = null;

  // Try GCP Generative API if configured
  if (GCP_API_KEY) {
    try {
      const aiText = await callGcpGenerate(fullPrompt, 1024);
      // aiText expected to be HTML; if not, wrap safely
      generatedHtml = String(aiText);
      generatedText = (generatedHtml || '').replace(/<[^>]+>/g, '').slice(0, 1000);
    } catch (err) {
      console.error('GCP generate failed:', err.message || err);
    }
  }

  // Fallback to stub if no AI result
  if (!generatedHtml) {
    const displayName = (profile && profile.fullName) || nickname || 'User';
    generatedHtml = `<div class="generated-resume"><h2>Generated resume for ${escapeHtml(displayName)}</h2><p>Mode: ${escapeHtml(mode || 'ats')}, Template: ${escapeHtml(template || 'classic')}</p><pre>${escapeHtml(jd.slice(0, 400))}</pre></div>`;
    generatedText = `Generated resume (stub) for ${displayName}`;
  }

  const record = {
    id: Date.now(),
    nickname: nickname || (profile && profile.nickname) || 'anon',
    date: new Date().toISOString(),
    jdPreview: jd.slice(0, 140),
    mode: mode || 'ats',
    template: template || 'classic',
    scope: scope || null,
    htmlSnapshot: generatedHtml,
  };

  let historySaved = false;
  try {
    await saveHistory(record);
    historySaved = true;
  } catch (e) {
    console.error('History save failed:', e?.message || e);
  }

  return res.status(200).json({ ok: true, generated: { html: generatedHtml, text: generatedText }, historySaved });
};

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

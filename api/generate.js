const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS (Defined at top to prevent ReferenceErrors) ---
function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '');
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
// -------------------------------------------------------------------

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
  const candidate = j?.candidates && j.candidates[0];
  if (candidate) {
    if (typeof candidate.output === 'string') return candidate.output;
    if (typeof candidate.content === 'string') return candidate.content;
    if (candidate?.message?.content && Array.isArray(candidate.message.content)) {
      return candidate.message.content.map(c => c?.text || '').join('\n');
    }
  }
  return JSON.stringify(j);
}

function buildFallback(profile = {}, jd = '', mode = 'ats', template = 'classic', safeScope = [], nickname) {
  const displayName = (profile && profile.fullName) || nickname || 'User';
  const contacts = [];
  if (profile.phone) contacts.push(escapeHtml(profile.phone));
  if (profile.email) contacts.push(escapeHtml(profile.email));
  if (profile.linkedin) contacts.push(`<a href="${escapeHtml(profile.linkedin)}" target="_blank">LinkedIn</a>`);
  const headerHtml = `<div class="profile-header"><h1>${escapeHtml(displayName)}</h1>${contacts.length?`<div class="profile-contact">${contacts.join(' | ')}</div>`:''}</div>`;

  const jdSnippet = escapeHtml((jd || '').slice(0, 400));

  // Determine ordered sections to render based on requested scope or defaults
  const order = ['Summary','Skills','Education','Work Experience','Projects','Certifications','Achievements','Character Traits'];
  const wanted = (Array.isArray(safeScope) && safeScope.length) ? order.filter(o => safeScope.map(s=>String(s).toLowerCase()).includes(o.toLowerCase())) : order;

  const pieces = [];
  pieces.push(`<div class="generated-resume">${headerHtml}`);

  // Helper to push section once
  function pushSection(title, innerHtml) {
    if (!innerHtml) return;
    pieces.push(`<section class="sec-${slugify(title)}"><h3>${escapeHtml(title)}</h3>${innerHtml}</section>`);
  }

  // Summary
  if (wanted.includes('Summary')) {
    const txt = profile.summary ? escapeHtml(profile.summary) : '';
    pushSection('Summary', txt ? `<p>${txt}</p>` : '');
  }

  // Skills
  if (wanted.includes('Skills')) {
    const skills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(/\r?\n/) : []);
    if (skills && skills.length) {
      const items = skills.map(s=>`<li>${escapeHtml(s)}</li>`).join('\n');
      pushSection('Skills', `<ul>${items}</ul>`);
    }
  }

  // Education
  if (wanted.includes('Education')) {
    const edu = Array.isArray(profile.education) ? profile.education : (profile.college ? [profile.college] : []);
    if (edu && edu.length) {
      const items = edu.map(e=>`<div>${escapeHtml(String(e))}</div>`).join('\n');
      pushSection('Education', items);
    }
  }

  // Work Experience and Projects — entries-style
  if (wanted.includes('Work Experience') || wanted.includes('Projects')) {
    const entries = Array.isArray(profile.customSections) ? profile.customSections.filter(s=>s && String(s.type||'')==='entries') : [];
    // filter entries for work/project titles if specific
    let relevant = entries;
    if (wanted.includes('Work Experience') && !wanted.includes('Projects')) {
      relevant = entries.filter(e => String(e.title||'').toLowerCase().includes('work') || String(e.title||'').toLowerCase().includes('experience'));
    }
    if (relevant.length) {
      for (const sec of relevant) {
        const title = sec.title || 'Experience';
        const inner = (sec.items||[]).map(it=>{
          const bullets = Array.isArray(it.bullets) ? it.bullets.map(b=>`<li>${escapeHtml(b)}</li>`).join('\n') : '';
          return `<div class="entry"><strong>${escapeHtml(it.key||'')}</strong>${bullets?`<ul>${bullets}</ul>`:''}</div>`;
        }).join('\n');
        pushSection(title, inner);
      }
    }
  }

  // Generic custom sections: Certifications, Achievements, Character Traits
  const cs = Array.isArray(profile.customSections) ? profile.customSections : [];
  for (const name of ['Certifications','Achievements','Character Traits']) {
    if (!wanted.includes(name)) continue;
    const match = cs.find(c => String(c.title||'').trim().toLowerCase().includes(name.toLowerCase().split(' ')[0]));
    if (match) {
      if (match.type === 'entries') {
        const inner = (match.items||[]).map(it=>`<div><strong>${escapeHtml(it.key||'')}</strong>${Array.isArray(it.bullets)&&it.bullets.length?`<ul>${it.bullets.map(b=>`<li>${escapeHtml(b)}</li>`).join('\n')}</ul>`:''}</div>`).join('\n');
        pushSection(match.title, inner);
      } else {
        const inner = (match.items||[]).map(i=>`<li>${escapeHtml(String(i||''))}</li>`).join('\n');
        pushSection(match.title, inner ? `<ul>${inner}</ul>` : '');
      }
    }
  }

  // Target role
  if (jdSnippet) pushSection('Target role', `<pre>${jdSnippet}</pre>`);

  pieces.push('</div>');
  return { html: pieces.join('\n'), text: `Generated resume (fallback) for ${displayName}` };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    let body = {};
    try {
      body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const { profile, jd, mode, template, scope, nickname } = body;
    if (!jd || typeof jd !== "string") {
      const fallback = buildFallback(profile || {}, jd || '', mode, template, scope || [], nickname);
      return res.status(400).json({ error: 'Missing job description (jd)', ok: false, generated: { html: fallback.html, text: fallback.text } });
    }

    const safeProfile = profile && typeof profile === 'object' ? profile : {};
    const safeScope = Array.isArray(scope) ? scope : [];
    
    // ... Prompt generation ...
    const promptLines = [];
    promptLines.push("You are an assistant that generates an HTML resume fragment.");
    promptLines.push("Follow these rules exactly:");
    promptLines.push("1) Output only valid HTML markup for the resume content — no explanations or commentary.");
    promptLines.push("2) Wrap the entire resume in a single <div class=\"generated-resume\">...</div>.");
    promptLines.push("3) Use semantic headings and lists where appropriate. Keep styling minimal and inline-free.");
    promptLines.push("4) Do NOT include any top-level header like 'Generated resume for ...' or 'Mode: ...'.");
    promptLines.push("5) Follow this exact section order where present: header (name + contacts), Summary (1–3 sentences), Technical Skills (bulleted list) / Skills, Education, Work Experience (entries with bullets), Projects (entries), Certifications, Achievements, Character Traits.");
    promptLines.push("6) Only include sections that are present in the profile or are explicitly listed in the scope array. Do not repeat sections.");
    promptLines.push("7) Use bullets for lists (ul/li). Use concise sentences for Summary. For experience entries use a bold heading and a ul of bullet points.");
    promptLines.push("8) Do not include API keys, tokens, or sensitive data in the output.");
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

    if (GCP_API_KEY) {
      try {
        const aiText = await callGcpGenerate(fullPrompt, 1024);
        generatedHtml = String(aiText);
        generatedText = (generatedHtml || '').replace(/<[^>]+>/g, '').slice(0, 1000);
      } catch (err) {
        console.error('GCP generate failed:', err.message || err);
      }
    }

    if (!generatedHtml) {
      const fallback = buildFallback(profile || {}, jd || '', mode, template, scope || [], nickname);
      generatedHtml = fallback.html;
      generatedText = fallback.text;
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
  } catch (err) {
    console.error('Unhandled /api/generate error:', err);
    try {
      const safeBody = (req && (typeof req.body === 'object') && req.body) ? req.body : {};
      const fb = buildFallback(safeBody.profile || {}, safeBody.jd || '', safeBody.mode || 'ats', safeBody.template || 'classic', safeBody.scope || [], safeBody.nickname || null);
      return res.status(200).json({ ok: true, generated: { html: fb.html, text: fb.text }, historySaved: false, error: String(err) });
    } catch (inner) {
      // This part should no longer crash because slugify is definitely defined
      console.error('Fallback generation also failed:', inner);
      return res.status(500).json({ ok: false, error: 'Fatal server error' });
    }
  }
};
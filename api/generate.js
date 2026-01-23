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

// Optional Upstash rate-limit setup (safe if packages/env not present)
let rateLimiter = null;
let upstashEnabled = false;
try {
  const { Ratelimit } = require('@upstash/ratelimit');
  const { Redis } = require('@upstash/redis');
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    rateLimiter = new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(20, '1 d'), analytics: true, prefix: '@upstash:resume' });
    upstashEnabled = true;
  }
} catch (e) {
  // ignore if not installed
}

// Helper to wrap fragment into full DOCTYPE page if needed
function wrapFullPage(htmlFragment, profile) {
  const name = (profile && profile.fullName) ? escapeHtml(profile.fullName) : '';
  const email = profile?.email ? escapeHtml(profile.email) : '';
  const phone = profile?.phone ? escapeHtml(profile.phone) : '';
  const headerContact = [email && `<a href="mailto:${email}">${email}</a>`, phone].filter(Boolean).join(' | ');
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;padding:12px;max-width:800px;margin:0 auto}h1{font-size:20px;margin-bottom:4px}h2{font-size:14px;margin-top:12px;border-bottom:1px solid #e2e8f0;padding-bottom:6px}</style></head><body>` +
    (name ? `<h1>${name}</h1><div style="margin-bottom:8px;color:#475569">${headerContact}</div>` : '') +
    `<div class="resume-body">${htmlFragment}</div></body></html>`;
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
    try { body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

    const { profile, jd, mode, template, scope, nickname, pin } = body;

    // Optional PIN check (protect API from abuse) — set APP_PIN in env
    if (process.env.APP_PIN) {
      if (!pin || String(pin) !== String(process.env.APP_PIN)) {
        return res.status(401).json({ ok: false, error: 'Unauthorized: invalid PIN' });
      }
    }

    // Optional rate-limit by PIN or IP
    let quota = null;
    if (upstashEnabled && rateLimiter) {
      try {
        const id = pin || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'anon';
        const { success, limit, remaining, reset } = await rateLimiter.limit(id);
        quota = { success, limit, remaining, reset: new Date(reset).toISOString() };
        if (!success) {
          return res.status(429).json({ ok: false, error: 'Quota exceeded', quota });
        }
      } catch (rlErr) {
        console.warn('Rate limit check failed', rlErr);
      }
    }

    if (!jd || typeof jd !== 'string') {
      const fallback = buildFallback(profile || {}, jd || '', mode, template, scope || [], nickname);
      const html = wrapFullPage(fallback.html, profile || {});
      return res.status(400).json({ ok: false, error: 'Missing job description (jd)', generated: { html: fallback.html, text: fallback.text, page: html }, quota });
    }

    // Strengthened prompt: require full DOCTYPE HTML page output and section order
    const strategyNote = (mode === 'faang') ? 'Emphasize scale and measurable impact.' : (mode === 'startup' ? 'Emphasize versatility and ownership.' : 'Focus on ATS-friendly keywords and concise bullets.');
    const fullPrompt = `CRITICAL: Output ONLY valid HTML starting with <!DOCTYPE html>. Use a single-page A4 layout.\n\nPROFILE_JSON:\n${JSON.stringify(profile || {}).slice(0,12000)}\n\nJOB_DESCRIPTION:\n${String(jd).slice(0,8000)}\n\nINSTRUCTIONS: Produce a resume with this exact order when present: header (name + contacts), Summary (1-3 sentences), Technical Skills (bulleted), Education, Work Experience (entries with bullets), Projects, Certifications, Achievements, Character Traits. Use semantic HTML (h1/h2/section/ul/li) and avoid any leading lines like 'Generated resume for' or 'Mode:'. Keep styling minimal and inline-free. Strategy: ${strategyNote}`;

    // Call GCP - request full-page HTML
    let generatedHtml = null;
    let generatedText = null;
    if (GCP_API_KEY) {
      try {
        const aiText = await callGcpGenerate(fullPrompt, 2048);
        // try to extract starting at <!DOCTYPE html>
        let html = String(aiText || '');
        const idx = html.toLowerCase().indexOf('<!doctype html>');
        if (idx >= 0) html = html.substring(idx);
        // strip markdown fences
        html = html.replace(/```html|```/gi, '');
        generatedHtml = html;
        generatedText = (generatedHtml || '').replace(/<[^>]+>/g, '').slice(0,2000);
      } catch (gErr) {
        console.error('GCP generate failed:', gErr?.message || gErr);
      }
    }

    // Fallback to structured builder and wrap into full page
    if (!generatedHtml) {
      const fallback = buildFallback(profile || {}, jd || '', mode, template, scope || [], nickname);
      const page = wrapFullPage(fallback.html, profile || {});
      generatedHtml = page; // return full page
      generatedText = fallback.text;
    }

    // Save history if available
    try { await saveHistory({ id: Date.now(), nickname: nickname || (profile && profile.nickname) || 'anon', date: new Date().toISOString(), jdPreview: String(jd).slice(0,140), mode, template, scope, htmlSnapshot: generatedHtml }); } catch(e){ console.warn('history save failed', e); }

    return res.status(200).json({ ok: true, resume: generatedHtml, text: generatedText, quota });

  } catch (err) {
    console.error('Unhandled /api/generate error:', err);
    try { const fb = buildFallback((req.body && req.body.profile) || {}, (req.body && req.body.jd) || '', 'ats', 'classic', (req.body && req.body.scope) || [], (req.body && req.body.nickname) || null); const page = wrapFullPage(fb.html, (req.body && req.body.profile) || {}); return res.status(200).json({ ok: true, resume: page, text: fb.text, quota: null, error: String(err) }); } catch(inner){ console.error('fallback also failed', inner); return res.status(500).json({ ok:false, error: 'Fatal server error' }); }
  }
};
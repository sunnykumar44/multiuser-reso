const { saveHistory } = require("./firebase");
const crypto = require('crypto');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_KEY || process.env.GCP_API_KEY;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 20);

// Global state for daily limit
globalThis.__DAILY_LIMIT_STATE__ = globalThis.__DAILY_LIMIT_STATE__ || { date: null, byUser: new Map() };

// --- HELPERS ---
function escapeHtml(s = "") {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function todayUtc() { return new Date().toISOString().slice(0, 10); }

function makeSeed() {
  const buf = crypto.randomBytes(8);
  return (buf.readUInt32LE(0) ^ buf.readUInt32LE(4)) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleSeeded(arr, rand) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function getUserKey(body, req) {
  const p = (body && body.profile && typeof body.profile === 'object') ? body.profile : {};
  return String(body?.userId || p.email || body?.nickname || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anonymous');
}

function consumeOne(userKey) {
  const state = globalThis.__DAILY_LIMIT_STATE__;
  const d = todayUtc();
  if (state.date !== d) { state.date = d; state.byUser = new Map(); }
  const used = Number(state.byUser.get(userKey) || 0);
  if (used >= DAILY_LIMIT) return { ok: false, remaining: 0, used, limit: DAILY_LIMIT };
  state.byUser.set(userKey, used + 1);
  return { ok: true, remaining: DAILY_LIMIT - (used + 1), used: used + 1, limit: DAILY_LIMIT };
}

function refundDailyTicket(userKey) {
  try {
    const state = globalThis.__DAILY_LIMIT_STATE__;
    const used = Number(state.byUser.get(userKey) || 0);
    if (used > 0) state.byUser.set(userKey, used - 1);
  } catch (_) {}
}

function seededSynonymSwap(text, rand) {
  const swaps = [
    [/(improved|improving)/gi, () => (rand() > 0.5 ? 'enhanced' : 'improved')],
    [/(reduced|reducing)/gi, () => (rand() > 0.5 ? 'lowered' : 'reduced')],
    [/(built)/gi, () => (rand() > 0.5 ? 'developed' : 'built')],
    [/(created)/gi, () => (rand() > 0.5 ? 'implemented' : 'created')],
  ];
  let out = String(text || '');
  for (const [re, rep] of swaps) out = out.replace(re, rep);
  return out;
}

function seededBumpMetric(text, rand) {
  const s = String(text || '');
  if (/%/.test(s)) return s;
  if (rand() < 0.35) return `${s} (~${Math.floor(rand() * 25) + 10}% impact).`;
  return s;
}

function splitPipeBullets(val) {
  return String(val || '').split('|').map(s => s.trim()).filter(Boolean);
}

function stripRolePrefix(bullet, roleTitle) {
  const b = String(bullet || '').trim();
  const role = String(roleTitle || '').trim();
  if (!b || !role) return b;
  const re = new RegExp('^' + role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[–-:]\\s*', 'i');
  return b.replace(re, '').trim();
}

function isLikelyTechnical(token) {
  const techs = ['python','java','sql','airflow','etl','spark','docker','aws','gcp','bigquery','tableau','react','node','git','pandas','numpy','scikit'];
  const t = String(token).toLowerCase();
  return techs.some(k => t.includes(k));
}

// Validation logic
function validateSummary(text) { return text && text.trim().length > 30; }
function validateSkills(val) {
  const parts = String(val).split(/[,|\n]+/).filter(Boolean);
  return parts.length >= 6 && parts.filter(isLikelyTechnical).length >= 3;
}
function validateProjects(val) {
  return String(val).split('|').length >= 2 || String(val).includes('<li>');
}
function validateAchievements(val) {
  return /\d+%|\b\d+\b/.test(String(val)) || /\b(improv|reduc|automat|saved)\b/i.test(String(val));
}

// AI Callers
async function callGeminiFlash(promptText, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: opts.temperature || 0.9,
      responseMimeType: "application/json"
    }
  };
  const resp = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (!resp.ok) throw new Error(`AI Error ${resp.status}`);
  const j = await resp.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error('Empty AI response');
  return txt;
}

async function retryCriticalSection(kind, jd) {
  try {
    const prompt = `Generate exactly 2 realistic ${kind} for a fresher resume matching this JD: "${jd.slice(0,500)}". Return plain text separated by " | ". MUST be specific and professional.`;
    const resp = await callGeminiFlash(prompt, { temperature: 1.0 });
    return resp.replace(/```json|```/g, '').trim();
  } catch (_) { return ''; }
}

// --- MAIN HANDLER ---
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16)}`;
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const { profile = {}, jd = '', scope = [] } = body;

    if (!jd || jd.length < 5) return res.status(400).json({ ok: false, error: 'JD missing' });

    const userKey = getUserKey(body, req);
    const ticket = consumeOne(userKey);
    if (!ticket.ok) return res.status(429).json({ ok: false, error: 'Daily limit reached', debug: { daily: ticket } });

    const requestSeed = makeSeed();
    const rand = mulberry32(requestSeed);
    const sections = scope.length ? scope : ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Certifications', 'Achievements', 'Character Traits'];

    const mainPrompt = `Generate a resume in JSON format for this candidate profile: ${JSON.stringify(profile)} 
    strictly matching this Job Description: "${jd}".
    REQUIRED KEYS: summary (3 sentences), skills (10-15 comma separated), experience (2 bullets pipe separated), projects (2 items pipe separated), certifications (2 items pipe separated), achievements (2 items pipe separated), traits (6 comma separated).
    Output valid JSON only.`;

    let aiData = null;
    try {
      const respTxt = await callGeminiFlash(mainPrompt);
      aiData = JSON.parse(respTxt.replace(/```json|```/g, '').trim());
    } catch (e) {
      refundDailyTicket(userKey);
      return res.status(503).json({ ok: false, error: 'AI root generation failed' });
    }

    const validators = {
      summary: validateSummary,
      skills: validateSkills,
      projects: validateProjects,
      achievements: validateAchievements,
      experience: v => String(v).length > 20,
      certifications: v => String(v).includes(' | ') || String(v).includes('|'),
      traits: v => String(v).split(',').length >= 4
    };

    const finalData = {};
    for (const key of ['summary', 'skills', 'experience', 'projects', 'certifications', 'achievements', 'traits']) {
      let val = aiData[key];
      let isValid = validators[key] ? validators[key](val) : !!val;

      if (!isValid) {
        val = await retryCriticalSection(key, jd);
        isValid = validators[key] ? validators[key](val) : (val && val.length > 5);
      }

      if (!isValid) {
        refundDailyTicket(userKey);
        return res.status(503).json({ ok: false, error: `AI failed section: ${key}` });
      }
      finalData[key] = val;
    }

    // Build HTML
    let html = `<div class="generated-resume"><style>.generated-resume{font-family:Helvetica,Arial,sans-serif;padding:20px;color:#1e293b} .skill-tag{display:inline-block;padding:3px 8px;margin:2px;background:#f1f5f9;border-radius:4px;font-size:11px;font-weight:600} .resume-section-title{font-weight:bold;margin:15px 0 5px;border-bottom:1px solid #e2e8f0;text-transform:uppercase;font-size:12px}</style>`;
    html += `<h1 style="text-align:center;margin-bottom:2px">${escapeHtml((profile.fullName || 'User').toUpperCase())}</h1>`;

    const sectionMapping = {
      'Summary': () => `<div class="resume-section-title">Summary</div><p style="font-size:11px">${escapeHtml(finalData.summary)}</p>`,
      'Technical Skills': () => `<div class="resume-section-title">Technical Skills</div><div>${finalData.skills.split(',').map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join('')}</div>`,
      'Work Experience': () => `<div class="resume-section-title">Work Experience</div><ul>${splitPipeBullets(finalData.experience).map(b => `<li style="font-size:11px">${escapeHtml(stripRolePrefix(b, ''))}</li>`).join('')}</ul>`,
      'Projects': () => `<div class="resume-section-title">Projects</div><ul>${splitPipeBullets(finalData.projects).map(p => `<li style="font-size:11px">${escapeHtml(p)}</li>`).join('')}</ul>`,
      'Certifications': () => `<div class="resume-section-title">Certifications</div><ul>${splitPipeBullets(finalData.certifications).map(c => `<li style="font-size:11px">${escapeHtml(c)}</li>`).join('')}</ul>`,
      'Achievements': () => `<div class="resume-section-title">Achievements</div><ul>${splitPipeBullets(finalData.achievements).map(a => `<li style="font-size:11px">${escapeHtml(seededBumpMetric(seededSynonymSwap(a, rand), rand))}</li>`).join('')}</ul>`,
      'Character Traits': () => `<div class="resume-section-title">Character Traits</div><div>${finalData.traits.split(',').map(t => `<span class="skill-tag">${escapeHtml(t.trim())}</span>`).join('')}</div>`
    };

    for (const s of sections) if (sectionMapping[s]) html += sectionMapping[s]();
    html += `</div>`;

    try { await saveHistory({ id: requestId, jd, profile, html, createdAt: new Date().toISOString() }); } catch (_) {}

    return res.status(200).json({ ok: true, generated: { html }, debug: { requestId, aiOnly: true } });
  } catch (err) {
    console.error('Final Error', err);
    return res.status(500).json({ ok: false, error: 'Internal Error' });
  }
};

const { saveHistory } = require("./firebase");
const crypto = require('crypto');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_KEY || process.env.GCP_API_KEY;
// --- PURE AI MODE GENERATOR ---

// HTML escaping
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
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function seededSynonymSwap(text, rand = Math.random) {
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

function seededBumpMetric(text, rand = Math.random) {
  const s = String(text || '');
  if (/%/.test(s)) return s;
  if (rand() < 0.35) return `${s} (~${Math.floor(rand() * 25) + 10}% impact).`;
  return s;
}

// Validation helpers
function isLikelyTechnical(token) {
  const techs = ['python','java','sql','airflow','etl','spark','docker','aws','gcp','bigquery','tableau','react','node','git'];
  const t = String(token).toLowerCase();
  return techs.some(k => t.includes(k));
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

// API Interaction
async function callGeminiFlash(promptText, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const model = opts.model || 'models/gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${GEMINI_API_KEY}`;
  
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: opts.temperature || 0.9,
      topP: 0.95,
      maxOutputTokens: opts.maxOutputTokens || 2048,
      responseMimeType: "application/json"
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`Gemini Error ${resp.status}: ${await resp.text()}`);
  const j = await resp.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error('No AI response content');
  return txt;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16)}`;
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const { profile = {}, jd = '', scope = [] } = body;

    if (!jd || jd.trim().length < 5) return res.status(400).json({ ok: false, error: 'JD too short or missing' });

    const requestSeed = makeSeed();
    const rand = mulberry32(requestSeed);

    const sections = (scope.length ? scope : ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Certifications', 'Achievements', 'Character Traits']);
    const prompts = {
      summary: `Write a 3 sentence professional Summary for a candidate applying to: "${jd}". Mention specific technical skills and eagerness. Return as "summary" key.`,
      skills: `List 10-15 technical skills (comma-separated) for: "${jd}". Return as "skills" key.`,
      experience: `Generate 2 measurable impact bullets (pipe-separated) for an intern role aligned with: "${jd}". Return as "experience" key.`,
      projects: `Generate 2 projects (title: description) for: "${jd}". Use tech stack. Return as "projects" key.`,
      certifications: `Generate 2 real certification names for: "${jd}". Pipe-separated. Return as "certifications" key.`,
      achievements: `Generate 2 measurable achievements for: "${jd}". Pipe-separated. Return as "achievements" key.`,
      traits: `List 6 soft skills for: "${jd}". Comma-separated. Return as "traits" key.`
    };

    const mainPrompt = `Generate a resume in JSON format.
JD: "${jd}"
Profile: ${JSON.stringify(profile)}
Keys required: ${Object.keys(prompts).join(', ')}
Rules: Strictly follow JD requirements. Be specific. No generics.`;

    let aiData = null;
    try {
      const respTxt = await callGeminiFlash(mainPrompt);
      aiData = JSON.parse(respTxt.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('AI Main Call Failed', e);
      return res.status(503).json({ ok: false, error: 'AI generation failed', detail: e.message });
    }

    // Process and Build HTML
    let html = `<div class="generated-resume"><style>.generated-resume{font-family:sans-serif;padding:20px;line-height:1.4} .resume-section-title{font-weight:bold;margin-top:15px;border-bottom:1px solid #ccc;text-transform:uppercase;font-size:13px} .skill-tag{display:inline-block;padding:2px 6px;margin:2px;background:#f0f0f0;font-size:11px;border-radius:3px}</style>`;
    html += `<h1 style="text-align:center;margin-bottom:5px">${escapeHtml((profile.fullName || 'User').toUpperCase())}</h1>`;

    const sectionMap = {
      'Summary': { k: 'summary', f: v => `<p style="font-size:11px">${escapeHtml(v)}</p>` },
      'Technical Skills': { k: 'skills', f: v => v.split(',').map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ') },
      'Work Experience': { k: 'experience', f: v => `<ul>${splitPipeBullets(v).map(b => `<li style="font-size:11px">${escapeHtml(b)}</li>`).join('')}</ul>` },
      'Projects': { k: 'projects', f: v => `<ul>${String(v).split('|').map(p => `<li style="font-size:11px">${escapeHtml(p.trim())}</li>`).join('')}</ul>` },
      'Certifications': { k: 'certifications', f: v => `<ul>${String(v).split('|').map(c => `<li style="font-size:11px">${escapeHtml(c.trim())}</li>`).join('')}</ul>` },
      'Achievements': { k: 'achievements', f: v => `<ul>${String(v).split('|').map(a => `<li style="font-size:11px">${escapeHtml(seededBumpMetric(a, rand))}</li>`).join('')}</ul>` },
      'Character Traits': { k: 'traits', f: v => v.split(',').map(t => `<span class="skill-tag">${escapeHtml(t.trim())}</span>`).join(' ') }
    };

    for (const s of sections) {
      const map = sectionMap[s];
      if (map && aiData[map.k]) {
        html += `<div class="resume-section-title">${s}</div>`;
        html += `<div class="resume-item">${map.f(aiData[map.k])}</div>`;
      }
    }
    html += `</div>`;

    const debug = { requestId, requestSeed, aiOnly: true };

    try {
      await saveHistory({ id: requestId, jd, profile, html, createdAt: new Date().toISOString() });
    } catch (sh) {}

    return res.status(200).json({ ok: true, generated: { html }, debug });
  } catch (err) {
    console.error('Final Match Error', err);
    return res.status(500).json({ ok: false, error: 'Internal Server Error', detail: err.message });
  }
};

// Re-apply the comprehensive AI-only logic with strict validation, retry, and immediate 503 error on failure, removing all illegal continue statements and role-preset fallbacks.

const { saveHistory } = require("./firebase");
const crypto = require('crypto');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_KEY || process.env.GCP_API_KEY;
// --- PURE AI MODE GENERATOR ---

// HTML escaping
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
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function seededSynonymSwap(text, rand = Math.random) {
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

function seededBumpMetric(text, rand = Math.random) {
  const s = String(text || '');
  if (/%/.test(s)) return s;
  if (rand() < 0.35) return `${s} (~${Math.floor(rand() * 25) + 10}% impact).`;
  return s;
}

// Validation helpers
function isLikelyTechnical(token) {
  const techs = ['python','java','sql','airflow','etl','spark','docker','aws','gcp','bigquery','tableau','react','node','git'];
  const t = String(token).toLowerCase();
  return techs.some(k => t.includes(k));
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

// API Interaction
async function callGeminiFlash(promptText, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const model = opts.model || 'models/gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${GEMINI_API_KEY}`;
  
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: opts.temperature || 0.9,
      topP: 0.95,
      maxOutputTokens: opts.maxOutputTokens || 2048,
      responseMimeType: "application/json"
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`Gemini Error ${resp.status}: ${await resp.text()}`);
  const j = await resp.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error('No AI response content');
  return txt;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16)}`;
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const { profile = {}, jd = '', scope = [] } = body;

    if (!jd || jd.trim().length < 5) return res.status(400).json({ ok: false, error: 'JD too short or missing' });

    const requestSeed = makeSeed();
    const rand = mulberry32(requestSeed);

    const sections = (scope.length ? scope : ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Certifications', 'Achievements', 'Character Traits']);
    const prompts = {
      summary: `Write a 3 sentence professional Summary for a candidate applying to: "${jd}". Mention specific technical skills and eagerness. Return as "summary" key.`,
      skills: `List 10-15 technical skills (comma-separated) for: "${jd}". Return as "skills" key.`,
      experience: `Generate 2 measurable impact bullets (pipe-separated) for an intern role aligned with: "${jd}". Return as "experience" key.`,
      projects: `Generate 2 projects (title: description) for: "${jd}". Use tech stack. Return as "projects" key.`,
      certifications: `Generate 2 real certification names for: "${jd}". Pipe-separated. Return as "certifications" key.`,
      achievements: `Generate 2 measurable achievements for: "${jd}". Pipe-separated. Return as "achievements" key.`,
      traits: `List 6 soft skills for: "${jd}". Comma-separated. Return as "traits" key.`
    };

    const mainPrompt = `Generate a resume in JSON format.
JD: "${jd}"
Profile: ${JSON.stringify(profile)}
Keys required: ${Object.keys(prompts).join(', ')}
Rules: Strictly follow JD requirements. Be specific. No generics.`;

    let aiData = null;
    try {
      const respTxt = await callGeminiFlash(mainPrompt);
      aiData = JSON.parse(respTxt.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('AI Main Call Failed', e);
      return res.status(503).json({ ok: false, error: 'AI generation failed', detail: e.message });
    }

    // Validate and Process AI Data
    const aiKeys = Object.keys(aiData);
    const aiPrompts = {};
    const aiTypes = {};
    const aiLabels = {};

    for (const pid of aiKeys) {
      const val = aiData[pid];
      let type = 'text';
      let label = '';

      if (pid === 'summary') type = 'summary';
      else if (pid === 'skills') { type = 'chips'; label = 'Technical Skills'; }
      else if (pid === 'experience') { type = 'list'; label = 'Work Experience'; }
      else if (pid === 'projects') { type = 'list'; label = 'Projects'; }
      else if (pid === 'certifications') { type = 'list'; label = 'Certifications'; }
      else if (pid === 'achievements') { type = 'list'; label = 'Achievements'; }
      else if (pid === 'traits') { type = 'chips'; label = 'Character Traits'; }

      aiPrompts[pid] = { val, type, label };
      aiTypes[pid] = type;
      aiLabels[pid] = label;
    }

    const finalJD = jd.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();

    // Validation functions
    function validateSummary(val, rolePreset) {
      if (val.split('.').length < 3) return false;
      const hasTech = /python|java|sql|airflow|etl|spark|docker|aws|gcp|bigquery|tableau|react|node|git/i.test(val);
      return hasTech;
    }

    function validateSkills(val, finalJD) {
      const skills = val.split(/[,|\n]+/).map(s => s.trim()).filter(Boolean);
      if (skills.length < 5) return false;
      const hasTech = skills.some(s => /python|java|sql|airflow|etl|spark|docker|aws|gcp|bigquery|tableau|react|node|git/i.test(s));
      return hasTech;
    }

    function validateProjects(val, rolePreset) {
      const projects = splitPipeBullets(val);
      if (projects.length < 2) return false;
      return true;
    }

    function validateAchievements(val) {
      const achievements = splitPipeBullets(val);
      if (achievements.length < 2) return false;
      return true;
    }

    // Retry logic for critical sections
    async function retryCriticalSection(pid, label) {
      const prompt = `Generate ${label} for JD: "${jd}". Be specific and use real examples.`;
      try {
        const respTxt = await callGeminiFlash(prompt);
        return respTxt;
      } catch (e) {
        console.error('AI Retry Call Failed', e);
        return null;
      }
    }

    // Validate AI data and retry if necessary
    const debug = { requestId, requestSeed, aiOnly: true, invalidAI: {} };

    for (const pid of Object.keys(aiPrompts)) {
      let val = aiData ? aiData[pid] : undefined;
      const type = aiTypes[pid];
      const label = aiLabels[pid] || '';

      // Basic existence check + type-specific validation
      let valid = (typeof val === 'string' && val.trim().length > 0);
      if (valid) {
        if (type === 'summary') valid = validateSummary(val, rolePreset);
        else if (type === 'chips' && label === 'Technical Skills') valid = validateSkills(val, finalJD);
        else if (type === 'list' && label === 'Projects') valid = validateProjects(val, rolePreset);
        else if (type === 'list' && label === 'Achievements') valid = validateAchievements(val);
      }

      // If invalid, retry once with a focused prompt for that section
      if (!valid) {
        debug.invalidAI[pid] = 'validation-failed';
        const retried = await retryCriticalSection(pid, label);
        if (retried && typeof retried === 'string' && retried.trim().length) {
          val = retried;
          // re-validate
          valid = (typeof val === 'string' && val.trim().length > 0);
          if (valid) {
            if (type === 'summary') valid = validateSummary(val, rolePreset);
            else if (type === 'chips' && label === 'Technical Skills') valid = validateSkills(val, finalJD);
            else if (type === 'list' && label === 'Projects') valid = validateProjects(val, rolePreset);
            else if (type === 'list' && label === 'Achievements') valid = validateAchievements(val);
          }
        }
      }

      if (!valid) {
        refundDailyTicket();
        debug.invalidAI[pid] = debug.invalidAI[pid] || 'validation-failed';

        return res.status(503).json({
          ok: false,
          error: `AI returned invalid content for section ${label || pid}`,
          debug
        });
      }

      // Place validated AI content into HTML (no fallback)
      if (type === 'chips' && label === 'Technical Skills') {
        let parts = val.split(/[,|\n]+/).map(s => s.trim()).filter(Boolean);
        const chips = parts.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
      } else if (type === 'summary') {
        let s = val.trim();
        s = seededSynonymSwap(s, rand);
        s = seededBumpMetric(s, rand);
        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<p>${escapeHtml(s)}</p>`);
      } else if (type === 'list' && label === 'Work Experience') {
        const bullets = splitPipeBullets(val);
        const cleaned = bullets.map(b => {
          b = stripRolePrefix(b, profile.roleTitle);
          return escapeHtml(b);
        });
        const lis = cleaned.map(b => `<li>${escapeHtml(b)}</li>`).join('');
        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
      } else if (type === 'list' && label === 'Certifications') {
        const parts = String(val).split('|').map(b => b.trim()).filter(Boolean).slice(0, 2);
        const lis = parts.map(b => `<li>${escapeHtml(b)}</li>`).join('');
        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
      } else if (type === 'list' && label === 'Achievements') {
        const parts = String(val).split('|').map(b => b.trim()).filter(Boolean).slice(0, 2);
        const cleaned = parts.map(a => seededBumpMetric(seededSynonymSwap(a, rand), rand));
        const lis = cleaned.map(b => `<li>${escapeHtml(b)}</li>`).join('');
        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
      } else if (type === 'list' && label === 'Projects') {
        const lis = parseProjectsToLis(val, rolePreset, rand);
        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
      } else if (type === 'chips' && label && label.toLowerCase().includes('character')) {
        let parts = val.split(/[,|\n]+/).map(s => s.trim()).filter(Boolean);
        const chips = soft.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
      } else {
        // Default: insert escaped AI text
        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, escapeHtml(String(val)));
      }
    }
  } catch (e) {
    console.error('Final Processing Error', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error', detail: e.message });
  }
};

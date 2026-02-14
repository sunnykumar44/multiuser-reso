const { saveHistory } = require("./firebase");
const crypto = require('crypto');

// Hard-lock to free-tier-capable models; ignore env overrides to prevent accidental pro usage.
// Ordered list: try each until one works (handles Google deprecations).
const GEMINI_FREE_MODELS = [
  'models/gemini-2.5-flash',
  'models/gemini-2.5-flash-lite',
  'models/gemini-1.5-flash-002',
  'models/gemini-1.5-flash',
];
// Prefer low temperature for deterministic, schema-compliant output
const GEMINI_FREE_TEMPERATURE = 0.2;
const FREE_CACHE_MAX_ENTRIES = Number(process.env.FREE_CACHE_MAX_ENTRIES) || 500;
globalThis.__FREE_GEMINI_CACHE__ = globalThis.__FREE_GEMINI_CACHE__ || new Map();
const FREE_GEMINI_CACHE = globalThis.__FREE_GEMINI_CACHE__;

function buildFreeCacheKey(profile = {}, jd = '') {
  return JSON.stringify({
    jd: String(jd || '').trim(),
    skills: Array.isArray(profile.skills) ? profile.skills : [],
    role: profile.role || profile.title || profile.position || '',
  });
}

function getCachedHtml(key) {
  if (!key) return null;
  return FREE_GEMINI_CACHE.get(key) || null;
}

function storeCachedHtml(key, html) {
  if (!key || !html || typeof html !== 'string') return;
  if (FREE_GEMINI_CACHE.size >= FREE_CACHE_MAX_ENTRIES) {
    const oldest = FREE_GEMINI_CACHE.keys().next().value;
    if (oldest) FREE_GEMINI_CACHE.delete(oldest);
  }
  FREE_GEMINI_CACHE.set(key, html);
}

// Simple in-memory daily limiter (resets when date changes; per server instance)
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 20);
globalThis.__DAILY_LIMIT_STATE__ = globalThis.__DAILY_LIMIT_STATE__ || { date: null, byUser: new Map() };

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function getUserKey(body, req) {
  // Prefer explicit userId; else email; else nickname; else IP.
  const p = (body && body.profile && typeof body.profile === 'object') ? body.profile : {};
  return String(body?.userId || p.email || body?.nickname || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anonymous');
}

function consumeOne(userKey) {
  const state = globalThis.__DAILY_LIMIT_STATE__;
  const d = todayUtc();
  if (state.date !== d) {
    state.date = d;
    state.byUser = new Map();
  }
  const used = Number(state.byUser.get(userKey) || 0);
  if (used >= DAILY_LIMIT) {
    return { ok: false, remaining: 0, used, limit: DAILY_LIMIT, date: state.date, error: 'Daily limit reached' };
  }
  state.byUser.set(userKey, used + 1);
  return { ok: true, remaining: DAILY_LIMIT - (used + 1), used: used + 1, limit: DAILY_LIMIT, date: state.date };
}

function getRemaining(userKey) {
  const state = globalThis.__DAILY_LIMIT_STATE__;
  const d = todayUtc();
  if (state.date !== d) {
    state.date = d;
    state.byUser = new Map();
  }
  const used = Number(state.byUser.get(userKey) || 0);
  return { remaining: Math.max(DAILY_LIMIT - used, 0), used, limit: DAILY_LIMIT, date: state.date };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseRetryDelayMs(txt) {
  try {
    const m = String(txt || '').match(/"retryDelay"\s*:\s*"(\d+)s"/);
    if (m && m[1]) return Number(m[1]) * 1000;
    const m2 = String(txt || '').match(/retry in\s+(\d+)/i);
    if (m2 && m2[1]) return Number(m2[1]) * 1000;
    return 0;
  } catch (_) {
    return 0;
  }
}

function secondsUntilFreeTierReset() {
  const now = new Date();
  const reset = new Date(now);
  reset.setUTCHours(8, 0, 0, 0); // 08:00 UTC == midnight Pacific
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return Math.max(0, Math.ceil((reset.getTime() - now.getTime()) / 1000));
}

// Attempt to parse JSON, falling back to extracting the first {...} block
function tryParseJsonLoose(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json|```/gi, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const slice = clean.slice(first, last + 1);
    try { return JSON.parse(slice); } catch (_) {}
  }
  return null;
}

// Even more forgiving parser: trims code fences, grabs the outermost braces, and
// strips dangling commas before attempting JSON.parse. This is only used to
// rescue slightly malformed model output in strict mode (no client fallback).
function tryParseJsonSalvage(text) {
  if (!text) return null;
  let t = String(text || '').replace(/```json|```/gi, '').trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  t = t.slice(first, last + 1);
  // remove trailing commas before closing braces/brackets
  t = t.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(t); } catch (_) {}
  return null;
}

// Last-resort repair: balance braces/brackets and strip control chars
function tryParseJsonRepair(text) {
  if (!text) return null;
  let t = String(text || '').replace(/```json|```/gi, '').trim();
  // Strip non-printable control chars
  t = t.replace(/[\u0000-\u001F]+/g, '');
  // Remove trailing commas
  t = t.replace(/,\s*([}\]])/g, '$1');
  // Balance braces
  const openCurly = (t.match(/{/g) || []).length;
  const closeCurly = (t.match(/}/g) || []).length;
  const openSquare = (t.match(/\[/g) || []).length;
  const closeSquare = (t.match(/]/g) || []).length;
  if (closeCurly < openCurly) t = t + '}'.repeat(openCurly - closeCurly);
  if (closeSquare < openSquare) t = t + ']'.repeat(openSquare - closeSquare);
  try { return JSON.parse(t); } catch (_) {}
  return null;
}

// Final fallback: extract simple key/value pairs from malformed JSON-ish text.
// This keeps strict mode "no fallback" while salvaging common fields.
function tryParseKeyValuePairs(text) {
  if (!text) return null;
  const out = {};
  const kv = String(text || '');
  // capture "key": "value"
  const re = /\"([A-Za-z0-9 _-]{3,40})\"\\s*:\\s*\"([^\"]{0,400})\"/g;
  let m;
  while ((m = re.exec(kv)) !== null) {
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (!val) continue;
    if (!out[key]) out[key] = val;
  }
  // quick list extraction for skills if present like ["Python","SQL"]
  const skillsMatch = kv.match(/\"skills\"\\s*:\\s*\\[(.*?)\\]/);
  if (skillsMatch && !out.skills) {
    const items = skillsMatch[1]
      .split(/\"\\s*,\\s*\"/)
      .map(s => s.replace(/\"/g, '').trim())
      .filter(Boolean);
    if (items.length) out.skills = items;
  }
  return Object.keys(out).length ? out : null;
}

// --- HELPER 1: ENHANCED KEYWORD EXTRACTOR ---
// Extracts meaningful technical and soft skills from JD
function extractKeywordsFromJD(jd, type = 'all') {
  if (!jd || jd.trim().length < 20) {
    // For very short JDs, use the words themselves
    const words = jd.trim().split(/\s+/).filter(w => w.length > 2);
    if (type === 'technical') return words.length ? words : ["Python", "SQL"];
    if (type === 'soft') return ["Communication", "Teamwork"];
    return words.length ? words : ["Technical"];
  }
  
  const stopWords = new Set([
    "and", "the", "for", "with", "ing", "to", "in", "a", "an", "of", "on", "at", "by", "is", "are", 
    "was", "were", "be", "been", "job", "role", "work", "experience", "candidate", "ability", 
    "knowledge", "looking", "seeking", "must", "have", "will", "can", "good", "strong", "years", 
    "description", "required", "preferred", "should", "responsibilities", "requirements",
    "analyst", "developer", "engineer", "manager", "specialist", "coordinator", "intern", "junior", "senior", "professional"
  ]);

  // EXPANDED Technical skill patterns (case-insensitive matching)
  const text = jd.toLowerCase();
  const technicalSkills = [];
  
  // Programming Languages
  const languages = ["python", "java", "javascript", "typescript", "c++", "c#", "ruby", "php", "go", "rust", "scala", "kotlin", "swift", "r", "matlab", "perl", "shell", "bash"];
  languages.forEach(lang => {
    if (text.includes(lang)) technicalSkills.push(lang.charAt(0).toUpperCase() + lang.slice(1));
  });
  
  // Frameworks & Libraries
  const frameworks = ["react", "angular", "vue", "django", "flask", "spring", "node", "express", "rails", "laravel", "dotnet", ".net", "tensorflow", "pytorch", "pandas", "numpy", "scikit"];
  frameworks.forEach(fw => {
    if (text.includes(fw)) technicalSkills.push(fw.charAt(0).toUpperCase() + fw.slice(1));
  });
  
  // Databases
  const databases = ["sql", "mysql", "postgresql", "mongodb", "redis", "oracle", "cassandra", "dynamodb", "sqlite"];
  databases.forEach(db => {
    if (text.includes(db)) technicalSkills.push(db.toUpperCase());
  });
  
  // Cloud & DevOps
  const cloud = ["aws", "azure", "gcp", "docker", "kubernetes", "jenkins", "ci/cd", "terraform", "ansible"];
  cloud.forEach(c => {
    if (text.includes(c)) technicalSkills.push(c.toUpperCase());
  });
  
  // Tools & Others
  const tools = ["git", "jira", "linux", "api", "rest", "graphql", "oauth", "jwt", "microservices", "agile", "scrum", "tableau", "powerbi", "excel", "spark", "hadoop", "kafka"];
  tools.forEach(t => {
    if (text.includes(t)) technicalSkills.push(t.charAt(0).toUpperCase() + t.slice(1));
  });

  // Soft skills extraction
  const softSkillPatterns = ["communication", "problem solving", "teamwork", "leadership", "analytical", "time management", "adaptability", "critical thinking", "collaboration", "attention to detail"];
  const softSkills = [];
  softSkillPatterns.forEach(skill => {
    if (text.includes(skill.toLowerCase().replace(/\s+/g, ''))) {
      softSkills.push(skill.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
    }
  });

  // Remove duplicates
  const uniqueTech = [...new Set(technicalSkills)];
  const uniqueSoft = [...new Set(softSkills)];

  if (type === 'technical') {
    // If no tech skills found, extract ANY capitalized words or technical-sounding words
    if (uniqueTech.length === 0) {
      const words = jd.split(/\s+/);
      words.forEach(w => {
        const clean = w.replace(/[^a-zA-Z0-9+#]/g, '');
        if (clean.length > 2 && !stopWords.has(clean.toLowerCase())) {
          uniqueTech.push(clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase());
        }
      });
    }
    return uniqueTech.slice(0, 15);
  }

  if (type === 'soft') {
    // Default soft skills if none found
    if (uniqueSoft.length === 0) {
      return ["Communication", "Problem Solving", "Teamwork", "Leadership", "Time Management", "Analytical Thinking"];
    }
    return uniqueSoft.slice(0, 8);
  }

  return [...uniqueTech, ...uniqueSoft].slice(0, 18);
}

// --- HELPER 2: DYNAMIC FALLBACK GENERATOR (100% JD-DERIVED) ---
function getSmartFallback(section, jd, rand = Math.random) {
  const rolePreset = getRolePreset(jd);
  if (section === 'skills') {
    let skills = extractKeywordsFromJD(jd, 'technical').slice(0, 6);
    const pool = shuffleSeeded((rolePreset.skills || []).slice(), rand);
    for (const p of pool) { if (skills.length >= 12) break; if (!skills.includes(p)) skills.push(p); }
    return dedupeSkillsLike(skills);
  }
  if (section === 'certifications') return dynamicCerts(rolePreset, rand).join(' | ');
  if (section === 'projects') return dynamicProjects(rolePreset, rand).join(' | ');
  if (section === 'achievements') return dynamicAchievements(rolePreset, rand).join(' | ');
  return "";
}

// --------------------
// Fallback content builders (must never throw)
// --------------------
function randomPercent(rand = Math.random, min = 10, max = 40) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function dynamicSummary(rolePreset, finalJD, rand = Math.random) {
  try {
    const role = String(finalJD || '').split(' with ')[0].trim() || 'the role';
    const skills = Array.isArray(rolePreset?.skills) ? rolePreset.skills : ['Python', 'SQL', 'Git'];
    const top = shuffleSeeded(skills.slice(), rand).slice(0, 4);
    const pct = randomPercent(rand, 12, 35);
    return `Entry-level candidate targeting ${role} roles with hands-on project experience and strong fundamentals in ${top.join(', ')}. Built resume-ready projects aligned to job requirements, focusing on clean implementation, debugging, and measurable outcomes. Demonstrated ability to learn quickly, collaborate effectively, and deliver improvements of ~${pct}% in efficiency/quality in simulated or academic work.`;
  } catch (_) {
    return 'Entry-level candidate with strong technical fundamentals and hands-on project experience aligned to the target role. Motivated, adaptable, and eager to contribute in a collaborative environment.';
  }
}

function dynamicCerts(rolePreset, rand = Math.random) {
  const certs = Array.isArray(rolePreset?.certs) ? rolePreset.certs : [];
  const picked = shuffleSeeded(certs.slice(), rand).slice(0, 2);
  return picked.length ? picked : ['PCEP – Certified Entry-Level Python Programmer'];
}

function dynamicProjects(rolePreset, rand = Math.random) {
  const projs = Array.isArray(rolePreset?.projects) ? rolePreset.projects : [];
  const picked = shuffleSeeded(projs.slice(), rand).slice(0, 2);
  return picked.length ? picked : ['<b>Demo Project:</b> Built a role-aligned CRUD app with measurable improvements.'];
}

function dynamicAchievements(rolePreset, rand = Math.random) {
  const ach = Array.isArray(rolePreset?.achievements) ? rolePreset.achievements : [];
  const picked = shuffleSeeded(ach.slice(), rand).slice(0, 2);
  return picked.length ? picked : [`Improved performance by ${randomPercent(rand)}% through optimization`, `Automated repetitive tasks saving ${randomPercent(rand)}% time`];
}

function dynamicExperienceBullet(title, rolePreset, rand = Math.random) {
  const skills = Array.isArray(rolePreset?.skills) ? rolePreset.skills : ['Python', 'SQL'];
  const tech = shuffleSeeded(skills.slice(), rand)[0] || 'relevant tools';
  const pct = randomPercent(rand, 10, 35);
  return `${String(title || 'Role')} – Delivered role-aligned tasks using ${tech}, improving turnaround time by ~${pct}%.`;
}

function dynamicTraits(finalJD, rand = Math.random) {
  const fromJD = extractKeywordsFromJD(finalJD, 'soft');
  const base = ['Communication', 'Teamwork', 'Problem Solving', 'Adaptability', 'Time Management', 'Attention to Detail'];
  const merged = [...new Set([...fromJD, ...base])];
  return shuffleSeeded(merged, rand).slice(0, 6);
}

// Ensure fallback HTML still gets lightweight variation and never throws
function seededSynonymSwap(text, rand = Math.random) {
  const s = String(text || '');
  const swaps = [
    [/(improved|improving)/gi, () => (rand() > 0.5 ? 'enhanced' : 'improved')],
    [/(reduced|reducing)/gi, () => (rand() > 0.5 ? 'lowered' : 'reduced')],
    [/(built)/gi, () => (rand() > 0.5 ? 'developed' : 'built')],
    [/(created)/gi, () => (rand() > 0.5 ? 'implemented' : 'created')],
  ];
  let out = s;
  for (const [re, rep] of swaps) out = out.replace(re, rep);
  return out;
}

function seededBumpMetric(text, rand = Math.random) {
  const s = String(text || '');
  // If it already contains a %, keep it
  if (/%/.test(s)) return s;
  // Add a small metric sometimes
  if (rand() < 0.35) return `${s} (~${randomPercent(rand, 10, 35)}% impact).`;
  return s;
}

function applyGuaranteedVariationToFallback(html, rolePreset, rand = Math.random) {
  try {
    let out = String(html || '');
    out = seededSynonymSwap(out, rand);
    out = seededBumpMetric(out, rand);
    return out;
  } catch (_) {
    return String(html || '');
  }
}

function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Ensure Education shows college + branch + edu years from profile even if model omits them
function ensureEducationInHtml({ html, profile } = {}) {
  try {
    const outHtml = String(html || '');
    const p = (profile && typeof profile === 'object') ? profile : {};
    const college = String(p.college || '').trim();
    const branch = String(p.branch || '').trim();
    const eduFrom = String(p.eduFrom || '').trim();
    const eduTo = String(p.eduTo || '').trim();
    const eduYears = [eduFrom, eduTo].filter(Boolean).join('–');

    // If there is no usable education info, do nothing
    if (!college && !branch && !eduYears) return outHtml;

    // If AI output already contains branch or years, do nothing
    const lower = outHtml.toLowerCase();
    const hasBranch = branch && lower.includes(String(branch).toLowerCase());
    const hasYears = eduYears && lower.includes(String(eduYears).toLowerCase());
    if (hasBranch || hasYears) return outHtml;

    // If it doesn't even mention Education, do nothing (avoid risky injection)
    const hasEducationHeading = /education/i.test(outHtml);
    if (!hasEducationHeading) return outHtml;

    // Build a safe Education block that matches the server template class names
    const eduLine2 = [branch, eduYears].filter(Boolean).join(' • ');
    const injected = `
<div class="resume-item">
  <div class="resume-row">
    <span class="resume-role">${escapeHtml(college || 'Education')}</span>
    <span class="resume-date">${escapeHtml(eduYears || '')}</span>
  </div>
  ${branch ? `<span class="resume-company">${escapeHtml(branch)}</span>` : ''}
</div>
`;

    // Try to insert right after the Education section title
    // Pattern: <div class="resume-section-title">Education</div>
    const re = /(<div\s+class="resume-section-title"[^>]*>\s*Education\s*<\/div>)/i;
    if (re.test(outHtml)) {
      return outHtml.replace(re, `$1${injected}`);
    }

    return outHtml;
  } catch (_) {
    return String(html || '');
  }
}

// --- CONSTANTS ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_KEY || process.env.GCP_API_KEY;
// Optional: prefer a specific Gemini model first (e.g., "models/gemini-3-flash-preview")
const GEMINI_MODEL_PREFERRED = (process.env.GEMINI_MODEL || process.env.GEMINI_PREFERRED_MODEL || 'gemini-2.5-flash').trim();

const RESUME_CSS = `
  <style>
    .generated-resume {
      font-family: 'Helvetica', 'Arial', sans-serif;
      line-height: 1.5;
      color: #1e293b;
      background: white;
      padding: 20px;
    }
    .generated-resume * { box-sizing: border-box; }
    .resume-header { text-align: center; margin-bottom: 20px; }
    .resume-name { font-size: 28px; font-weight: 800; color: #1a365d; text-transform: uppercase; margin-bottom: 5px; }
    .resume-contact { font-size: 11px; color: #4a5568; }
    .resume-contact a { color: #2b6cb0; text-decoration: none; }
    
    .resume-section-title {
      font-size: 13px; margin: 16px 0 8px; border-bottom: 1.5px solid #2b6cb0;
      color: #1a365d; text-transform: uppercase; letter-spacing: 1px; font-weight: bold;
    }
    .resume-item { margin-bottom: 12px; font-size: 11px; }
    .resume-row { display: flex; justify-content: space-between; align-items: baseline; width: 100%; }
    .resume-role { font-weight: bold; color: #000; }
    .resume-date { font-weight: bold; font-size: 10px; color: #000; }
    .resume-company { font-style: italic; color: #444; margin-bottom: 2px; display: block; }
    /* Lists should read like clean new lines (no bullet dots) */
    .generated-resume ul { margin: 4px 0 0; padding: 0; list-style: none; }
    .generated-resume li { margin: 0 0 4px 0; font-size: 11px; }
    .generated-resume p { margin-bottom: 4px; font-size: 11px; text-align: justify; }
    
    .skill-tag {
      display: inline-block; padding: 3px 8px; margin: 0 4px 4px 0;
      border: 1px solid #cbd5e1; border-radius: 4px; background-color: #f8fafc;
      font-size: 10px; font-weight: 600; color: #334155;
    }

    /* Mobile / small screens: prevent overlap and force wrapping */
    @media (max-width: 520px) {
      .generated-resume { padding: 14px; }
      .resume-name { font-size: 22px; }
      .resume-contact { font-size: 10px; line-height: 1.35; }
      .resume-section-title { font-size: 12px; margin: 14px 0 8px; }
      .resume-item, .generated-resume p, .generated-resume li { font-size: 10.5px; }

      .resume-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      }
      .resume-date { font-size: 10px; }
      .resume-role { word-break: break-word; }
      .skill-tag { font-size: 9.5px; padding: 3px 7px; }
    }
  </style>
`;

// Role presets provide realistic, role-aligned seeds when JD is sparse
const ROLE_PRESETS = {
  'data engineer': {
    skills: ['Python','SQL','Apache Spark','Airflow','ETL','Data Warehousing','BigQuery','AWS S3','Docker','Git'],
    projects: [
      '<b>Batch ETL Pipeline:</b> Built a Python + Airflow pipeline to ingest, validate, and load datasets into a warehouse. Improved data freshness by 30% and reduced manual effort.',
      '<b>Spark Transformations:</b> Implemented Spark jobs for large-scale transformations and partitioning to reduce run time by 35%.'
    ],
    certs: ['Google Cloud Digital Leader','Microsoft Certified: Azure Data Fundamentals'],
    achievements: ['Reduced pipeline failure rate by 25% via validation and retries','Optimized Spark transformations to cut processing time by 35%']
  },
  'software engineer': {
    skills: ['Python','Java','JavaScript','REST APIs','SQL','Git','Docker','Linux','Microservices'],
    projects: [
      '<b>E-commerce API:</b> Built using Python, Django, PostgreSQL to handle product catalogs and orders. Achieved 99.9% uptime and 30% faster response times.',
      '<b>Deployment Pipeline:</b> Implemented CI/CD with Jenkins and Docker to automate testing and deployment, reducing release time by 40%.'
    ],
    certs: ['Oracle Certified Associate, Java SE 11 Developer','AWS Certified Developer – Associate'],
    achievements: ['Reduced API response time by 30% via caching','Automated builds saving 10 hours/week']
  },
  'python developer': {
    skills: ['Python','Django','Flask','REST APIs','PostgreSQL','Pandas','Docker','Git'],
    projects: ['<b>Weather App:</b> CLI built using Python and API integration to fetch and analyze weather data. | <b>Data Pipeline:</b> ETL pipeline using Pandas and PostgreSQL.'],
    certs: ['PCEP – Certified Entry-Level Python Programmer','AWS Certified Cloud Practitioner'],
    achievements: ['Improved data processing throughput by 25%','Reduced error rates via validation checks']
  },
  'java developer': {
    skills: ['Java','Spring Boot','Hibernate','REST APIs','MySQL','Maven','Git'],
    projects: ['<b>Employee Management:</b> Spring Boot app with REST APIs and MySQL backend. | <b>Inventory Service:</b> Microservice with Spring and Docker.'],
    certs: ['Oracle Certified Associate, Java SE 11 Developer','OCP Java SE'],
    achievements: ['Improved DB query performance by 40%','Delivered core feature ahead of schedule']
  },
  'data analyst': {
    skills: ['SQL','Python','Pandas','NumPy','Tableau','Excel','PowerBI','Data Visualization'],
    projects: ['<b>Sales Dashboard:</b> Built Tableau dashboards enabling 20% faster decisions. | <b>Data Cleaning Pipeline:</b> Used Python/Pandas to clean and standardize data.'],
    certs: ['Google Data Analytics Professional Certificate','PCEP – Certified Entry-Level Python Programmer'],
    achievements: ['Reduced reporting time by 50%','Improved dashboard adoption by 30%']
  },
  'middleware': {
    skills: ['Apache Kafka','RabbitMQ','Java','Spring Boot','REST APIs','Microservices','Docker','Kubernetes'],
    projects: ['<b>Message Broker:</b> Implemented Kafka-based message broker to handle 1000s msgs/sec. | <b>Integration Layer:</b> Built Spring Boot middleware integrating multiple services with retry/backoff.'],
    certs: ['Confluent Certified Developer for Apache Kafka (CCDAK)','Oracle Java SE 11 Associate'],
    achievements: ['Improved message throughput by 3x','Reduced integration failures by 40%']
  },
  'automation': {
    skills: ['Selenium','Python','CI/CD','Jenkins','Docker','TestNG','API Testing','Git'],
    projects: ['<b>Test Automation Suite:</b> Built Selenium + Python suite to automate regression testing reducing manual QA time. | <b>CI Integration:</b> Integrated tests in Jenkins pipeline to catch regressions early.'],
    certs: ['ISTQB Foundation','PCEP – Certified Entry-Level Python Programmer'],
    achievements: ['Reduced manual test time by 80%','Increased release confidence via automated tests']
  },
  'web developer': {
    skills: ['HTML5','CSS3','JavaScript','React','REST APIs','Node.js','Git','Responsive Design'],
    projects: ['<b>E-commerce Frontend:</b> Responsive React app with cart and checkout. | <b>Admin Dashboard:</b> Built with React and REST API integrations.'],
    certs: ['FreeCodeCamp Front End Libraries Certification','Google Web Developer'],
    achievements: ['Improved page load times by 35%','Increased conversion through UX fixes']
  },
  default: {
    skills: ['Python','SQL','Git','REST APIs','Docker','Communication'],
    projects: ['<b>Demo Project:</b> Built a simple CRUD service using core technologies relevant to the role. | <b>Tooling Project:</b> Automated routine tasks using scripts and CI.'],
    certs: ['PCEP – Certified Entry-Level Python Programmer'],
    achievements: ['Delivered project demonstrating technical fundamentals']
  }
};

// Flatten tech tokens for validation
const TECH_TOKENS = [
  'python','java','javascript','typescript','c++','c#','ruby','php','go','rust','scala','kotlin','swift','r','matlab','perl','bash','django','flask','spring','react','angular','node','express','postgresql','mysql','mongodb','redis','aws','azure','gcp','docker','kubernetes','git','jenkins','terraform','pandas','numpy','tableau','powerbi','sql','rest','api','graphql','kafka','rabbitmq'
];

// Normalize common technical skill variants so we can dedupe better (e.g., "ETL" vs "ETL Processes")
function normalizeSkillToken(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  const t = raw.toLowerCase();

  // Canonicalize frequent variants
  if (/^etl(\s+processes|\s+principles)?$/.test(t)) return 'ETL';
  if (/^(version\s*control\s*\(git\)|git\s+version\s+control)$/.test(t)) return 'Git';
  if (/^jupyter(\s+notebooks)?$/.test(t)) return 'Jupyter';
  if (/^sql$/.test(t)) return 'SQL';
  if (/^(postgresql|postgre\s*sql)$/.test(t)) return 'PostgreSQL';
  if (/^mysql$/.test(t)) return 'MySQL';
  if (/^aws\s*s3$/.test(t)) return 'AWS S3';
  if (/^bigquery$/.test(t)) return 'BigQuery';
  if (/^power\s*bi$/.test(t)) return 'Power BI';
  if (/^java$/.test(t)) return 'Java';
  if (/^python$/.test(t)) return 'Python';
  if (/^numpy$/.test(t)) return 'NumPy';
  if (/^pandas$/.test(t)) return 'Pandas';
  if (/^git$/.test(t)) return 'Git';
  if (/^docker$/.test(t)) return 'Docker';

  // Title-case fallback
  return raw.length <= 4 ? raw.toUpperCase() : raw;
}

function dedupeSkillsLike(arr) {
  const out = [];
  const seen = new Set();
  for (const x of (arr || [])) {
    const canon = normalizeSkillToken(x);
    if (!canon) continue;
    const k = canon.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(canon);
  }
  return out;
}

function getRolePreset(jd) {
  if (!jd || !jd.trim()) return ROLE_PRESETS['default'];
  const text = jd.toLowerCase();
  for (const key of Object.keys(ROLE_PRESETS)) {
    if (key === 'default') continue;
    if (text.includes(key) || text.includes(key.split(' ')[0])) return ROLE_PRESETS[key];
  }
  // fallback heuristics
  if (text.includes('data engineer') || (text.includes('data') && (text.includes('pipeline') || text.includes('etl') || text.includes('warehouse')))) return ROLE_PRESETS['data engineer'];
  if (text.includes('data')) return ROLE_PRESETS['data analyst'];
  if (text.includes('middleware') || text.includes('broker')) return ROLE_PRESETS['middleware'];
  if (text.includes('automation') || text.includes('qa') || text.includes('testing')) return ROLE_PRESETS['automation'];
  if (text.includes('web') || text.includes('frontend') || text.includes('react')) return ROLE_PRESETS['web developer'];
  if (text.includes('java')) return ROLE_PRESETS['java developer'];
  if (text.includes('python')) return ROLE_PRESETS['python developer'];
  return ROLE_PRESETS['software engineer'];
}

function isLikelyTechnical(token) {
  if (!token || typeof token !== 'string') return false;
  const t = token.toLowerCase();
  if (TECH_TOKENS.some(tok => t.includes(tok))) return true;
  // also accept patterns like 'react.js', 'node.js'
  if (/\b(react|node|django|flask|spring)\b/.test(t)) return true;
  return false;
}

function makeSeed() {
  const buf = crypto.randomBytes(8);
  return buf.readUInt32LE(0) ^ buf.readUInt32LE(4);
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
    [arr[i], arr[j] ] = [arr[j], arr[i]];
  }
  return arr;
}

function randomFromSeeded(arr, rand) { return arr[Math.floor(rand() * arr.length)]; }
function randomPercentSeeded(rand, min = 10, max = 40) { return Math.floor(rand() * (max - min + 1)) + min; }

// Ensure project bullets mention tech + impact when missing
function augmentProjectIfNeeded(text, rolePreset, rand = Math.random) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (/\b(using|built|developed|implemented|deployed)\b/i.test(t)) return t;
  const tech = randomFromSeeded(rolePreset?.skills || ['Python'], rand);
  const pct = randomPercentSeeded(rand, 10, 40);
  return `${t} Built using ${tech}. Achieved ~${pct}% improvement.`;
}

// Add simple non-seeded random helper used by augmentCerts / augmentAchievements
function randomFrom(arr) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return '';
  return a[Math.floor(Math.random() * a.length)];
}

// Tiny safe picker used by augmentCerts/augmentAchievements.
// Defined right here so it *cannot* be undefined at runtime.
function randomFrom(list, fallback = '') {
  try {
    const a = Array.isArray(list) ? list.filter(x => x != null) : [];
    if (!a.length) return fallback;
    return a[Math.floor(Math.random() * a.length)];
  } catch (_) {
    return fallback;
  }
}

// Augment a certification list to ensure real certs
function augmentCerts(parts, rolePreset) {
  const out = [];
  const pool = Array.isArray(rolePreset?.certs) && rolePreset.certs.length
    ? rolePreset.certs
    : ['PCEP – Certified Entry-Level Python Programmer'];

  for (const p of (parts || [])) {
    const s = String(p || '').trim();
    if (!s) continue;
    const hasKnown = ['AWS','Oracle','PCEP','Microsoft','ISTQB','Confluent','Google']
      .some(t => s.toUpperCase().includes(t));
    if (hasKnown) out.push(s);
    else out.push(randomFrom(pool, pool[0]));
  }

  while (out.length < 2) out.push(randomFrom(pool, pool[0]));
  return out.slice(0, 2);
}

// Augment achievements to include measurable numbers
function augmentAchievements(parts, rolePreset) {
  const out = [];
  const pool = Array.isArray(rolePreset?.achievements) && rolePreset.achievements.length
    ? rolePreset.achievements
    : ['Delivered project demonstrating technical fundamentals'];

  for (const p of (parts || [])) {
    const s = String(p || '').trim();
    if (!s) continue;
    if (/%|\b(reduc|improv|increas|save|autom|improved|reduced)\b/i.test(s)) {
      out.push(s);
    } else {
      out.push(`${s} Improved performance by ${randomPercent()}%.`);
    }
  }

  while (out.length < 2) out.push(randomFrom(pool, pool[0]));
  return out.slice(0, 2);
}

async function callGeminiFlash(promptText, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  // Prefer v1; v1beta frequently deprecates model endpoints sooner
  const bases = [
    `https://generativelanguage.googleapis.com/v1`,
    `https://generativelanguage.googleapis.com/v1beta`
  ];

  const keyQs = `key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const temperature = (typeof opts.temperature === 'number') ? opts.temperature : GEMINI_FREE_TEMPERATURE;
  const maxOutputTokens = opts.maxOutputTokens || 3072;

  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature,
      topP: 0.95,
      maxOutputTokens,
      responseMimeType: "application/json"
    }
  };

  const looksLikeNotFound = (txt) =>
    /NOT_FOUND|not found for api version|is not supported for generateContent/i.test(String(txt || ''));

  async function tryGenerateWithModel(base, modelName) {
    const name = modelName.startsWith('models/') ? modelName : `models/${modelName}`;
    const url = `${base}/${name}:generateContent?${keyQs}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      const err = new Error(`Gemini API failed ${resp.status}: ${txt}`);
      err.status = resp.status;
      err.bodyText = txt;
      err.isNotFound = resp.status === 404 || looksLikeNotFound(txt);
      throw err;
    }

    const j = await resp.json();
    const candidate = (j?.candidates?.[0]?.content?.parts || [])
      .map(p => p?.text || '')
      .join('');
    if (!candidate) {
      const err = new Error('No response from AI');
      err.status = 502;
      err.bodyText = JSON.stringify(j || {}).slice(0, 400);
      throw err;
    }

    return candidate;
  }

  async function listModels(base) {
    const url = `${base}/models?${keyQs}`;
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) return [];
    const j = await resp.json().catch(() => null);

    const models = Array.isArray(j?.models) ? j.models : [];

    // Filter to ones that support generateContent (method name differs by API version, handle both)
    const usable = models
      .map(m => ({
        name: String(m?.name || ''),
        methods: Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [],
      }))
      .filter(m => m.name && (m.methods.includes('generateContent') || m.methods.includes('generateText')));

    return usable.map(m => m.name);
  }

  // 1) Try the configured/known model list first
  let lastErr = null;
  let sawNotFound = false;

  for (const modelName of GEMINI_FREE_MODELS) {
    for (const base of bases) {
      try {
        return await tryGenerateWithModel(base, modelName);
      } catch (e) {
        lastErr = e;
        if (e && e.isNotFound) sawNotFound = true;
        // continue trying other combos
      }
    }
  }

  // 2) If everything failed due to NOT_FOUND, discover a valid model and retry once
  if (sawNotFound) {
    for (const base of bases) {
      try {
        const discovered = await listModels(base);
        // Prefer flash-ish models to control cost/latency; fallback to first usable.
        const preferred =
          discovered.find(n => /flash/i.test(n) && /gemini/i.test(n)) ||
          discovered.find(n => /gemini/i.test(n)) ||
          discovered[0];

        if (preferred) {
          return await tryGenerateWithModel(base, preferred);
        }
      } catch (e) {
        lastErr = e;
      }
    }
  }

  throw lastErr || new Error('Gemini API failed');
}

function normalizeJD(jdRaw = '') {
  let s = String(jdRaw || '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');

  // Common misspellings / variants for roles & skills
  const map = [
    // Very common typos
    [/\bdevloper\b/gi, 'developer'],
    [/\bjav\b/gi, 'java'],
    [/\bjav\s+developer\b/gi, 'java developer'],
    [/\bjava\s*devloper\b/gi, 'java developer'],
    [/\bjav\s+devloper\b/gi, 'java developer'],

    [/\bdata\s*analy(st|ts)\b/gi, 'data analyst'],
    [/\bdata\s*analys(t|ts)\b/gi, 'data analyst'],
    [/\bdata\s*analyst\b/gi, 'data analyst'],
    [/\bjava\s*dev(eloper)?\b/gi, 'java developer'],
    [/\bpy(thon)?\s*dev(eloper)?\b/gi, 'python developer'],
    [/\bsoftw(are)?\s*eng(ineer)?\b/gi, 'software engineer'],
    [/\bweb\s*dev(eloper)?\b/gi, 'web developer'],
    [/\bmid(?:dle)?\s*ware\b/gi, 'middleware'],

    // Tech typos
    [/\bpostgre\s*sql\b/gi, 'PostgreSQL'],
    [/\bpostgress\b/gi, 'PostgreSQL'],
    [/\bjavscript\b/gi, 'JavaScript'],
    [/\btype\s*script\b/gi, 'TypeScript'],
    [/\bpower\s*bi\b/gi, 'PowerBI'],
    [/\btablue\b/gi, 'Tableau'],
    [/\bexcell\b/gi, 'Excel'],
    [/\bscikit\s*learn\b/gi, 'Scikit-learn'],
    [/\bjup(y)?ter\b/gi, 'Jupyter'],
    [/\brest\s*api\b/gi, 'REST APIs'],
  ];

  for (const [re, rep] of map) s = s.replace(re, rep);
  return s;
}

function looksLikeGarbageJD(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (t.length < 6) return true;
  const letters = (t.match(/[a-z]/gi) || []).length;
  const spaces = (t.match(/\s/g) || []).length;
  const words = t.split(/\s+/).filter(Boolean);
  const avgWord = words.length ? (t.replace(/\s+/g, '').length / words.length) : t.length;
  const nonAlphaNum = (t.match(/[^a-z0-9\s]/gi) || []).length;

  // Heuristics for nonsense: very long single token / low spaces, lots of symbols, weird word lengths
  if (words.length <= 1 && t.length >= 12) return true;
  if (spaces === 0 && t.length >= 10) return true;
  if (letters / Math.max(t.length, 1) < 0.55) return true;
  if (nonAlphaNum / Math.max(t.length, 1) > 0.25) return true;
  if (avgWord > 14) return true;
  return false;
}

function inferRoleFromProfile(profile = {}) {
  const skills = Array.isArray(profile.skills) ? profile.skills.map(s => String(s).toLowerCase()) : [];
  const exp = Array.isArray(profile.customSections) ? JSON.stringify(profile.customSections).toLowerCase() : '';

  const has = (k) => skills.some(s => s.includes(k)) || exp.includes(k);

  if (has('tableau') || has('powerbi') || has('excel') || has('pandas') || has('numpy') || has('sql')) return 'data analyst';
  if (has('spark') || has('airflow') || has('etl') || has('warehouse') || has('bigquery')) return 'data engineer';
  if (has('spring') || has('hibernate') || has('java')) return 'java developer';
  if (has('django') || has('flask') || has('python')) return 'python developer';
  if (has('react') || has('frontend') || has('node') || has('javascript')) return 'web developer';
  return 'software engineer';
}

// Helper to normalize arbitrary section titles into canonical buckets (hoisted function)
function canonicalSectionName(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('work') || s.includes('experience') || s.includes('employment')) return 'Work Experience';
  if (s.includes('project')) return 'Projects';
  if (s.includes('technical') || s.includes('skill')) return 'Technical Skills';
  if (s.includes('summary')) return 'Summary';
  if (s.includes('education') || s.includes('college') || s.includes('degree')) return 'Education';
  if (s.includes('cert') || s.includes('certificate')) return 'Certifications';
  if (s.includes('achieve') || s.includes('award')) return 'Achievements';
  if (s.includes('trait') || s.includes('character') || s.includes('soft')) return 'Character Traits';
  // default: title-case the input for display
  return String(name || '').trim().replace(/\s+/g, ' ').replace(/(^|\s)\S/g, l => l.toUpperCase());
};

// Central helper: when strict flags are ON, never generate textual fallbacks.
// When strict flags are OFF (non-strict mode, e.g. demo), we can still use old fallbacks.
function dynamicFallbackFor(type, label, rolePreset, finalJD, profileSkills) {
  // This function will be shadowed later with access to flags (noFallback/aiOnly/forceStrict).
  // Placeholder here to keep references valid.
  return '';
}

// --------------------
// Missing helpers (required by renderFromAiData strict path)
// --------------------
function rotateBySeed(arr, rand = Math.random) {
  const a = Array.isArray(arr) ? arr.slice() : [];
  if (a.length <= 1) return a;
  const k = Math.floor(rand() * a.length);
  return a.slice(k).concat(a.slice(0, k));
}

function enforceTwoDistinct(parts, fallbackPool = []) {
  const cleaned = (parts || []).map(s => String(s || '').trim()).filter(Boolean);
  const out = [];
  const seen = new Set();

  for (const s of cleaned) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 2) break;
  }

  // fill from fallback pool if needed
  for (const f of (fallbackPool || [])) {
    if (out.length >= 2) break;
    const s = String(f || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }

  // last-resort padding
  while (out.length < 2) out.push('PCEP – Certified Entry-Level Python Programmer');
  return out.slice(0, 2);
}

function enforceNDistinct(parts, n = 6, fallbackPool = []) {
  const cleaned = (parts || []).map(s => String(s || '').trim()).filter(Boolean);
  const out = [];
  const seen = new Set();

  for (const s of cleaned) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= n) return out.slice(0, n);
  }

  for (const f of (fallbackPool || [])) {
    if (out.length >= n) break;
    const s = String(f || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }

  while (out.length < n) out.push('Collaboration');
  return out.slice(0, n);
}

function parseProjectsToLis(val, rolePreset, rand = Math.random) {
  // Expected format: "<b>Title:</b> desc | <b>Title:</b> desc"
  // Make it resilient: split on pipes/newlines; ensure two <li>.
  const raw = String(val || '').replace(/\n+/g, ' ').trim();
  const parts = raw
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 4);

  const items = [];
  for (const p of parts) {
    // keep HTML bold tags if present; otherwise escape only minimal
    const txt = p.includes('<b>') ? p : escapeHtml(p);
    items.push(`<li>${augmentProjectIfNeeded(txt, rolePreset, rand)}</li>`);
    if (items.length >= 2) break;
  }

  // guarantee 2 projects in strict mode
  while (items.length < 2) {
    const fb = randomFromSeeded((rolePreset?.projects || []), rand) || '<b>Project:</b> Built a role-aligned solution with measurable impact.';
    items.push(`<li>${fb}</li>`);
  }

  return items.join('');
}

// --------------------
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const requestSeed = makeSeed();
    const rand = mulberry32(requestSeed);
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    let { profile: rawProfile, jd, nickname, scope = [], aiOnly = false, forceFresh = false, useCache = true, forceStrict = false } = body;

    // STRICT: default noFallback should be TRUE if you want AI-only by design.
    // (keeps backward compatibility if someone explicitly passes noFallback=false)
    let noFallback = (typeof body.noFallback === 'boolean') ? body.noFallback : true;

    // If API key and JD exist, harden to AI-only on the server side as well
    // so a misconfigured client cannot accidentally run fallback logic.
    const hasKey = !!GEMINI_API_KEY;
    if (hasKey) {
      aiOnly = true;
      noFallback = true;
      forceStrict = true;
    }

    // Attach flags into debug early so you can see what server actually used
    const debugBase = { requestSeed, aiEnabled: hasKey, aiOnly, noFallback, forceStrict };

    // FIX: define profile before first use
    const profile = (rawProfile && typeof rawProfile === 'object') ? rawProfile : {};

    // Normalize and dedupe incoming skills ("Python pre-processing" but on the server)
    if (profile && Array.isArray(profile.skills)) {
      profile.skills = dedupeSkillsLike(profile.skills);
    } else if (profile && typeof profile.skills === 'string') {
      profile.skills = dedupeSkillsLike(profile.skills.split(/[,|\n]+/).map(s => s.trim()).filter(Boolean));
    }

    // Normalize JD to handle typos before any logic
    let jdNormalized = normalizeJD(jd);
    let jdWasInferred = false;
    if (looksLikeGarbageJD(jdNormalized)) {
      const inferredRole = inferRoleFromProfile(profile);
      jdNormalized = inferredRole;
      jdWasInferred = true;
    }

    const userKey = getUserKey({ ...body, profile }, req);
    const remainingInfo = getRemaining(userKey);

    if (!jdNormalized || typeof jdNormalized !== 'string' || !jdNormalized.trim()) {
      return res.status(400).json({ ok: false, error: 'Missing required field: jd', debug: { requestSeed, aiEnabled: !!GEMINI_API_KEY, aiOnly, daily: remainingInfo } });
    }

    const name = (profile.fullName || nickname || "User").toUpperCase();
    const contactLinks = [
      profile.email ? `<a href="mailto:${profile.email}">${profile.email}</a>` : null,
      profile.phone,
      profile.linkedin ? `<a href="${profile.linkedin}">LinkedIn</a>` : null,
      profile.github ? `<a href="${profile.github}">GitHub</a>` : null,
    ].filter(Boolean).join(" | ");

    let resumeBodyHtml = "";
    const aiPrompts = {}; 
    const aiFallbacks = {}; 
    const aiTypes = {}; 
    const aiLabels = {};
    const pidByCanonical = {};
    let sectionCounter = 0;

    // CRITICAL FIX: Expand short JDs before building sections
    const finalJD = (() => {
      if (!jdNormalized || jdNormalized.trim().length < 50) {
        const role = (jdNormalized || '').trim().toLowerCase();
        if (role.includes('software') || role.includes('developer')) {
          return `${jdNormalized} with experience in Python, Java, JavaScript, REST APIs, SQL databases, Git version control, and Agile methodology. Strong problem-solving and communication skills required.`;
        } else if (role.includes('data')) {
          return `${jdNormalized} with proficiency in Python, SQL, Pandas, NumPy, Tableau, Excel, and data visualization. Strong analytical and communication skills.`;
        } else if (role.includes('web')) {
          return `${jdNormalized} with knowledge of HTML, CSS, JavaScript, React, Node.js, REST APIs, MongoDB, and Git.`;
        } else if (role.includes('java')) {
          return `${jdNormalized} with Spring Boot, Hibernate, MySQL, REST APIs, Maven, Jenkins, and Git experience.`;
        } else if (jdNormalized && jdNormalized.trim().length > 0) {
          return `${jdNormalized} with relevant technical skills, programming languages, frameworks, databases, and strong problem-solving abilities.`;
        }
      }
      return jdNormalized || '';
    })();

    // Role preset for strong deterministic fallbacks and validation
    const rolePreset = getRolePreset(finalJD);
    
    // strict flags in closure for dynamicFallbackFor
    const strictFlags = { noFallback, aiOnly, forceStrict };

    // Shadow dynamicFallbackFor with behavior aware of strict flags
    function dynamicFallbackFor(type, label, rolePresetLocal, finalJDLocal, profileSkillsLocal) {
      // If caller explicitly wants AI-only behavior, NEVER synthesize text.
      if (strictFlags.noFallback || strictFlags.aiOnly || strictFlags.forceStrict) {
        return '';
      }
      // Non-strict (e.g. legacy UI or non-AI-only calls): keep existing behavior.
      try {
        if (type === 'summary') {
          return `<p>${escapeHtml(dynamicSummary(rolePresetLocal, finalJDLocal))}</p>`;
        }
        if (type === 'chips' && label === 'Technical Skills') {
          const skills = getSmartFallback('skills', finalJDLocal, mulberry32(makeSeed()));
          return (skills || []).map(s => `<span class="skill-tag">${escapeHtml(String(s || '').trim())}</span>`).join(' ');
        }
        if (type === 'list' && label === 'Certifications') {
          return getSmartFallback('certifications', finalJDLocal, mulberry32(makeSeed()))
            .split('|').map(c => `<li>${escapeHtml(c.trim())}</li>`).join('');
        }
        if (type === 'list' && label === 'Achievements') {
          return getSmartFallback('achievements', finalJDLocal, mulberry32(makeSeed()))
            .split('|').map(a => `<li>${escapeHtml(a.trim())}</li>`).join('');
        }
        if (type === 'list' && label === 'Projects') {
          return getSmartFallback('projects', finalJDLocal, mulberry32(makeSeed()))
            .split('|').map(p => `<li>${escapeHtml(p.trim())}</li>`).join('');
        }
      } catch (_) {}
      return '';
    }

    let htmlSkeleton = `
    <div class="generated-resume">
      ${RESUME_CSS}
      <div class="resume-header">
        <div class="resume-name">${escapeHtml(name)}</div>
        <div class="resume-contact">${contactLinks}</div>
      </div>
      ${resumeBodyHtml}
    </div>`;

    function buildRepairPrompt(pids, seed) {
      return `
You are an EXPERT RESUME INTELLIGENCE ENGINE.
JOB ROLE/DESCRIPTION: "${finalJD.slice(0, 1200)}"
USER PROFILE (may be partial): ${JSON.stringify(profile).slice(0, 1500)}

STRICT: Fill ONLY the requested missing sections. Return VALID JSON only with these keys: ${pids.join(', ')}.
NO placeholders. NO empty strings. NO markdown. NO extra keys.

SECTION INSTRUCTIONS:
${pids.map(k => `- ${k}: ${aiPrompts[k]} || VARIATION_NONCE:${seed}:${k}`).join('\n')}

VARIATION_SEED: ${seed}
`;
    }

    // Debug object (single source of truth) shared across render/AI pipeline
    const debug = Object.assign({}, debugBase, {
      attempts: [],
      usedFallbackFor: [],
      invalidAI: {},
      fallbackNote: '',
      retryAfterSeconds: 0,
      finalJD,
      daily: remainingInfo,
      jdWasInferred,
      jdNormalized,
    });

    function coerceAiDataToPids(aiData, pidMap) {
      if (!aiData || typeof aiData !== 'object') return null;
      const out = Object.assign({}, aiData);

      // Map common flat keys into expected pids when model returns flat structure
      const flatToPid = {
        summary: 'summary',
        intro: 'summary',
        objective: 'summary',
        fullname: 'summary', // sometimes summary text leaks here; keep minimal
        skills: 'technical skills',
        technicalskills: 'technical skills',
        work: 'work experience',
        workexperience: 'work experience',
        experience: 'work experience',
        projects: 'projects',
        education: 'education',
        certifications: 'certifications',
        certs: 'certifications',
        achievements: 'achievements',
        awards: 'achievements',
        charactertraits: 'character traits',
        softskills: 'character traits',
      };

      Object.entries(flatToPid).forEach(([k, pidName]) => {
        if (out[pidName]) return;
        const v = out[k];
        if (v === undefined) return;
        if (Array.isArray(v)) out[pidName] = v.join(' | ');
        else out[pidName] = String(v || '').trim();
      });

      const keyMap = {
        summary: ['summary', 'intro', 'objective'],
        'technical skills': ['technicalSkills', 'skills', 'hardSkills'],
        'work experience': ['work', 'workExperience', 'experience', 'jobs'],
        projects: ['projects', 'project'],
        education: ['education', 'academics'],
        certifications: ['certifications', 'certs'],
        achievements: ['achievements', 'awards'],
        'character traits': ['characterTraits', 'traits', 'softSkills', 'softskills'],
      };

      for (const [canon, pid] of Object.entries(pidMap)) {
        if (out[pid]) continue;
        const aliases = keyMap[canon] || [];
        for (const alt of aliases) {
          if (out[alt] !== undefined) {
            const v = out[alt];
            if (Array.isArray(v)) out[pid] = v.join(' | ');
            else out[pid] = String(v);
            break;
          }
        }
      }
      return out;
    }

    // Build intelligentPrompt (single definition) used for all AI attempts
    const intelligentPrompt = `
You are an EXPERT RESUME INTELLIGENCE ENGINE.

PRIMARY OBJECTIVE: Generate a complete, ATS-friendly resume where ALL sections are connected and role-aligned.

JOB ROLE/DESCRIPTION: "${finalJD.slice(0, 1200)}"
USER PROFILE (may be partial): ${JSON.stringify(profile).slice(0, 1500)}

STRICT VARIATION REQUIREMENTS:
- Every generation MUST be meaningfully different in wording and examples.
- Use VARIATION_SEED to pick different examples, metrics, and ordering.
- Do NOT repeat the same certification twice.
- Do NOT duplicate the same skill token.
- Projects must be different from each other (different problem + dataset + technique).
- Achievements must be different from each other and include measurable numbers.
- Character Traits: return 6 distinct soft skills.

RULES:
1) SUMMARY IS MANDATORY.
2) Infer role-appropriate technical skills; do not copy JD verbatim.
3) Skills must be used in Projects; Projects support Experience; Certs match Skills; Achievements come from Projects/Experience.
4) Return VALID JSON ONLY with these keys: ${Object.keys(aiPrompts).join(', ')}
5) Return ALL requested keys; if a section is unknown, use empty array/list or empty string.
6) Output JSON only. No markdown. No extra prose outside JSON.

SECTION INSTRUCTIONS:
${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v} || VARIATION_NONCE:${requestSeed}:${k}`).join('\n')}

OUTPUT: JSON only. No markdown.
`;

    function renderFromAiData(aiData, baseHtml) {
      let htmlOut = baseHtml;
      const missing = new Set();

      Object.keys(aiPrompts).forEach(pid => {
        let val = aiData ? aiData[pid] : null;
        const type = aiTypes[pid];
        const label = aiLabels[pid] || '';

        // Coerce common structures (arrays/objects) into strings for strict parsing
        if (Array.isArray(val)) {
          val = val.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' | ');
        } else if (val && typeof val === 'object') {
          // If object has "items" or similar, flatten values
          const possible = ['items', 'value', 'text'];
          for (const k of possible) {
            if (Array.isArray(val[k])) { val = val[k].join(' | '); break; }
            if (typeof val[k] === 'string') { val = val[k]; break; }
          }
          if (typeof val === 'object') {
            try { val = JSON.stringify(val); } catch (_) { val = String(val); }
          }
        }

        if (!val || typeof val !== 'string' || val.trim().length < 2) {
          let reason = 'unknown';
          if (val === undefined || val === null) reason = 'missing';
          else if (typeof val !== 'string') reason = `non-string (${typeof val})`;
          else if (typeof val === 'string' && val.trim().length < 2) reason = 'too-short/empty';
          debug.invalidAI[pid] = reason;

          // STRICT: mark as missing – do NOT synthesize anything
          if (noFallback || aiOnly || forceStrict) {
            missing.add(pid);
            return;
          }

          const dynamic = dynamicFallbackFor(type, label, rolePreset, finalJD, Array.isArray(profile.skills) ? profile.skills : []);
          htmlOut = htmlOut.replace(`[${pid}]`, dynamic || aiFallbacks[pid]);
          debug.usedFallbackFor.push(pid);
          return;
        }

        // SKILLS: augment instead of replacing completely
        if (type === 'chips' && label === 'Technical Skills') {
          let parts = val.split(/[,|\n]+/).map(s => s.trim()).filter(Boolean);
          parts = parts.map(normalizeSkillToken).filter(Boolean);
          // keep only likely technical tokens, else augment
          let techParts = parts.filter(p => isLikelyTechnical(p));
          // also allow rolePreset matches
          techParts = techParts.concat(parts.filter(p => rolePreset.skills.map(x=>x.toLowerCase()).includes(p.toLowerCase())));
          // add random preset skills to reach minimum using shuffled presets
          const shuffled = shuffleSeeded((rolePreset.skills || []).slice(), rand);
          for (const pick of shuffled) {
            if (techParts.length >= 12) break;
            const canonPick = normalizeSkillToken(pick);
            if (canonPick && !techParts.some(x => x.toLowerCase() === canonPick.toLowerCase())) techParts.push(canonPick);
          }

          techParts = dedupeSkillsLike(techParts);
          // Reorder with request-seeded randomness so even similar sets render differently
          techParts = shuffleSeeded(techParts, rand);
          if (techParts.length < 8) {
            if (noFallback || aiOnly) {
              missing.add(pid);
              return;
            }
            const dynamic = dynamicFallbackFor(type, label, rolePreset, finalJD, Array.isArray(profile.skills) ? profile.skills : []);
            htmlOut = htmlOut.replace(`[${pid}]`, dynamic || aiFallbacks[pid]);
            debug.usedFallbackFor.push(pid);
            return;
          }
          const chips = techParts.slice(0,15).map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
          htmlOut = htmlOut.replace(`[${pid}]`, chips);
          return;
        }

        // TRAITS (soft chips)
        if (type === 'chips' && label && label.toLowerCase().includes('character')) {
          let parts = val.split(/[,|\n]+/).map(s => s.trim()).filter(Boolean);
          let soft = parts.filter(p => !isLikelyTechnical(p)).slice(0,12);
          const extras = extractKeywordsFromJD(finalJD, 'soft');
          soft = enforceNDistinct(soft, 6, extras.concat(['Ownership','Curiosity','Learning Agility','Collaboration','Time Management','Adaptability','Attention to Detail']));
          const chips = soft.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
          htmlOut = htmlOut.replace(`[${pid}]`, chips);
          return;
        }

        // CERTIFICATIONS
        if (type === 'list' && label === 'Certifications') {
          let parts = val.split('|').map(b => b.trim()).filter(Boolean);
          const certs = rotateBySeed(enforceTwoDistinct(augmentCerts(parts, rolePreset), rolePreset.certs || []), rand);
          const lis = certs.map(b => `<li>${b}</li>`).join('');
          htmlOut = htmlOut.replace(`[${pid}]`, lis);
          return;
        }

        // ACHIEVEMENTS
        if (type === 'list' && label === 'Achievements') {
          let parts = val.split('|').map(b => b.trim()).filter(Boolean);
          let achs = augmentAchievements(parts, rolePreset);
          achs = rotateBySeed(achs, rand).map(a => seededBumpMetric(seededSynonymSwap(a, rand), rand));
          const lis = achs.map(b => `<li>${b}</li>`).join('');
          htmlOut = htmlOut.replace(`[${pid}]`, lis);
          return;
        }

        // SUMMARY - ensure contains tech
        if (type === 'summary') {
          let s = val.trim();
          const techs = rolePreset.skills || [];
          const hasTech = techs.some(t => s.toLowerCase().includes(t.toLowerCase()));
          if (!hasTech) s = `${s} Skilled in ${techs.slice(0,3).join(', ')}.`;
          // Guaranteed visible variation
          s = seededSynonymSwap(s, rand);
          s = seededBumpMetric(s, rand);
          htmlOut = htmlOut.replace(`[${pid}]`, `<p>${escapeHtml(s)}</p>`);
          return;
        }

        // PROJECTS
        if (type === 'list' && label === 'Projects') {
          const safeParser = (typeof parseProjectsToLis === 'function') ? parseProjectsToLis : function fallbackProjects(v, rolePreset, rand = Math.random) {
            const txt = String(v || '').split('|').map(s => s.trim()).filter(Boolean);
            const items = (txt.length ? txt : ['<b>Project:</b> Built a role-aligned solution', '<b>Project:</b> Measured outcome 25%+'])
              .slice(0, 2)
              .map(p => `<li>${augmentProjectIfNeeded(p, rolePreset, rand)}</li>`);
            return items.join('');
          };
          const lis = safeParser(val, rolePreset, rand);
          htmlOut = htmlOut.replace(`[${pid}]`, lis);
          return;
        }

        // final fallback
        if (noFallback || aiOnly || forceStrict) {
          // In strict mode, synthesize minimal Work Experience so the section isn't empty.
          if (label === 'Work Experience') {
            const roleName = rolePreset.title || 'Project Work';
            const company = rolePreset.company || 'Self-initiated';
            const skillsLine = (rolePreset.skills || []).slice(0, 3).join(', ');
            const bullet = skillsLine
              ? `Built and monitored data pipelines using ${escapeHtml(skillsLine)} to keep datasets reliable.`
              : 'Delivered a small project with measurable impact and documented outcomes.';
            const synthetic = `
              <div class="resume-item">
                <div class="resume-row">
                  <span class="resume-role">${escapeHtml(roleName)}</span>
                  <span class="resume-date">Present</span>
                </div>
                <span class="resume-company">${escapeHtml(company)}</span>
                <ul><li>${bullet}</li></ul>
              </div>`;
            htmlOut = htmlOut.replace(`[${pid}]`, synthetic);
            return;
          }
          // otherwise, mark missing
          missing.add(pid);
          return;
        }
        htmlOut = htmlOut.replace(`[${pid}]`, aiFallbacks[pid]);
        debug.invalidAI[pid] = debug.invalidAI[pid] || 'post-parse fallback';
        debug.usedFallbackFor.push(pid);
      });

      return { html: htmlOut, missing };
    }

    // --------------------
    // Build sectionsToRender from incoming scope (UI checkboxes) or sensible defaults.
    // --------------------
    const priority = [
      'Summary',
      'Technical Skills',
      'Work Experience',
      'Projects',
      'Education',
      'Certifications',
      'Achievements',
      'Character Traits',
    ];

    let sectionsToRender = [];

    if (Array.isArray(scope) && scope.length) {
      // Use client-provided scope, normalize via canonicalSectionName
      const seen = new Set();
      for (const rawTitle of scope) {
        const canon = canonicalSectionName(rawTitle);
        if (!canon) continue;
        const key = canon.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        sectionsToRender.push({ original: rawTitle, canonical: canon });
      }
    } else {
      // No explicit scope → default to the standard set
      sectionsToRender = priority.map((name) => ({ original: name, canonical: name }));
    }

    sectionsToRender.sort((a, b) => {
        const ia = priority.indexOf(a.canonical);
        const ib = priority.indexOf(b.canonical);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return 0;
    });

    // HARD GUARANTEE: always have at least Summary in scope so aiPrompts is non-empty.
    if (!sectionsToRender.length) {
      sectionsToRender.push({ original: 'Summary', canonical: 'Summary' });
    }

    // Build AI prompts for each requested section
    for (const secObj of sectionsToRender) {
      const label = secObj.canonical;

      // --- SUMMARY ---
      if (label === 'Summary') {
        aiPrompts['sec_1'] = `Write a compelling summary for an entry-level candidate targeting ${finalJD}. Focus on key skills and enthusiasm.`;
        aiTypes['sec_1'] = 'summary';
        aiLabels['sec_1'] = 'Summary';
        pidByCanonical['summary'] = 'sec_1';
        sectionCounter++;
        continue;
      }

      // --- WORK EXPERIENCE ---
      if (label === 'Work Experience') {
        const pid = `sec_${sectionCounter++}`;
        pidByCanonical['work experience'] = pid;
        aiPrompts[pid] = `List relevant work experiences for a candidate with skills in ${rolePreset.skills.join(', ')}. Focus on achievements and impact.`;
        aiTypes[pid] = 'list';
        aiLabels[pid] = 'Work Experience';
        continue;
      }

      // --- EDUCATION ---
      if (label === 'Education') {
        const pid = `sec_${sectionCounter++}`;
        pidByCanonical['education'] = pid;
        aiPrompts[pid] = `Detail the educational background, including degrees, majors, and institutions. Emphasize relevant coursework or honors.`;
        aiTypes[pid] = 'list';
        aiLabels[pid] = 'Education';
        continue;
      }

      // --- TECHNICAL SKILLS ---
      if (label === 'Technical Skills') {
        const pid = `sec_${sectionCounter++}`;
        pidByCanonical['technical skills'] = pid;
        pidByCanonical['skills'] = pid;
        aiPrompts[pid] = `List technical skills relevant to ${finalJD}. Include programming languages, tools, and technologies.`;
        aiTypes[pid] = 'chips';
        aiLabels[pid] = 'Technical Skills';
        continue;
      }

      // --- CERTIFICATIONS ---
      if (label === 'Certifications') {
        const pid = `sec_${sectionCounter++}`;
        pidByCanonical['certifications'] = pid;
        aiPrompts[pid] = `Mention any relevant certifications. Focus on those that enhance the candidate's qualifications for ${finalJD}.`;
        aiTypes[pid] = 'list';
        aiLabels[pid] = 'Certifications';
        continue;
      }

      // --- PROJECTS ---
      if (label === 'Projects') {
        const pid = `sec_${sectionCounter++}`;
        pidByCanonical['projects'] = pid;
        aiPrompts[pid] = `Describe key projects that demonstrate the candidate's skills in ${rolePreset.skills.join(', ')}. Highlight the candidate's role and the technologies used.`;
        aiTypes[pid] = 'list';
        aiLabels[pid] = 'Projects';
        continue;
      }

      // --- ACHIEVEMENTS ---
      if (label === 'Achievements') {
        const pid = `sec_${sectionCounter++}`;
        pidByCanonical['achievements'] = pid;
        aiPrompts[pid] = `List notable achievements that would impress employers for the role of ${finalJD}. Quantify results when possible.`;
        aiTypes[pid] = 'list';
        aiLabels[pid] = 'Achievements';
        continue;
      }

      // --- CHARACTER TRAITS ---
      if (label === 'Character Traits') {
        const pid = `sec_${sectionCounter++}`;
        pidByCanonical['character traits'] = pid;
        pidByCanonical['traits'] = pid;
        pidByCanonical['soft skills'] = pid;
        aiPrompts[pid] = `Describe the top 6 soft skills or character traits that best describe the candidate. Relate them to the job role where possible.`;
        aiTypes[pid] = 'chips';
        aiLabels[pid] = 'Character Traits';
        continue;
      }
    }

    const freeTierCacheKey = finalJD ? buildFreeCacheKey(profile, finalJD) : null;
    const cachingEnabled = useCache && !forceFresh;
    let cacheKeyToStore = null;
    let shouldCacheResult = false;

    // If, for any reason, no aiPrompts were defined, abort cleanly with a clear error
    if (!Object.keys(aiPrompts).length) {
      const debugNoPrompts = Object.assign({}, debug, { attempts: [], usedFallbackFor: [], invalidAI: {}, retryAfterSeconds: 0 });
      return res.status(400).json({
        ok: false,
        error: 'No AI sections were requested (empty scope / no prompts). At least one section such as Summary must be enabled.',
        debug: debugNoPrompts
      });
    }

    if (Object.keys(aiPrompts).length > 0 && finalJD && hasKey) {
      const cachedHtml = cachingEnabled && freeTierCacheKey ? getCachedHtml(freeTierCacheKey) : null;
      if (cachedHtml) {
        debug.cacheHit = true;
               return res.status(200).json({
          ok: true,
          generated: { html: cachedHtml },
          cached: true,
          debug
        });
      }

      // Enforce local daily limit only when AI is requested
      const ticket = consumeOne(userKey);
      debug.daily = ticket;
      if (!ticket.ok) {
        return res.status(429).json({
          ok: false,
          error: `Daily limit reached (${ticket.limit}/day). Try again after UTC reset.`,
          debug
        });
      }

      // Allow refunding daily ticket if Gemini quota blocks the request (429)
      const refundDailyTicket = () => {
        try {
          const state = globalThis.__DAILY_LIMIT_STATE__;
          if (!state || !state.byUser) return;
          const used = Number(state.byUser.get(userKey) || 0);
          if (used > 0) state.byUser.set(userKey, used - 1);
        } catch (_) {}
      };

      const baseSkeleton = htmlSkeleton;
      const runAiAttempt = async (seedBase36) => {
        const prompt = intelligentPrompt + `\nVARIATION_SEED: ${seedBase36}`;
        const aiJsonText = await callGeminiFlash(prompt, { temperature: GEMINI_FREE_TEMPERATURE, maxOutputTokens: 3000 });

        const parsedRaw =
          tryParseJsonLoose(aiJsonText) ||
          tryParseJsonSalvage(aiJsonText) ||
          tryParseJsonRepair(aiJsonText) ||
          tryParseKeyValuePairs(aiJsonText);
        const parsed = coerceAiDataToPids(parsedRaw, pidByCanonical);

        debug.attempts.push({
          temperature: GEMINI_FREE_TEMPERATURE,
          parsed: !!parsed,
          sample: String(aiJsonText || '').slice(0, 160),
        });

        // STRICT: if AI returned non-JSON, return a structured failure so client can fallback
        if (!parsed) {
          const err = new Error('Invalid AI response');
          err.code = 'AI_INVALID_JSON';
          throw err;
        }

        let render = renderFromAiData(parsed, baseSkeleton);

        if (render.missing.size && (forceStrict || aiOnly)) {
          // attempt repair for missing pids (no fallback)
          const missingPids = Array.from(render.missing);
          const repairSeeds = [makeSeed().toString(36), makeSeed().toString(36)];
          for (const rs of repairSeeds) {
            try {
              const repairPrompt = buildRepairPrompt(missingPids, rs);
              const repairText = await callGeminiFlash(repairPrompt, { temperature: 1.05, maxOutputTokens: 1800 });
              const repairParsed =
                tryParseJsonLoose(repairText) ||
                tryParseJsonSalvage(repairText) ||
                tryParseJsonRepair(repairText) ||
                tryParseKeyValuePairs(repairText);
              debug.attempts.push({ temperature: 1.05, parsed: !!repairParsed, repair: true, sample: String(repairText || '').slice(0, 160) });
              if (repairParsed) {
                const merged = Object.assign({}, parsed, repairParsed);
                render = renderFromAiData(merged, baseSkeleton);
                if (!render.missing.size) {
                  return { parsed: merged, render };
                }
              }
            } catch (repairErr) {
              debug.attempts.push({ temperature: 1.05, parsed: false, repair: true, error: String(repairErr && repairErr.message ? repairErr.message : repairErr) });
            }
          }
          // Strict mode, but still produce partial HTML instead of failing hard.
          debug.missing = missingPids;
          render.missing = new Set(); // accept partial render
        }
        return { parsed, render };
      };

      let aiSuccess = null;
      let lastErr = null;
      const seeds = [requestSeed.toString(36), makeSeed().toString(36), makeSeed().toString(36)];

      for (const s of seeds) {
        try {
          aiSuccess = await runAiAttempt(s);
          break;
        } catch (err) {
          lastErr = err;
          debug.lastError = String(err && err.message ? err.message : err);
          if (!forceStrict) break; // in non-strict mode we will fall back below
        }
      }

      if (aiSuccess) {
        htmlSkeleton = aiSuccess.render.html;
        cacheKeyToStore = cachingEnabled ? freeTierCacheKey : null;
        shouldCacheResult = !!cacheKeyToStore;
      } else {
        // STRICT AI-only: let client fallback on *any* AI failure (including invalid JSON)
        if (aiOnly || noFallback || forceStrict) {
          const msg = lastErr ? String(lastErr.message || lastErr) : 'AI failed';
          debug.aiFailureKind = lastErr && lastErr.code ? String(lastErr.code) : 'AI_FAILURE';
          return res.status(200).json({
            ok: false,
            error: msg,
            debug,
            allowClientFallback: true
          });
        }

        // Fallback to basic template with minimal AI
        const fallbackSeed = makeSeed();
        const fallbackRand = mulberry32(fallbackSeed);
        const fallbackParts = Object.keys(aiPrompts);
        const fallbackPrompt = `
You are an EXPERT RESUME INTELLIGENCE ENGINE.

PRIMARY OBJECTIVE: Generate a complete, ATS-friendly resume where ALL sections are connected and role-aligned.

JOB ROLE/DESCRIPTION: "${finalJD.slice(0, 1200)}"
USER PROFILE (may be partial): ${JSON.stringify(profile).slice(0, 1500)}

STRICT VARIATION REQUIREMENTS:
- Every generation MUST be meaningfully different in wording and examples.
- Use VARIATION_SEED to pick different examples, metrics, and ordering.
- Do NOT repeat the same certification twice.
- Do NOT duplicate the same skill token.
- Projects must be different from each other (different problem + dataset + technique).
- Achievements must be different from each other and include measurable numbers.
- Character Traits: return 6 distinct soft skills.

RULES:
1) SUMMARY IS MANDATORY.
2) Infer role-appropriate technical skills; do not copy JD verbatim.
3) Skills must be used in Projects; Projects support Experience; Certs match Skills; Achievements come from Projects/Experience.
4) Return VALID JSON ONLY with these keys: ${Object.keys(aiPrompts).join(', ')}

SECTION INSTRUCTIONS:
${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v} || VARIATION_NONCE:${fallbackSeed}:${k}`).join('\n')}

OUTPUT: JSON only. No markdown.
`;
        const fallbackRun = await callGeminiFlash(fallbackPrompt, { temperature: GEMINI_FREE_TEMPERATURE, maxOutputTokens: 3000 });
        const fallbackParsed = tryParseJsonLoose(fallbackRun);
        debug.attempts.push({ temperature: GEMINI_FREE_TEMPERATURE, parsed: !!fallbackParsed, sample: String(fallbackRun || '').slice(0, 160) });

        if (fallbackParsed) {
          htmlSkeleton = renderFromAiData(fallbackParsed, baseSkeleton).html;
        } else {
          throw new Error('Fallback AI response invalid');
        }
      }
    } else {
      // AI cannot be executed because either:
      // - GEMINI_API_KEY is missing, or
      // - finalJD is empty (should not happen with a real JD)
      const reason = !hasKey
        ? 'Gemini API key not configured or not available in runtime'
        : 'Missing finalJD; cannot build AI prompt';
      debug.cannotExecuteReason = reason;
      return res.status(503).json({ ok: false, error: reason, debug, allowClientFallback: true });
    }

    // If any section fell back, attach a short note explaining why this can happen
    if (Array.isArray(debug.usedFallbackFor) && debug.usedFallbackFor.length) {
      debug.fallbackNote = 'AI returned an unusable value for one or more sections (missing/empty/etc.). The server used robust fallbacks for those sections to avoid failing the whole resume.';
    }
    
    // Save to history only if we have a meaningful title (prevents blank "name:" items)
    try {
      const historyTitle = buildHistoryTitle({ nickname, profile, jd: jdNormalized, finalJD });
      if (historyTitle) {
        const histNickname = String(nickname || profile?.nickname || profile?.fullName || 'anonymous').trim().toLowerCase();
        const createdAt = new Date().toISOString();
        const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

        await saveHistory({
          id,
          nickname: histNickname,
          title: historyTitle,
          jd: jdNormalized,
          finalJD,
          html: htmlSkeleton,
          createdAt,
        });
        debug.historySaved = true;
      } else {
        debug.historySaved = false;
        debug.historySkipReason = 'empty-title';
      }
    } catch (e) {
      debug.historySaved = false;
      debug.historyError = String(e && e.message ? e.message : e);
    }

    // Guarantee profile education fields are reflected in HTML if the model omitted them
    try {
      const _p = (profile && typeof profile === 'object') ? profile : (body && body.profile ? body.profile : {});
      if (typeof htmlSkeleton === 'string' && htmlSkeleton.trim()) {
        htmlSkeleton = ensureEducationInHtml({ html: htmlSkeleton, profile: _p });
      }
    } catch (_) {}

    if (shouldCacheResult && cacheKeyToStore) {
      storeCachedHtml(cacheKeyToStore, htmlSkeleton);
      debug.cached = true;
      debug.cacheKey = cacheKeyToStore;
    }

    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton }, debug });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
      stack: err && err.stack ? String(err.stack) : undefined,
      allowClientFallback: err && (err.code === 'AI_INVALID_JSON' || err.code === 'AI_FAILURE'),
      debug: {
        requestSeed,
        aiEnabled: !!GEMINI_API_KEY,
        aiOnly,
        noFallback,
        forceStrict,
      }
    });
  }
};

// Build a stable "Recent Generations" title and avoid blanks
function buildHistoryTitle({ nickname, profile, jd, finalJD }) {
  const name = String(nickname || profile?.fullName || '').trim();
  const j = String(jd || '').trim();
  const fj = String(finalJD || '').trim();

  // Prefer normalized JD, fallback to expanded JD, else empty
  const role = j || (fj.split(' with ')[0] || '').trim();
  const title = role ? (role.length > 60 ? role.slice(0, 60) + '…' : role) : '';

  // If we still don't have a role/title, don't save history
  if (!title) return '';

  // Store a consistent "name: role" style title (UI can render as it likes)
  if (name) return `${name}: ${title}`;
  return title;
}

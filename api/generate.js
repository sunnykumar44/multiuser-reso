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
const GEMINI_FREE_TEMPERATURE = 0.95;
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
const GEMINI_MODEL_PREFERRED = (process.env.GEMINI_MODEL || process.env.GEMINI_PREFERRED_MODEL || '').trim();

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
  const maxOutputTokens = opts.maxOutputTokens || 2600;

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
    const candidate = j?.candidates?.[0]?.content?.parts?.[0]?.text;
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
    const { profile: rawProfile, jd, nickname, scope = [], aiOnly = false, forceFresh = false, useCache = true, forceStrict = false } = body;

    // STRICT: default noFallback should be TRUE if you want AI-only by design.
    // (keeps backward compatibility if someone explicitly passes noFallback=false)
    const noFallback = (typeof body.noFallback === 'boolean') ? body.noFallback : true;

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

    // 3. CALL AI (finalJD already declared above)
    const debug = { attempts: [], usedFallbackFor: [], invalidAI: {}, fallbackNote: '', retryAfterSeconds: 0, finalJD, aiEnabled: !!GEMINI_API_KEY, aiOnly, requestSeed, daily: remainingInfo, jdWasInferred, jdNormalized };

    // Build intelligentPrompt (required for AI path)
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

SECTION INSTRUCTIONS:
${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v} || VARIATION_NONCE:${requestSeed}:${k}`).join('\n')}

OUTPUT: JSON only. No markdown.
`;

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

    function renderFromAiData(aiData, baseHtml) {
      let htmlOut = baseHtml;
      const missing = new Set();

      Object.keys(aiPrompts).forEach(pid => {
        let val = aiData ? aiData[pid] : null;
        const type = aiTypes[pid];
        const label = aiLabels[pid] || '';

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
          // do NOT inject fallback; just mark missing
          missing.add(pid);
          return;
        }
        htmlOut = htmlOut.replace(`[${pid}]`, aiFallbacks[pid]);
        debug.invalidAI[pid] = debug.invalidAI[pid] || 'post-parse fallback';
        debug.usedFallbackFor.push(pid);
      });

      return { html: htmlOut, missing };
    }

    const freeTierCacheKey = finalJD ? buildFreeCacheKey(profile, finalJD) : null;
    const cachingEnabled = useCache && !forceFresh;
    let cacheKeyToStore = null;
    let shouldCacheResult = false;

    if (Object.keys(aiPrompts).length > 0 && finalJD && GEMINI_API_KEY) {
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
        const parsed = tryParseJsonLoose(aiJsonText);
        debug.attempts.push({ temperature: GEMINI_FREE_TEMPERATURE, parsed: !!parsed, sample: String(aiJsonText || '').slice(0, 160) });
        if (!parsed) throw new Error('Invalid AI response');
        let render = renderFromAiData(parsed, baseSkeleton);

        if (render.missing.size && (forceStrict || aiOnly)) {
          // attempt repair for missing pids (no fallback)
          const missingPids = Array.from(render.missing);
          const repairSeeds = [makeSeed().toString(36), makeSeed().toString(36)];
          for (const rs of repairSeeds) {
            try {
              const repairPrompt = buildRepairPrompt(missingPids, rs);
              const repairText = await callGeminiFlash(repairPrompt, { temperature: 1.05, maxOutputTokens: 1800 });
              const repairParsed = tryParseJsonLoose(repairText);
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
          throw new Error(`AI missing required sections after repair: ${Array.from(render.missing).join(', ')}`);
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
        // If strict AI-only, do not fall back. Return a hard error.
        if (aiOnly || noFallback || forceStrict) {
          return res.status(503).json({
            ok: false,
            error: lastErr ? String(lastErr.message || lastErr) : 'AI response invalid; strict mode disallows fallback.',
            debug
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
      // AI not executed (missing key/runtime)
      if (aiOnly || noFallback) {
        const reason = !GEMINI_API_KEY ? 'Gemini API key not configured or not available in runtime' : 'AI not executed';
        return res.status(503).json({ ok: false, error: reason, debug });
      }

      // ...existing code (fallback path only if allowed)...
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
    return res.status(500).json({ error: err.message });
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

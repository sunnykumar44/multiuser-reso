const { saveHistory } = require("./firebase");
const crypto = require('crypto');

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
  if (used >= DAILY_LIMIT) return { ok: false, remaining: 0, used, limit: DAILY_LIMIT, date: state.date };
  state.byUser.set(userKey, used + 1);
  return { ok: true, remaining: DAILY_LIMIT - (used + 1), used: used + 1, limit: DAILY_LIMIT, date: state.date };
}

function getRemaining(userKey) {
  const state = globalThis.__DAILY_LIMIT_STATE__;
  const d = todayUtc();
  if (state.date !== d) {
    return { remaining: DAILY_LIMIT, used: 0, limit: DAILY_LIMIT, date: d };
  }
  const used = Number(state.byUser.get(userKey) || 0);
  return { remaining: Math.max(DAILY_LIMIT - used, 0), used, limit: DAILY_LIMIT, date: state.date };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseRetryDelayMs(txt) {
  const m = String(txt || '').match(/"retryDelay"\s*:\s*"(\d+)s"/);
  if (m && m[1]) return Number(m[1]) * 1000;
  const m2 = String(txt || '').match(/retry in\s+(\d+)/i);
  if (m2 && m2[1]) return Number(m2[1]) * 1000;
  return 0;
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
    return skills;
  }
  if (section === 'certifications') return dynamicCerts(rolePreset, rand).join(' | ');
  if (section === 'projects') return dynamicProjects(rolePreset, rand).join(' | ');
  if (section === 'achievements') return dynamicAchievements(rolePreset, rand).join(' | ');
  return "";
}

function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function canonicalSectionName(name) {
  const s = String(name || "").trim().toLowerCase();
  if (s.includes("work") || s.includes("experience")) return "Work Experience"; 
  if (s.includes("technical") || s.includes("skill")) return "Technical Skills";
  if (s.includes("summary")) return "Summary";
  if (s.includes("education")) return "Education";
  if (s.includes("project")) return "Projects";
  if (s.includes("trait") || s.includes("character")) return "Character Traits";
  if (s.includes("cert")) return "Certifications";
  if (s.includes("achieve")) return "Achievements";
  return name.trim(); 
}

// --- CONSTANTS ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_KEY || process.env.GCP_API_KEY;

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
    .generated-resume ul { margin-left: 18px; margin-top: 4px; padding: 0; }
    .generated-resume li { margin-bottom: 4px; font-size: 11px; }
    .generated-resume p { margin-bottom: 4px; font-size: 11px; text-align: justify; }
    
    .skill-tag {
      display: inline-block; padding: 3px 8px; margin: 0 4px 4px 0;
      border: 1px solid #cbd5e1; border-radius: 4px; background-color: #f8fafc;
      font-size: 10px; font-weight: 600; color: #334155;
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

// Augment project text by inserting a role-relevant tech and a small measurable result
function augmentProjectIfNeeded(text, rolePreset, rand = Math.random) {
  // if text already mentions techs, return
  if (isLikelyTechnical(text)) return text;
  const tech = randomFromSeeded(rolePreset.skills || ['Python'], rand);
  const pct = randomPercentSeeded(rand, 10, 40);
  return `${text.trim()} Built using ${tech}. Achieved ~${pct}% improvement in relevant metric.`;
}

// Augment a certification list to ensure real certs
function augmentCerts(parts, rolePreset) {
  const out = [];
  for (const p of parts) {
    const hasKnown = ['AWS','Oracle','PCEP','Microsoft','ISTQB','Confluent','Google'].some(t => p.toUpperCase().includes(t));
    if (hasKnown) out.push(p);
    else out.push(randomFrom(rolePreset.certs || ['PCEP – Certified Entry-Level Python Programmer']));
  }
  // ensure two certs
  while (out.length < 2) out.push(randomFrom(rolePreset.certs || ['PCEP – Certified Entry-Level Python Programmer']));
  return out.slice(0,2);
}

// Augment achievements to include measurable numbers
function augmentAchievements(parts, rolePreset) {
  const out = [];
  for (const p of parts) {
    if (/%|\b(reduc|improv|increas|save|autom|improved|reduced)\b/i.test(p)) out.push(p);
    else out.push(`${p} Improved performance by ${randomPercent()}%.`);
  }
  while (out.length < 2) out.push(randomFrom(rolePreset.achievements || ['Delivered project demonstrating technical fundamentals']));
  return out.slice(0,2);
}

async function callGeminiFlash(promptText, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const base = `https://generativelanguage.googleapis.com/v1beta`;
  const keyQs = `key=${encodeURIComponent(GEMINI_API_KEY)}`;

  // Cache model choice for this server instance to avoid ListModels on every request
  globalThis.__GEMINI_TEXT_MODELS__ = globalThis.__GEMINI_TEXT_MODELS__ || null;

  async function listModels() {
    const resp = await fetch(`${base}/models?${keyQs}`, { method: 'GET' });
    if (!resp.ok) return null;
    const j = await resp.json().catch(() => null);
    return j;
  }

  async function pickModels() {
    const fallback = [
      'models/gemini-1.5-flash-002',
      'models/gemini-1.5-flash',
      'models/gemini-1.5-pro',
      'models/gemini-1.0-pro'
    ];

    if (Array.isArray(globalThis.__GEMINI_TEXT_MODELS__) && globalThis.__GEMINI_TEXT_MODELS__.length) {
      return globalThis.__GEMINI_TEXT_MODELS__;
    }

    const j = await listModels();
    const models = (j && Array.isArray(j.models)) ? j.models : [];
    const names = models.map(m => m && m.name).filter(Boolean);
    if (!names.length) {
      globalThis.__GEMINI_TEXT_MODELS__ = fallback;
      return fallback;
    }

    // Exclude image/vision models
    const textOnly = names.filter(n => n.includes('gemini') && !n.includes('image') && !n.includes('vision'));
    const preferred = textOnly.filter(n => n.includes('flash') || n.includes('pro'));
    const picked = preferred.length ? preferred : (textOnly.length ? textOnly : fallback);
    globalThis.__GEMINI_TEXT_MODELS__ = picked;
    return picked;
  }

  const candidatesModels = await pickModels();

  const temperature = (typeof opts.temperature === 'number') ? opts.temperature : 0.9;
  const topP = (typeof opts.topP === 'number') ? opts.topP : 0.95;
  const maxOutputTokens = opts.maxOutputTokens || 2600;

  function buildBody(withPenalty) {
    const gen = {
      temperature,
      topP,
      maxOutputTokens,
      responseMimeType: "application/json"
    };

    if (withPenalty) {
      gen.presencePenalty = (typeof opts.presencePenalty === 'number') ? opts.presencePenalty : 0.6;
      gen.frequencyPenalty = (typeof opts.frequencyPenalty === 'number') ? opts.frequencyPenalty : 0.4;
    }

    return {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: gen
    };
  }

  let lastErr = null;
  for (const modelName of candidatesModels) {
    const url = `${base}/${modelName}:generateContent?${keyQs}`;
    const body = buildBody(!opts.__noPenalty);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');

      // If this model doesn't support penalties, retry once without penalties
      if (resp.status === 400 && /Penalty is not enabled for this model/i.test(txt) && !opts.__noPenalty) {
        return callGeminiFlash(promptText, Object.assign({}, opts, { __noPenalty: true }));
      }

      // Optional single retry on 429 (rate limit) honoring retryDelay
      if (resp.status === 429 && !opts.__retriedOnce) {
        const ms = parseRetryDelayMs(txt);
        if (ms > 0 && ms <= 30000) {
          await sleep(ms);
          return callGeminiFlash(promptText, Object.assign({}, opts, { __retriedOnce: true }));
        }
      }

      lastErr = new Error(`Gemini API failed ${resp.status}: ${txt}`);
      continue;
    }

    const j = await resp.json();
    const candidate = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidate) {
      lastErr = new Error('No response from AI');
      continue;
    }
    return candidate;
  }

  throw lastErr || new Error('Gemini API failed');
}

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
    const { profile: rawProfile, jd, nickname, scope = [], aiOnly = false } = body;
    const profile = (rawProfile && typeof rawProfile === 'object') ? rawProfile : {};
    
    const userKey = getUserKey({ ...body, profile }, req);
    const remainingInfo = getRemaining(userKey);

    if (!jd || typeof jd !== 'string' || !jd.trim()) {
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
      if (!jd || jd.trim().length < 50) {
        const role = (jd || '').trim().toLowerCase();
        if (role.includes('software') || role.includes('developer')) {
          return `${jd} with experience in Python, Java, JavaScript, REST APIs, SQL databases, Git version control, and Agile methodology. Strong problem-solving and communication skills required.`;
        } else if (role.includes('data')) {
          return `${jd} with proficiency in Python, SQL, Pandas, NumPy, Tableau, Excel, and data visualization. Strong analytical and communication skills.`;
        } else if (role.includes('web')) {
          return `${jd} with knowledge of HTML, CSS, JavaScript, React, Node.js, REST APIs, MongoDB, and Git.`;
        } else if (role.includes('java')) {
          return `${jd} with Spring Boot, Hibernate, MySQL, REST APIs, Maven, Jenkins, and Git experience.`;
        } else if (jd && jd.trim().length > 0) {
          return `${jd} with relevant technical skills, programming languages, frameworks, databases, and strong problem-solving abilities.`;
        }
      }
      return jd || '';
    })();

    // Role preset for strong deterministic fallbacks and validation
    const rolePreset = getRolePreset(finalJD);
    
    // Map pid -> section label for validation later
    const seen = new Set();
    const sectionsToRender = [];
    const rawScope = (scope && scope.length) ? scope : ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Education', 'Certifications', 'Achievements', 'Character Traits'];
    
    for (const s of rawScope) {
        const c = canonicalSectionName(s);
        if (!seen.has(c)) {
            seen.add(c);
            sectionsToRender.push({ original: s, canonical: c });
        }
    }

    const priority = ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Education', 'Certifications', 'Achievements', 'Character Traits'];
    sectionsToRender.sort((a, b) => {
        const ia = priority.indexOf(a.canonical);
        const ib = priority.indexOf(b.canonical);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return 0;
    });

    for (const secObj of sectionsToRender) {
        const label = secObj.canonical;
        
        if (label === 'Summary') {
            resumeBodyHtml += `<div class="resume-section-title">Summary</div>`;
            const pid = `sec_${sectionCounter++}`;
            const original = profile.summary || "";
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `MANDATORY: Write a professional 3-4 sentence Summary for a FRESHER applying to: "${finalJD.slice(0,200)}". RULES: (1) Mention key technical skills inferred from role (2) Highlight project experience (3) Show eagerness to contribute (4) NO generic statements. Use ONLY job-relevant keywords. NEVER skip this.`;
            // Fallback uses first JD keyword
            const kw = extractKeywordsFromJD(jd, 'technical')[0] || jd.trim().split(' ')[0] || "Technical";
            const skills = extractKeywordsFromJD(jd, 'technical').slice(0, 3).join(', ');
            aiFallbacks[pid] = `<p>${escapeHtml(dynamicSummary(rolePreset, finalJD, rand))}</p>`;
            aiTypes[pid] = 'summary';
            aiLabels[pid] = 'Summary';
         }
        else if (label === 'Technical Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `INTELLIGENT SKILL INFERENCE: Based on role "${finalJD.slice(0, 100)}", infer 10-15 TECHNICAL skills that are: (1) Standard for this role (2) Include programming languages, frameworks, databases, tools (3) NOT copied verbatim from JD (4) Realistic for entry-level. User has: ${userSkills.join(',')}. Include them if relevant. Return comma-separated. Minimum 8 technical skills.`;
            
            // DYNAMIC FALLBACK: Use JD TECHNICAL keywords as skills, minimum 8
            const dynamicSkills = getSmartFallback('skills', finalJD, rand);
            const relevantUserSkills = userSkills.filter(s => jd.toLowerCase().includes(s.toLowerCase()));
            let combined = [...new Set([...relevantUserSkills, ...dynamicSkills])];
            
            // Ensure minimum 8 technical skills
            while (combined.length < 8) {
              const extra = extractKeywordsFromJD(jd, 'technical')[combined.length];
              if (extra && !combined.includes(extra)) combined.push(extra);
              else break;
            }
            
            combined = combined.slice(0, 15);
            aiFallbacks[pid] = combined.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiTypes[pid] = 'chips';
            aiLabels[pid] = 'Technical Skills';
         }
        else if (label === 'Work Experience') {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            // Dedupe
            const uniqueItems = new Map();
            if (experienceSections.length > 0) {
                 experienceSections.forEach(sec => {
                     (sec.items || []).forEach(item => {
                         if (!uniqueItems.has(item.key)) uniqueItems.set(item.key, { item, secTitle: sec.title });
                     });
                 });
            }

            if (uniqueItems.size > 0) {
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                for (const [key, data] of uniqueItems.entries()) {
                    const { item, secTitle } = data;
                    const pid = `sec_${sectionCounter++}`;
                    let companyName = secTitle.toLowerCase().includes('experience') ? "" : secTitle;
                    resumeBodyHtml += `
                      <div class="resume-item">
                        <div class="resume-row"><span class="resume-role">${escapeHtml(item.key)}</span><span class="resume-date">${escapeHtml(item.date || '')}</span></div>
                        ${companyName ? `<span class="resume-company">${escapeHtml(companyName)}</span>` : ''}
                        <ul id="${pid}">[${pid}]</ul>
                      </div>`;
                    aiPrompts[pid] = `MANDATORY: Rewrite experience bullet for role "${item.key}" to include keywords from: "${finalJD.slice(0,200)}". Format: 2 concise Pipe-separated bullets showing impact.`;
                    aiFallbacks[pid] = `<li>${escapeHtml(dynamicExperienceBullet(item.key, rolePreset, rand))}</li>`;
                    aiTypes[pid] = 'list';
                    aiLabels[pid] = 'Work Experience';
                 }
            }
        }
        else if (label === 'Projects') {
             resumeBodyHtml += `<div class="resume-section-title">Projects</div>`;
             const pid = `sec_${sectionCounter++}`;
             resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
             
             const projSec = (profile.customSections || []).find(s => s.title.toLowerCase().includes('project'));
             if (projSec && projSec.items && projSec.items.length) {
                  const inputs = projSec.items.slice(0, 2).map(i => `${i.key}: ${i.bullets}`).join(' || ');
                  aiPrompts[pid] = `INTELLIGENT PROJECT GENERATION: Rewrite 2 projects that MUST: (1) Use technical skills from role "${finalJD.slice(0,100)}" (2) Solve real problems (3) Show measurable impact. Input: "${inputs}". Format: "<b>Project Title with Tech Stack:</b> Description with technologies and outcome | <b>Title:</b> Description". Make them connected to the role.`;
                  aiLabels[pid] = 'Projects';
             } else {
                  aiPrompts[pid] = `CREATE 2 REALISTIC ACADEMIC PROJECTS for "${finalJD.slice(0,100)}" role. RULES: (1) MUST use inferred technical skills (2) MUST solve real problems (3) Show technologies used. Format: "<b>Project Name:</b> Built using [Tech Stack] to solve [Problem]. Achieved [Result]. | <b>Project 2:</b> Description". Entry-level appropriate.`;
                  aiLabels[pid] = 'Projects';
             }             // Dynamic Fallback
             aiFallbacks[pid] = getSmartFallback('projects', finalJD, rand).split('|').map(p => `<li>${p.trim()}</li>`).join('');
             aiTypes[pid] = 'list';
        }
        else if (label === 'Education') {
             resumeBodyHtml += `<div class="resume-section-title">Education</div>`;
             const eduList = (profile.education && profile.education.length) ? profile.education : (profile.college ? [profile.college] : []);
             resumeBodyHtml += `<div class="resume-item">`;
             if (eduList.length > 0) resumeBodyHtml += eduList.map(e => `<div>${escapeHtml(e)}</div>`).join('');
             else resumeBodyHtml += `<div><i>(Add Education)</i></div>`;
             resumeBodyHtml += `</div>`;
        }
        else if (label === 'Certifications') {
            resumeBodyHtml += `<div class="resume-section-title">Certifications</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            aiPrompts[pid] = `INTELLIGENT CERTIFICATION GENERATION for "${finalJD.slice(0, 100)}" role. Generate 2 REAL, FULL certification names that: (1) Match the technical skills (2) Are industry-standard (3) Appropriate for entry-level. Examples: "AWS Certified Cloud Practitioner", "Oracle Certified Associate, Java SE 11 Developer", "Microsoft Certified: Azure Fundamentals", "PCEP – Certified Entry-Level Python Programmer". Format: "Full Cert Name | Full Cert Name". NO generic names.`;
            aiFallbacks[pid] = getSmartFallback('certifications', finalJD, rand).split('|').map(c => `<li>${c.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
            aiLabels[pid] = 'Certifications';
        }
        else if (label === 'Achievements') {
            resumeBodyHtml += `<div class="resume-section-title">Achievements</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            aiPrompts[pid] = `INTELLIGENT ACHIEVEMENT GENERATION for "${finalJD.slice(0, 100)}" role. Create 2 SPECIFIC, MEASURABLE achievements that: (1) Use technical skills (2) Show quantifiable results (3) Are realistic for freshers. Examples: "Reduced API response time by 35% through caching optimization", "Automated data processing pipeline saving 20 hours/week", "Improved code test coverage from 60% to 85%". Format: "Achievement 1 | Achievement 2". NO generic statements.`;
            aiFallbacks[pid] = getSmartFallback('achievements', finalJD, rand).split('|').map(a => `<li>${a.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
            aiLabels[pid] = 'Achievements';
        }
         else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = `List 6-8 SOFT SKILLS/character traits from this JD: "${finalJD.slice(0,200)}". Examples: Communication, Teamwork, Leadership, Problem Solving. Comma-separated. NO technical skills. Minimum 6.`;
            
            // Dynamic Traits from JD SOFT SKILL Keywords - ensure minimum 6
            let kws = dynamicTraits(finalJD, rand);
            const fallbackStr = kws.join(' | ');
            aiFallbacks[pid] = fallbackStr.split('|').map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiTypes[pid] = 'chips';
            aiLabels[pid] = secObj.original;
         }
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
    const debug = { attempts: [], usedFallbackFor: [], finalJD, aiEnabled: !!GEMINI_API_KEY, aiOnly, requestSeed, daily: remainingInfo };

    // Build intelligentPrompt (required for AI path)
    const intelligentPrompt = `
You are an EXPERT RESUME INTELLIGENCE ENGINE.

PRIMARY OBJECTIVE: Generate a complete, ATS-friendly resume where ALL sections are connected and role-aligned.

JOB ROLE/DESCRIPTION: "${finalJD.slice(0, 1200)}"
USER PROFILE (may be partial): ${JSON.stringify(profile).slice(0, 1500)}

STRICT VARIATION REQUIREMENTS:
- Every generation MUST be meaningfully different in wording and examples.
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
${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

OUTPUT: JSON only. No markdown.
`;

    if (Object.keys(aiPrompts).length > 0 && finalJD && GEMINI_API_KEY) {
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
        
        // try AI with retries for short JD to encourage variability
        const temps = (finalJD && finalJD.trim().length < 50) ? [0.95, 1.05, 1.15] : [0.9, 1.0];
        let aiData = null;
        let lastError = null;
        for (const t of temps) {
            try {
                const seed = requestSeed.toString(36);
                const prompt = intelligentPrompt + `\nVARIATION_SEED: ${seed}`;
                const aiJsonText = await callGeminiFlash(prompt, { temperature: t, topP: 0.95, presencePenalty: 0.6, frequencyPenalty: 0.4, maxOutputTokens: 3000 });
                try { aiData = JSON.parse(aiJsonText.replace(/```json|```/g, '').trim()); debug.attempts.push({ temp: t, parsed: true }); } catch (e) { aiData = null; debug.attempts.push({ temp: t, parsed: false, error: e.message }); }
                if (aiData) break;
            } catch (e) {
                lastError = e;
                debug.attempts.push({ temp: t, parsed: false, error: e.message });
            }
        }

        try {
            if (!aiData) throw lastError || new Error('No AI data returned');

            Object.keys(aiPrompts).forEach(pid => {
                let val = aiData[pid];
                const type = aiTypes[pid];
                const label = aiLabels[pid] || '';
                if (!val || typeof val !== 'string' || val.trim().length < 2) {
                    const dynamic = dynamicFallbackFor(type, label, rolePreset, finalJD, Array.isArray(profile.skills) ? profile.skills : []);
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, dynamic || aiFallbacks[pid]);
                    debug.usedFallbackFor.push(pid);
                    return;
                }

                // SKILLS: augment instead of replacing completely
                if (type === 'chips' && label === 'Technical Skills') {
                    let parts = val.split(/[,|\n]+/).map(s => s.trim()).filter(Boolean);
                    // keep only likely technical tokens, else augment
                    let techParts = parts.filter(p => isLikelyTechnical(p));
                    // also allow rolePreset matches
                    techParts = techParts.concat(parts.filter(p => rolePreset.skills.map(x=>x.toLowerCase()).includes(p.toLowerCase())));
                    // add random preset skills to reach minimum using shuffled presets
                    const shuffled = shuffle((rolePreset.skills || []).slice());
                    for (const pick of shuffled) { if (techParts.length >= 8) break; if (!techParts.includes(pick)) techParts.push(pick); }
                    if (techParts.length < 8) {
                        // fallback using dynamic fallback
                        const dynamic = dynamicFallbackFor(type, label, rolePreset, finalJD, Array.isArray(profile.skills) ? profile.skills : []);
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, dynamic || aiFallbacks[pid]);
                        debug.usedFallbackFor.push(pid);
                        return;
                    }
                    const chips = techParts.slice(0,15).map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                    return;
                }

                // TRAITS (soft chips)
                if (type === 'chips' && label && label.toLowerCase().includes('character')) {
                    let parts = val.split(/[,|\n]+/).map(s => s.trim()).filter(Boolean);
                    let soft = parts.filter(p => !isLikelyTechnical(p)).slice(0,8);
                    const extras = extractKeywordsFromJD(finalJD, 'soft');
                    let idx = 0;
                    while (soft.length < 6 && idx < extras.length) { if (!soft.includes(extras[idx])) soft.push(extras[idx]); idx++; }
                    const chips = soft.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                    return;
                }

                // PROJECTS
                if (type === 'list' && label === 'Projects') {
                    let parts = val.split('|').map(b => b.trim()).filter(Boolean);
                    parts = parts.map(p => { if (isLikelyTechnical(p)) return p; return augmentProjectIfNeeded(p, rolePreset); });
                    const lis = parts.map(b => `<li>${b}</li>`).join('');
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                    return;
                }

                // CERTIFICATIONS
                if (type === 'list' && label === 'Certifications') {
                    let parts = val.split('|').map(b => b.trim()).filter(Boolean);
                    const certs = augmentCerts(parts, rolePreset);
                    const lis = certs.map(b => `<li>${b}</li>`).join('');
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                    return;
                }

                // ACHIEVEMENTS
                if (type === 'list' && label === 'Achievements') {
                    let parts = val.split('|').map(b => b.trim()).filter(Boolean);
                    const achs = augmentAchievements(parts, rolePreset);
                    const lis = achs.map(b => `<li>${b}</li>`).join('');
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                    return;
                }

                // SUMMARY - ensure contains tech
                if (type === 'summary') {
                    let s = val.trim();
                    const techs = rolePreset.skills || [];
                    const hasTech = techs.some(t => s.toLowerCase().includes(t.toLowerCase()));
                    if (!hasTech) s = `${s} Skilled in ${techs.slice(0,3).join(', ')}.`;
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<p>${escapeHtml(s)}</p>`);
                    return;
                }

                // Default for list/others
                if (type === 'list') {
                    const lis = val.split('|').map(b => `<li>${b.trim()}</li>`).join('');
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                    return;
                }

                // final fallback
                htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
            });
        } catch (e) {
            console.error('AI processing failed:', e);
            if (aiOnly) {
              const msg = String(e.message || 'AI failed');
              if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.toLowerCase().includes('quota')) {
                return res.status(429).json({ ok: false, error: 'Gemini quota/rate limit exceeded. Please wait and try again.', debug });
              }
              return res.status(503).json({ ok: false, error: msg, debug });
            }
            Object.keys(aiPrompts).forEach(pid => { htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]); debug.usedFallbackFor.push(pid); });
        }
    } else {
         if (aiOnly) {
           const reason = !GEMINI_API_KEY ? 'Gemini API key not configured or not available in runtime' : 'AI not executed';
           return res.status(503).json({ ok: false, error: reason, debug });
         }
         Object.keys(aiPrompts).forEach(pid => { htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]); debug.usedFallbackFor.push(pid); });
    }

    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton }, debug });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Replace unseeded implementations with seeded ones (keep old names used throughout)
function shuffle(arr) { return shuffleSeeded(arr, () => Math.random()); }

// Update dynamic helpers to accept optional rand
function dynamicSummary(rolePreset, finalJD, rand = Math.random) {
  const pct = randomPercentSeeded(rand, 15, 40);
  const core = shuffleSeeded((rolePreset.skills || []).slice(), rand).slice(0, 3);
  const a = `Entry-level ${finalJD.split(' with ')[0] || 'professional'} with hands-on project experience in ${core.join(', ')}.`;
  const b = `Built academic projects focused on data quality, automation, and performance optimization, achieving ~${pct}% improvements in key metrics.`;
  const c = `Strong fundamentals in problem-solving and collaboration, eager to contribute to production-grade systems and learn quickly.`;
  return `${a} ${b} ${c}`;
}

function dynamicCerts(rolePreset, rand = Math.random) {
   const pool = (rolePreset.certs && rolePreset.certs.length) ? rolePreset.certs.slice() : ['AWS Certified Cloud Practitioner','PCEP – Certified Entry-Level Python Programmer'];
   return shuffleSeeded(pool, rand).slice(0,2);
}

function dynamicAchievements(rolePreset, rand = Math.random) {
   const pool = (rolePreset.achievements && rolePreset.achievements.length) ? rolePreset.achievements.slice() : [];
   const chosen = shuffleSeeded(pool, rand).slice(0,2);
   return augmentAchievements(chosen.length ? chosen : ['Improved system performance', 'Automated a recurring workflow'], rolePreset);
}

function dynamicProjects(rolePreset, rand = Math.random) {
   const pool = (rolePreset.projects && rolePreset.projects.length) ? rolePreset.projects.slice() : [];
   const chosen = shuffleSeeded(pool, rand).slice(0,2);
   return chosen.map(p => augmentProjectIfNeeded(p, rolePreset));
}

function dynamicTraits(finalJD, rand = Math.random) {
   const base = extractKeywordsFromJD(finalJD, 'soft');
   const extras = ['Ownership','Attention to Detail','Curiosity','Stakeholder Communication','Time Management','Learning Agility'];
   return shuffleSeeded([...new Set(base.concat(extras))], rand).slice(0, 6);
}

function dynamicExperienceBullet(role, rolePreset, rand = Math.random) {
   const actions = ['Collaborated on', 'Developed', 'Optimized', 'Managed', 'Assisted with', 'Implemented'];
   const techs = shuffleSeeded((rolePreset.skills || []).slice(), rand).slice(0, 2);
   const outcomes = ['improving workflow efficiency by ~15%', 'reducing processing latency', 'enhancing system reliability', 'supporting data-driven decision making', 'streamlining internal processes'];
   return `${randomFromSeeded(actions, rand)} ${role} components using ${techs.join(' and ')}, ${randomFromSeeded(outcomes, rand)}.`;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomPercent(min = 10, max = 40) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
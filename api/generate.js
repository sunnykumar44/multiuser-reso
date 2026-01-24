const { saveHistory } = require("./firebase");

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
function getSmartFallback(section, jd) {
  const job = String(jd || "").toLowerCase();
  // Extract real keywords from the JD input
  const dynamicKeywords = extractKeywordsFromJD(jd);
  const mainKeyword = dynamicKeywords[0] || jd.trim().split(' ')[0] || "Technical";
  const secondKeyword = dynamicKeywords[1] || jd.trim().split(' ')[1] || "Skills";
  const thirdKeyword = dynamicKeywords[2] || "Development";

  // A. SKILLS - ALWAYS use JD TECHNICAL keywords, minimum 6
  if (section === 'skills') {
     // Return top technical keywords from JD directly
     const skills = extractKeywordsFromJD(jd, 'technical').slice(0, 15);
     // If not enough technical keywords, pad from role preset
     if (skills.length < 6) {
       const preset = getRolePreset(jd).skills || [];
       for (const p of preset) {
         if (skills.length >= 6) break;
         if (!skills.includes(p)) skills.push(p);
       }
     }
     return skills;
  }

  // B. CERTIFICATIONS - Use JD keywords
  if (section === 'certifications') {
    return `Certified ${mainKeyword} Professional | ${secondKeyword} Specialist Certification`;
  }

  // C. PROJECTS - Use JD keywords
  if (section === 'projects') {
     return `<b>${mainKeyword} ${thirdKeyword} System:</b> Implemented ${mainKeyword} features using ${secondKeyword} technologies. | <b>${secondKeyword} Optimization Tool:</b> Built ${thirdKeyword} solution for ${mainKeyword} processing.`;
  }

  // D. ACHIEVEMENTS - Use JD keywords
  if (section === 'achievements') {
      return `Improved ${mainKeyword} performance by 25% through ${secondKeyword} optimization. | Recognized for ${thirdKeyword} excellence in ${mainKeyword} implementation.`;
  }

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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

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

async function callGeminiFlash(promptText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.6, // Low temp for focused adherence to JD
      maxOutputTokens: 2048, 
      responseMimeType: "application/json"
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Gemini API failed ${resp.status}: ${txt}`);
  }
  
  const j = await resp.json();
  const candidate = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidate) throw new Error("No response from AI");
  
  return candidate;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const { profile, jd, nickname, scope = [] } = body;

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
            
            aiPrompts[pid] = `MANDATORY: Write a professional 3-4 sentence Summary for a FRESHER applying to: "${jd.slice(0,200)}". RULES: (1) Mention key technical skills inferred from role (2) Highlight project experience (3) Show eagerness to contribute (4) NO generic statements. Use ONLY job-relevant keywords. NEVER skip this.`;
            // Fallback uses first JD keyword
            const kw = extractKeywordsFromJD(jd, 'technical')[0] || jd.trim().split(' ')[0] || "Technical";
            const skills = extractKeywordsFromJD(jd, 'technical').slice(0, 3).join(', ');
            aiFallbacks[pid] = `<p>Motivated ${kw} professional with strong academic foundation and hands-on project experience in ${skills}. Demonstrated ability to apply technical knowledge to real-world problems through academic projects. Eager to contribute to organizational success and grow in a challenging environment.</p>`;
            aiTypes[pid] = 'summary';
            aiLabels[pid] = 'Summary';
         }
        else if (label === 'Technical Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `INTELLIGENT SKILL INFERENCE: Based on role "${jd.slice(0, 100)}", infer 10-15 TECHNICAL skills that are: (1) Standard for this role (2) Include programming languages, frameworks, databases, tools (3) NOT copied verbatim from JD (4) Realistic for entry-level. User has: ${userSkills.join(',')}. Include them if relevant. Return comma-separated. Minimum 8 technical skills.`;
            
            // DYNAMIC FALLBACK: Use JD TECHNICAL keywords as skills, minimum 8
            const dynamicSkills = getSmartFallback('skills', jd);
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
                    aiPrompts[pid] = `Rewrite experience: "${item.bullets}". Write 2 concise sentences using keywords: "${jd.slice(0,200)}...". Pipe-separated.`;
                    aiFallbacks[pid] = `<li>${escapeHtml(item.key)}</li>`;
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
                  aiPrompts[pid] = `INTELLIGENT PROJECT GENERATION: Rewrite 2 projects that MUST: (1) Use technical skills from role "${jd.slice(0,100)}" (2) Solve real problems (3) Show measurable impact. Input: "${inputs}". Format: "<b>Project Title with Tech Stack:</b> Description with technologies and outcome | <b>Title:</b> Description". Make them connected to the role.`;
                  aiLabels[pid] = 'Projects';
             } else {
                  aiPrompts[pid] = `CREATE 2 REALISTIC ACADEMIC PROJECTS for "${jd.slice(0,100)}" role. RULES: (1) MUST use inferred technical skills (2) MUST solve real problems (3) Show technologies used. Format: "<b>Project Name:</b> Built using [Tech Stack] to solve [Problem]. Achieved [Result]. | <b>Project 2:</b> Description". Entry-level appropriate.`;
                  aiLabels[pid] = 'Projects';
             }             // Dynamic Fallback
             aiFallbacks[pid] = getSmartFallback('projects', jd).split('|').map(p => `<li>${p.trim()}</li>`).join('');
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
            aiFallbacks[pid] = getSmartFallback('certifications', finalJD).split('|').map(c => `<li>${c.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
            aiLabels[pid] = 'Certifications';
        }
        else if (label === 'Achievements') {
            resumeBodyHtml += `<div class="resume-section-title">Achievements</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            aiPrompts[pid] = `INTELLIGENT ACHIEVEMENT GENERATION for "${finalJD.slice(0, 100)}" role. Create 2 SPECIFIC, MEASURABLE achievements that: (1) Use technical skills (2) Show quantifiable results (3) Are realistic for freshers. Examples: "Reduced API response time by 35% through caching optimization", "Automated data processing pipeline saving 20 hours/week", "Improved code test coverage from 60% to 85%". Format: "Achievement 1 | Achievement 2". NO generic statements.`;
            aiFallbacks[pid] = getSmartFallback('achievements', finalJD).split('|').map(a => `<li>${a.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
            aiLabels[pid] = 'Achievements';
        }
         else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = `List 6-8 SOFT SKILLS/character traits from this JD: "${jd.slice(0,200)}". Examples: Communication, Teamwork, Leadership, Problem Solving. Comma-separated. NO technical skills. Minimum 6.`;
            
            // Dynamic Traits from JD SOFT SKILL Keywords - ensure minimum 6
            let kws = extractKeywordsFromJD(jd, 'soft').slice(0, 8);
            while (kws.length < 6) {
              const defaults = ["Communication", "Problem Solving", "Teamwork", "Leadership", "Adaptability", "Initiative"];
              kws.push(defaults[kws.length % defaults.length]);
            }
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
    if (Object.keys(aiPrompts).length > 0 && finalJD) {
        // INTELLIGENT RESUME ENGINE PROMPT
        const intelligentPrompt = `
You are an EXPERT RESUME INTELLIGENCE ENGINE.

PRIMARY OBJECTIVE: Generate professional, ATS-friendly, logically connected resume content.

JOB ROLE/DESCRIPTION: "${finalJD.slice(0, 1000)}"
USER PROFILE: ${JSON.stringify(profile).slice(0, 1000)}

CRITICAL RULES (MANDATORY):
1. SUMMARY IS MANDATORY - Never skip. Must align with job role and showcase skills/impact.
2. DO NOT COPY VERBATIM from job description. INFER skills intelligently based on role.
3. EVERYTHING MUST BE CONNECTED: Skills → Projects → Experience → Certifications → Achievements.
4. Projects MUST use the technical skills listed AND solve real problems.
5. Certifications MUST match the technical skills and be realistic (e.g., AWS Certified, Oracle Java SE, PCEP Python).
6. Achievements MUST be specific, measurable, and result from projects/skills (e.g., "Improved API response time by 30%").
7. Generate realistic, entry-level friendly content for freshers.
8. NO PLACEHOLDERS like "Skill 3", "Skill 4" - always generate real skill names.
9. Certifications must be FULL PROPER NAMES (e.g., "AWS Certified Developer – Associate", not "Certified X Professional").
10. Projects must have REAL technology stacks and outcomes.

TASK: Return valid JSON with these exact keys: ${Object.keys(aiPrompts).join(', ')}

INSTRUCTIONS:
${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

INTELLIGENCE GUIDELINES:
- Technical Skills: Infer 8-12 real technologies for this role (Python, React, SQL, Docker, etc.)
- Projects: Create 2 projects with format: "<b>Project Name:</b> Built using [Tech Stack] to [Problem]. Achieved [Result]. | <b>Project 2:</b> ..."
- Certifications: Real certification names like "AWS Certified Cloud Practitioner", "Oracle Certified Java SE 11 Developer"
- Achievements: Specific results like "Reduced database query time by 40%", "Automated testing workflow saving 15 hours/week"

OUTPUT: Valid JSON only. No explanations. No markdown. NO placeholders.
`;

        try {
            const aiJsonText = await callGeminiFlash(intelligentPrompt);
            let aiData = {};
            try { aiData = JSON.parse(aiJsonText.replace(/```json|```/g, '').trim()); } catch (e) {
                console.error('AI JSON parse failed:', e);
            }

            Object.keys(aiPrompts).forEach(pid => {
                let val = aiData[pid];
                const type = aiTypes[pid];
                const label = aiLabels[pid] || '';
                // process AI output
                if (val && typeof val === 'string' && val.length > 2) {
                    // SKILLS (chips)
                    if (type === 'chips' && label === 'Technical Skills') {
                        const parts = val.split(/[,|\n]+/).map(s=>s.trim()).filter(Boolean);
                        const techCount = parts.filter(p => isLikelyTechnical(p)).length;
                        if (techCount < 6) {
                            // fallback to rolePreset skills
                            const chips = (rolePreset.skills || []).slice(0,8).map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
                            htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                        } else {
                            const chips = parts.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
                            htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                        }
                    }
                    // TRAITS (chips but soft skills)
                    else if (type === 'chips' && label && label.toLowerCase().includes('character')) {
                        const parts = val.split(/[,|\n]+/).map(s=>s.trim()).filter(Boolean);
                        const soft = parts.filter(p => !isLikelyTechnical(p)).slice(0,8);
                        while (soft.length < 6) {
                            const more = extractKeywordsFromJD(finalJD, 'soft') || [];
                            for (const m of more) { if (!soft.includes(m)) soft.push(m); if (soft.length>=6) break; }
                            break;
                        }
                        const chips = soft.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join(' ');
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                    }
                    // LIST (projects / certs / achievements)
                    else if (type === 'list') {
                        const parts = val.split('|').map(b => b.trim()).filter(Boolean);
                        if (label === 'Projects') {
                            const valid = parts.every(p => isLikelyTechnical(p) || rolePreset.projects.some(pr => p.toLowerCase().includes(pr.split(':')[0].toLowerCase())));
                            if (!valid) {
                                htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, (rolePreset.projects || []).slice(0,2).map(p=>`<li>${p}</li>`).join(''));
                            } else {
                                const lis = parts.map(b => `<li>${b}</li>`).join('');
                                htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                            }
                        } else if (label === 'Certifications') {
                            const CERT_TOKENS = ['AWS','Oracle','PCEP','Microsoft','ISTQB','Confluent','Google'];
                            const valid = parts.every(p => CERT_TOKENS.some(t => p.toUpperCase().includes(t.toUpperCase())) || p.split(' ').length>2);
                            if (!valid) {
                                htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, (rolePreset.certs || []).slice(0,2).map(c=>`<li>${c}</li>`).join(''));
                            } else {
                                const lis = parts.map(b => `<li>${b}</li>`).join('');
                                htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                            }
                        } else if (label === 'Achievements') {
                            const ACH_CHECK = parts.every(p => /%|\b(reduc|improv|increas|save|reduc|improv|autom|improved)\b/i.test(p) || p.split(' ').length>4);
                            if (!ACH_CHECK) {
                                htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, (rolePreset.achievements || []).slice(0,2).map(a=>`<li>${a}</li>`).join(''));
                            } else {
                                const lis = parts.map(b => `<li>${b}</li>`).join('');
                                htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                            }
                        } else {
                            const lis = parts.map(b => `<li>${b}</li>`).join('');
                            htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                        }
                    }
                    else if (type === 'summary') {
                        // ensure summary mentions at least one role skill
                        const s = val;
                        const techs = rolePreset.skills || [];
                        const hasTech = techs.some(t => s.toLowerCase().includes(t.toLowerCase()));
                        if (!hasTech && techs.length) {
                            const augmented = `${s} Skilled in ${techs.slice(0,3).join(', ')}.`;
                            htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<p>${escapeHtml(augmented)}</p>`);
                        } else {
                            htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<p>${escapeHtml(s)}</p>`);
                        }
                    }
                    else {
                        // default insertion
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
                    }
                } else {
                    // AI didn't return this key, use fallback
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
                }
            });
        } catch (e) {
            console.error('AI call failed:', e);
            Object.keys(aiPrompts).forEach(pid => htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]));
        }
    } else {
         // No AI call needed or JD too short - use JD-derived fallbacks
         console.log('Using JD-derived fallbacks (JD too short or no prompts)');
         Object.keys(aiPrompts).forEach(pid => htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]));
    }

    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton } });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
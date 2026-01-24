const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

// 1. DYNAMIC FALLBACKS (Strictly based on JD Keywords)
function getSmartFallback(section, jd) {
  const job = String(jd || "").toLowerCase();
  
  // --- SKILLS FALLBACK ---
  if (section === 'skills') {
     // Dev Roles
     if (job.includes('java')) return ["Java", "Spring Boot", "SQL", "OOPs", "Hibernate", "REST APIs"];
     if (job.includes('python') || job.includes('django') || job.includes('flask')) return ["Python", "Django", "SQL", "Pandas", "Git", "API Development"];
     if (job.includes('react') || job.includes('javascript') || job.includes('frontend')) return ["React.js", "JavaScript", "HTML5", "CSS3", "Redux", "TypeScript"];
     if (job.includes('node') || job.includes('backend')) return ["Node.js", "Express", "MongoDB", "SQL", "API Design", "AWS"];
     if (job.includes('data')) return ["SQL", "Python", "Excel", "Tableau", "PowerBI", "Statistics"];
     
     // Non-Dev Roles
     if (job.includes('marketing')) return ["SEO", "Content Strategy", "Google Analytics", "Social Media", "Copywriting"];
     if (job.includes('sales')) return ["CRM", "Lead Generation", "Negotiation", "Cold Calling", "Communication"];
     if (job.includes('design') || job.includes('ui/ux')) return ["Figma", "Adobe XD", "Photoshop", "Prototyping", "User Research"];
     
     // Generic Fallback (Don't guess a language)
     return ["Relevant Skill 1", "Relevant Skill 2", "Relevant Skill 3", "Relevant Skill 4", "Communication", "Problem Solving"];
  }

  // --- CERTIFICATIONS FALLBACK ---
  if (section === 'certifications') {
    if (job.includes('cloud') || job.includes('aws')) return "AWS Certified Cloud Practitioner | Microsoft Certified: Azure Fundamentals";
    if (job.includes('python')) return "PCEP – Certified Entry-Level Python Programmer | Google Data Analytics Certificate";
    if (job.includes('java')) return "Oracle Certified Associate, Java SE | Spring Professional Certification";
    if (job.includes('data')) return "Google Data Analytics Professional Certificate | IBM Data Science Professional Certificate";
    return "Certification Relevant to Job Title | Professional Course Completion";
  }

  // --- PROJECTS FALLBACK ---
  if (section === 'projects') {
     if (job.includes('java')) return "<b>Library Management System:</b> Built using Java Swing and MySQL. | <b>Employee Tracker:</b> REST API using Spring Boot.";
     if (job.includes('python')) return "<b>Data Scraper:</b> Automated extraction using Python/BeautifulSoup. | <b>Task CLI:</b> Productivity tool using Python Click.";
     if (job.includes('web') || job.includes('react')) return "<b>E-Commerce Site:</b> Responsive app using React and Redux. | <b>Portfolio:</b> Personal site deployed on Netlify.";
     return "<b>Academic Project 1:</b> Description relevant to the role. | <b>Academic Project 2:</b> Description demonstrating core competencies.";
  }

  // --- TRAITS FALLBACK ---
  if (section === 'traits') {
      if (job.includes('sales') || job.includes('marketing')) return "Persuasive | Resilient | Outgoing | Strategic";
      if (job.includes('lead') || job.includes('manager')) return "Leadership | Strategic Thinking | Empathy | Decisive";
      return "Fast Learner | Adaptable | Reliable | Detail-Oriented | Team Player";
  }

  return "Relevant Achievement 1 | Relevant Achievement 2";
}

// 2. CANONICAL NAMES
function canonicalSectionName(name) {
  const s = String(name || "").trim().toLowerCase();
  if (s.includes("work") || s.includes("experience")) return "Work Experience"; 
  if (s.includes("technical") || s.includes("skill")) return "Technical Skills";
  if (s.includes("summary")) return "Summary";
  if (s.includes("education")) return "Education";
  if (s.includes("project")) return "Projects";
  if (s.includes("trait") || s.includes("character")) return "Character Traits";
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
    .generated-resume li { margin-bottom: 3px; font-size: 11px; }
    .generated-resume p { margin-bottom: 4px; font-size: 11px; text-align: justify; }
    
    /* BOX/CHIP STYLE */
    .skill-tag {
      display: inline-block;
      padding: 3px 8px;
      margin: 0 4px 4px 0;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      background-color: #f8fafc;
      font-size: 10px;
      font-weight: 600;
      color: #334155;
    }
  </style>
`;

async function callGeminiFlash(promptText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 1.0, // Maximum creativity to adapt to new JDs
      maxOutputTokens: 4000,
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
    let sectionCounter = 0;

    // --- SCOPE DEDUPLICATION ---
    const seen = new Set();
    const sectionsToRender = [];
    const rawScope = (scope && scope.length) ? scope : ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Education', 'Character Traits'];
    
    for (const s of rawScope) {
        const c = canonicalSectionName(s);
        if (!seen.has(c)) {
            seen.add(c);
            sectionsToRender.push({ original: s, canonical: c });
        }
    }

    const priority = ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Education', 'Character Traits'];
    sectionsToRender.sort((a, b) => {
        const ia = priority.indexOf(a.canonical);
        const ib = priority.indexOf(b.canonical);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return 0;
    });

    // --- BUILD SECTIONS ---
    for (const secObj of sectionsToRender) {
        const label = secObj.canonical;
        
        // --- A. SUMMARY ---
        if (label === 'Summary') {
            resumeBodyHtml += `<div class="resume-section-title">Summary</div>`;
            const pid = `sec_${sectionCounter++}`;
            const original = profile.summary || "";
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `Write a 4-5 sentence professional summary for a Fresher '${jd.slice(0,100)}' role. Input: "${original}". STRICTLY tailor it to the Job Description: "${jd.slice(0,300)}...". Do NOT just repeat the input.`;
            aiFallbacks[pid] = `<p>Results-driven Fresher aspiring to start a career as a ${jd.slice(0,30)}, applying academic knowledge and project experience.</p>`;
            aiTypes[pid] = 'summary';
        }
        
        // --- B. SKILLS (CHIPS) ---
        else if (label === 'Technical Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            // STRICT JD RULE: Only include user skills if they match JD
            aiPrompts[pid] = `Extract 12-18 technical skills STRICTLY from this JD: "${jd.slice(0, 1000)}". Check user's skills: ${userSkills.join(', ')} -> Only keep the ones relevant to this JD. Add missing JD skills. Return comma-separated list.`;
            
            // Fallback: Smart fallback based on JD, NOT just user profile
            const fallbackList = getSmartFallback('skills', jd);
            aiFallbacks[pid] = fallbackList.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiTypes[pid] = 'chips';
        }
        
        // --- C. CHARACTER TRAITS (CHIPS) ---
        else if (label === 'Character Traits') {
            resumeBodyHtml += `<div class="resume-section-title">Character Traits</div>`;
            const pid = `sec_${sectionCounter++}`;
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().includes('trait') || s.title.toLowerCase().includes('character'));
            const original = existingSec ? (existingSec.items || []).join(', ') : "";

            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = `List 6-8 character traits valued specifically for a '${jd.slice(0,50)}' role. Return comma-separated list.`;
            
            const fallbackStr = getSmartFallback('traits', jd);
            const cleanFallback = fallbackStr.split(/[,|]/).map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiFallbacks[pid] = cleanFallback;
            aiTypes[pid] = 'chips';
        }

        // --- D. WORK EXPERIENCE (LONG SENTENCES) ---
        else if (label === 'Work Experience') {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            if (experienceSections.length > 0) {
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                for (const sec of experienceSections) {
                    for (const item of (sec.items || [])) {
                        const pid = `sec_${sectionCounter++}`;
                        
                        let companyName = sec.title;
                        const lowerTitle = sec.title.toLowerCase().trim();
                        if (lowerTitle === 'work experience' || lowerTitle === 'experience' || lowerTitle === 'work') {
                            companyName = "";
                        }

                        resumeBodyHtml += `
                          <div class="resume-item">
                            <div class="resume-row">
                              <span class="resume-role">${escapeHtml(item.key)}</span>
                              <span class="resume-date">${escapeHtml(item.date || '')}</span>
                            </div>
                            ${companyName ? `<span class="resume-company">${escapeHtml(companyName)}</span>` : ''}
                            <ul id="${pid}">[${pid}]</ul>
                          </div>`;
                        
                        aiPrompts[pid] = `Rewrite experience: "${item.bullets}" for role '${item.key}'. Write 3 DETAILED sentences using keywords from this JD: "${jd.slice(0,300)}...". Focus on results. Return pipe-separated string.`;
                        aiFallbacks[pid] = `<li>${escapeHtml(item.key)}</li>`;
                        aiTypes[pid] = 'list';
                    }
                }
            } else {
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                const pid = `sec_${sectionCounter++}`;
                resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
                aiPrompts[pid] = `Invent 2 realistic Intern/Freelance tasks for a '${jd.slice(0,50)}' role. Use tech stack mentioned in JD. Pipe-separated.`;
                aiFallbacks[pid] = "<ul><li><i>(No relevant experience found)</i></li></ul>";
                aiTypes[pid] = 'block-list';
            }
        }

        // --- E. PROJECTS ---
        else if (label === 'Projects') {
             resumeBodyHtml += `<div class="resume-section-title">Projects</div>`;
             const projSec = (profile.customSections || []).find(s => s.title.toLowerCase().includes('project'));
             
             if (projSec && projSec.items && projSec.items.length) {
                 const limitItems = projSec.items.slice(0, 2);
                 for (const item of limitItems) {
                    const pid = `sec_${sectionCounter++}`;
                    resumeBodyHtml += `
                      <div class="resume-item">
                        <div class="resume-row">
                          <span class="resume-role">${escapeHtml(item.key)}</span>
                        </div>
                        <ul id="${pid}">[${pid}]</ul>
                      </div>`;
                    aiPrompts[pid] = `Enhance project '${item.key}': "${item.bullets}". Write 2 detailed sentences. MUST MENTION technologies found in JD: "${jd.slice(0,200)}...". Return pipe-separated.`;
                    aiFallbacks[pid] = item.bullets ? `<li>${escapeHtml(item.bullets[0])}</li>` : `<li>${escapeHtml(item.key)}</li>`;
                    aiTypes[pid] = 'list';
                 }
             } else {
                 const pid = `sec_${sectionCounter++}`;
                 resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
                 // INVENT based on JD
                 aiPrompts[pid] = `Invent 2 academic projects for a '${jd.slice(0,50)}' role. Use KEYWORDS from: "${jd.slice(0,200)}". Format: "<b>Project Name:</b> Detailed description... | <b>Project Name:</b> Description..."`;
                 aiFallbacks[pid] = `<ul><li>${getSmartFallback('projects', jd)}</li></ul>`;
                 aiTypes[pid] = 'block-list';
             }
        }
        
        // --- F. EDUCATION ---
        else if (label === 'Education') {
             resumeBodyHtml += `<div class="resume-section-title">Education</div>`;
             const eduList = (profile.education && profile.education.length) 
                ? profile.education 
                : (profile.college ? [profile.college] : []);
             
             resumeBodyHtml += `<div class="resume-item">`;
             if (eduList.length > 0) {
                 resumeBodyHtml += eduList.map(e => `<div>${escapeHtml(e)}</div>`).join('');
             } else {
                 resumeBodyHtml += `<div><i>(Add Education)</i></div>`;
             }
             resumeBodyHtml += `</div>`;
        }
        
        // --- G. OTHERS (Certifications, etc) ---
        else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().trim() === label.toLowerCase());
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            if (existingSec) {
                const items = existingSec.items || [];
                const fallbackList = items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
                aiPrompts[pid] = `Refine list for '${label}': ${JSON.stringify(items)}. Tailor to JD. Return pipe-separated.`;
                aiFallbacks[pid] = `<ul>${fallbackList}</ul>`;
                aiTypes[pid] = 'block-list';
            } else {
                aiPrompts[pid] = `User checked '${label}' but has no data. INVENT 2 realistic examples for '${jd.slice(0,50)}'. Return pipe-separated.`;
                aiFallbacks[pid] = `<ul><li>${getSmartFallback(label.toLowerCase(), jd)}</li></ul>`;
                aiTypes[pid] = 'block-list';
            }
        }
    }

    // --- STEP 3: CALL AI & FORMAT ---
    let htmlSkeleton = `
    <div class="generated-resume">
      ${RESUME_CSS}
      <div class="resume-header">
        <div class="resume-name">${escapeHtml(name)}</div>
        <div class="resume-contact">${contactLinks}</div>
      </div>
      ${resumeBodyHtml}
    </div>`;

    if (Object.keys(aiPrompts).length > 0 && jd) {
        // Add random seed to prevent caching and force variety
        const seed = Math.random().toString(36).substring(7);
        
        const prompt = `
        You are a Resume Content Generator. Seed: ${seed}.
        TASK: Return valid JSON. Keys: ${Object.keys(aiPrompts).join(', ')}.
        INSTRUCTIONS:
        ${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
        `;

        try {
            const aiJsonText = await callGeminiFlash(prompt);
            let aiData = {};
            try {
                aiData = JSON.parse(aiJsonText.replace(/```json|```/g, '').trim());
            } catch (e) { console.error("JSON Error", e); }

            Object.keys(aiPrompts).forEach(pid => {
                let val = aiData[pid];
                const type = aiTypes[pid];
                
                if (val && typeof val === 'string' && val.length > 2) {
                    if (type === 'chips') { 
                        const chips = val.split(/[,|]/).map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                    } 
                    else if (type === 'list') { 
                        const lis = val.split('|').map(b => `<li>${escapeHtml(b.trim())}</li>`).join('');
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                    }
                    else if (type === 'block-list') { 
                        const lis = val.split('|').map(b => `<li>${escapeHtml(b.trim())}</li>`).join('');
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<ul>${lis}</ul>`);
                    }
                    else { // Summary
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<p>${escapeHtml(val)}</p>`);
                    }
                } else {
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
                }
            });

        } catch (e) {
            Object.keys(aiPrompts).forEach(pid => {
                htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
            });
        }
    } else {
         Object.keys(aiPrompts).forEach(pid => {
             htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
         });
    }

    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton } });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
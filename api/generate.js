const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

// Quick JD keyword extractor
function extractKeywords(text, limit = 6) {
  if (!text || typeof text !== 'string') return [];
  const stop = new Set(['the','and','to','a','an','of','in','for','with','on','as','is','are','be','by','at','from','that','this','will','have','has','role','responsibilities']);
  const toks = text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
  const counts = {};
  for (const t of toks) {
    if (t.length < 3) continue;
    if (stop.has(t)) continue;
    counts[t] = (counts[t]||0)+1;
  }
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,limit).map(x=>x[0]);
}

// Experience fallback: generate 3 reasonable bullets without duplicating role title
function makeExperienceFallback(role, jd, company) {
  const jdKeys = extractKeywords(jd, 4);
  const top = jdKeys.join(', ') || 'relevant technologies';
  const bullets = [];
  bullets.push(`Contributed to ${escapeHtml(company || 'projects')} as ${escapeHtml(role)}, working with ${escapeHtml(top)} to deliver key features.`);
  bullets.push(`Implemented and tested features, improving reliability and performance through automated tests and monitoring.`);
  bullets.push(`Collaborated with cross-functional teams to deliver project milestones on schedule.`);
  return bullets.map(b => `<li>${b}</li>`).join('');
}

// 1. SMART FALLBACKS (Specific, Realistic Titles)
function getSmartFallback(section, jd) {
  const job = String(jd || "").toLowerCase();
  
  // --- SKILLS ---
  if (section === 'skills') {
     const common = ["Problem Solving", "Git", "Communication", "Agile"];
     if (job.includes('java')) return ["Java", "Spring Boot", "SQL", "Hibernate", "REST APIs", ...common];
     if (job.includes('python')) return ["Python", "Django", "SQL", "Pandas", "Flask", ...common];
     if (job.includes('react') || job.includes('front')) return ["React.js", "JavaScript", "HTML5", "CSS3", "Redux", ...common];
     return ["Technical Skill 1", "Technical Skill 2", "SQL", "Git", "Communication", "Teamwork"];
  }

  // --- CERTIFICATIONS (2 Items) ---
  if (section === 'certifications') {
    if (job.includes('cloud') || job.includes('aws')) return "AWS Certified Cloud Practitioner | Microsoft Certified: Azure Fundamentals";
    if (job.includes('python')) return "PCEP – Certified Entry-Level Python Programmer | Google Data Analytics Certificate";
    if (job.includes('java')) return "Oracle Certified Associate (Java SE) | Spring Professional Certification";
    return "Course Completion: Full Stack Development | Certificate in Professional Communication";
  }

  // --- PROJECTS (2 Specific Titles) ---
  if (section === 'projects') {
     if (job.includes('java')) 
        return "<b>Employee Management System:</b> Built a CRUD application using Java Swing and MySQL to track employee records. | <b>Online Bookstore:</b> Developed a RESTful API backend using Spring Boot for managing book inventory.";
     
     if (job.includes('python')) 
        return "<b>Weather Forecast App:</b> Created a CLI tool using Python and OpenWeatherMap API to fetch real-time data. | <b>Sentiment Analysis Tool:</b> Implemented a text analysis script using NLTK to classify customer reviews.";
     
     if (job.includes('web') || job.includes('react')) 
        return "<b>E-Commerce Dashboard:</b> Built a responsive admin panel using React.js and Redux. | <b>Personal Portfolio:</b> Designed and deployed a static website on Netlify using HTML5/CSS3.";
     
     return "<b>Academic Management System:</b> Designed a database schema and frontend for college operations. | <b>Task Tracker App:</b> Built a to-do list application to improve personal productivity.";
  }

  // --- ACHIEVEMENTS (2 Items) ---
  if (section === 'achievements') {
      return "Awarded 'Best Student Project' for final year submission among 50+ entries. | Ranked in the top 10% of participants in the Annual Coding Hackathon.";
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
    
    /* LIST STYLING */
    .generated-resume ul { margin-left: 18px; margin-top: 4px; padding: 0; }
    .generated-resume li { margin-bottom: 4px; font-size: 11px; }
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
      temperature: 0.9, 
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
    const rawScope = (scope && scope.length) ? scope : ['Summary', 'Technical Skills', 'Projects', 'Education', 'Certifications', 'Achievements'];
    
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

    // --- BUILD SECTIONS ---
    for (const secObj of sectionsToRender) {
        const label = secObj.canonical;
        
        // --- A. SUMMARY (Integrated) ---
        if (label === 'Summary') {
            resumeBodyHtml += `<div class="resume-section-title">Summary</div>`;
            const pid = `sec_${sectionCounter++}`;
            const original = profile.summary || "";
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            // Context Awareness: Read Projects/Certs from profile to inform summary
            const projContext = (profile.customSections||[]).filter(s=>s.title.includes('Project')).map(s=>JSON.stringify(s)).join(' ');
            const certContext = (profile.customSections||[]).filter(s=>s.title.includes('Cert')).map(s=>JSON.stringify(s)).join(' ');

            aiPrompts[pid] = `Write a professional 4-sentence summary for a Fresher '${jd.slice(0,50)}' role. 
            Base it on: "${original}". 
            Mention key projects/certs if they exist: ${projContext} ${certContext}. 
            Strictly tailor to JD: "${jd.slice(0,200)}".`;
            
            aiFallbacks[pid] = `<p>Aspiring ${jd.slice(0,30)} with a strong academic background and project experience, eager to apply technical skills to drive organizational success.</p>`;
            aiTypes[pid] = 'summary';
        }
        
        // --- B. SKILLS (CHIPS - Min 6) ---
        else if (label === 'Technical Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `List 8-12 technical skills for '${jd.slice(0,50)}'. MUST INCLUDE: ${userSkills.join(', ')}. Fill gaps using JD keywords. Return comma-separated list.`;
            
            // Smart Fallback
            const smartSkills = getSmartFallback('skills', jd);
            const combined = [...new Set([...userSkills, ...smartSkills])].slice(0, 10);
            aiFallbacks[pid] = combined.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiTypes[pid] = 'chips';
        }
        
        // --- C. WORK EXPERIENCE ---
        else if (label === 'Work Experience') {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            if (experienceSections.length > 0) {
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                for (const sec of experienceSections) {
                    for (const item of (sec.items || [])) {
                        const pid = `sec_${sectionCounter++}`;
                        let companyName = sec.title.toLowerCase().includes('experience') ? "" : sec.title;

                        resumeBodyHtml += `
                          <div class="resume-item">
                            <div class="resume-row">
                              <span class="resume-role">${escapeHtml(item.key)}</span>
                              <span class="resume-date">${escapeHtml(item.date || '')}</span>
                            </div>
                            ${companyName ? `<span class="resume-company">${escapeHtml(companyName)}</span>` : ''}
                            <ul id="${pid}">[${pid}]</ul>
                          </div>`;
                        
                        aiPrompts[pid] = `Rewrite bullets: "${item.bullets}". Write 3 DETAILED sentences. Tailor to JD keywords. Pipe-separated.`;
                        aiFallbacks[pid] = makeExperienceFallback(item.key, jd, companyName);
                        aiTypes[pid] = 'list';
                    }
                }
            } else {
                // If user selected Experience but has none, skip it or show empty
                // (User prefers Project focus for fresher)
            }
        }

        // --- D. PROJECTS (Strictly 2, New Lines) ---
        else if (label === 'Projects') {
             resumeBodyHtml += `<div class="resume-section-title">Projects</div>`;
             const projSec = (profile.customSections || []).find(s => s.title.toLowerCase().includes('project'));
             
             // Setup for 2 slots
             const pid = `sec_${sectionCounter++}`;
             resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;

             if (projSec && projSec.items && projSec.items.length) {
                 const inputs = projSec.items.slice(0, 2).map(i => `${i.key}: ${i.bullets}`).join(' | ');
                 aiPrompts[pid] = `Rewrite these 2 projects: "${inputs}". Format: "<b>Title:</b> Detailed Description | <b>Title:</b> Detailed Description". Tailor to JD: "${jd.slice(0,100)}".`;
             } else {
                 aiPrompts[pid] = `Invent 2 academic projects for '${jd.slice(0,50)}'. Format: "<b>Title:</b> Tech stack & feature description | <b>Title:</b> Tech stack & feature description".`;
             }
             
             aiFallbacks[pid] = getSmartFallback('projects', jd).split('|').map(p => `<li>${p.trim()}</li>`).join('');
             aiTypes[pid] = 'list';
        }
        
        // --- E. EDUCATION ---
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
        
        // --- F. CERTIFICATIONS (Strictly 2) ---
        else if (label === 'Certifications') {
            resumeBodyHtml += `<div class="resume-section-title">Certifications</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            
            aiPrompts[pid] = `Invent 2 relevant certifications for '${jd.slice(0,50)}'. Format: "Cert Name | Cert Name".`;
            aiFallbacks[pid] = getSmartFallback('certifications', jd).split('|').map(c => `<li>${c.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
        }

        // --- G. ACHIEVEMENTS (Strictly 2) ---
        else if (label === 'Achievements') {
            resumeBodyHtml += `<div class="resume-section-title">Achievements</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            
            aiPrompts[pid] = `Invent 2 academic achievements for a fresher. Pipe-separated.`;
            aiFallbacks[pid] = getSmartFallback('achievements', jd).split('|').map(a => `<li>${a.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
        }

        // --- H. TRAITS / OTHERS ---
        else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `List 6 character traits for '${jd.slice(0,50)}'. Comma-separated.`;
            aiFallbacks[pid] = "Fast Learner | Adaptable | Reliable | Hardworking".split('|').map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiTypes[pid] = 'chips';
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
                        const lis = val.split('|').map(b => `<li>${b.trim()}</li>`).join(''); // allow inner HTML (<b>)
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                    }
                    else if (type === 'block-list') { 
                        const lis = val.split('|').map(b => `<li>${b.trim()}</li>`).join('');
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
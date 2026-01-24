const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

// --- 1. SUPER SMART FALLBACKS (The "Safety Net") ---
// If AI fails, this logic manually looks at the JD to generate content.
function getSmartFallback(section, jd) {
  const job = String(jd || "").toLowerCase();
  
  // A. SKILLS FALLBACK
  if (section === 'skills') {
     // Testing / QA
     if (job.includes('test') || job.includes('qa') || job.includes('quality')) 
        return ["Manual Testing", "JIRA", "SQL", "Bug Reporting", "Test Cases", "Selenium", "Agile"];
     
     // Java
     if (job.includes('java')) 
        return ["Java", "Spring Boot", "Hibernate", "SQL", "Maven", "REST APIs", "Microservices"];
     
     // Python
     if (job.includes('python') || job.includes('django')) 
        return ["Python", "Django", "Flask", "SQL", "Pandas", "Git", "API Development"];
     
     // Web
     if (job.includes('react') || job.includes('frontend') || job.includes('web')) 
        return ["React.js", "JavaScript", "HTML5", "CSS3", "Redux", "Tailwind", "Responsive Design"];
     
     // Data
     if (job.includes('data') || job.includes('analyst')) 
        return ["SQL", "Excel", "PowerBI", "Python", "Data Visualization", "Statistics"];
     
     // Generic / Admin
     if (job.includes('admin') || job.includes('support')) 
        return ["Microsoft Office", "Communication", "Data Entry", "Customer Service", "Time Management"];
     
     // Ultimate Fallback (No "Skill 1")
     return ["Communication", "Problem Solving", "Teamwork", "Time Management", "Project Management", "Research"];
  }

  // B. CERTIFICATIONS FALLBACK
  if (section === 'certifications') {
    if (job.includes('cloud') || job.includes('aws')) return "AWS Certified Cloud Practitioner | Microsoft Certified: Azure Fundamentals";
    if (job.includes('test') || job.includes('qa')) return "ISTQB Certified Tester Foundation Level | Certified Software Tester (CSTE)";
    if (job.includes('python')) return "PCEP – Certified Entry-Level Python Programmer | Google Data Analytics Certificate";
    if (job.includes('java')) return "Oracle Certified Associate (Java SE) | Spring Professional Certification";
    return "Certificate of Completion: Professional Skills | Advanced Excel Certification";
  }

  // C. PROJECTS FALLBACK
  if (section === 'projects') {
     if (job.includes('java')) 
        return "<b>Employee Management System:</b> Java Swing & MySQL app for tracking records. | <b>Library API:</b> Spring Boot REST API for inventory management.";
     
     if (job.includes('test') || job.includes('qa')) 
        return "<b>E-Commerce Testing Suite:</b> Wrote 50+ test cases and executed manual testing cycles for a shopping cart module. | <b>Bug Tracking System:</b> Configured JIRA workflows for defect tracking and reporting.";

     if (job.includes('python')) 
        return "<b>Weather App:</b> CLI tool using Python and OpenWeatherMap API. | <b>Sentiment Analysis:</b> text classification script using NLTK.";
     
     return "<b>Academic Management System:</b> Designed database schema for college operations. | <b>Task Tracker App:</b> Built a to-do list application to improve productivity.";
  }

  // D. ACHIEVEMENTS FALLBACK
  if (section === 'achievements') {
      return "Awarded 'Best Student Project' for final year submission among 50+ entries. | Ranked in the top 10% of participants in the Annual Coding Hackathon.";
  }

  return "";
}

// 2. CANONICAL NAMES (Merges "Work" and "Experience")
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
      maxOutputTokens: 2048, // Reduced slightly to improve speed/reliability
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
        
        // --- A. SUMMARY ---
        if (label === 'Summary') {
            resumeBodyHtml += `<div class="resume-section-title">Summary</div>`;
            const pid = `sec_${sectionCounter++}`;
            const original = profile.summary || "";
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `Write a professional 4-sentence summary tailored to this Job Description: "${jd.slice(0,300)}...". IGNORE profile data if it contradicts the JD. Focus on keywords from JD.`;
            aiFallbacks[pid] = `<p>Aspiring professional looking to leverage skills in ${jd.slice(0,50)} to contribute to organizational success.</p>`;
            aiTypes[pid] = 'summary';
        }
        
        // --- B. SKILLS (CHIPS) ---
        else if (label === 'Technical Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `List 12-15 technical skills STRICTLY from this JD: "${jd.slice(0, 800)}". Include user's skills (${userSkills.join(', ')}) ONLY if relevant. Return comma-separated list.`;
            
            // Smart Fallback
            const fallbackList = getSmartFallback('skills', jd);
            // Append user skills to fallback if they match basic logic, else use JD fallback
            const combined = [...new Set([...fallbackList])];
            aiFallbacks[pid] = combined.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiTypes[pid] = 'chips';
        }
        
        // --- C. WORK EXPERIENCE ---
        else if (label === 'Work Experience') {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            // Deduplicate Items in Experience
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
                        <div class="resume-row">
                          <span class="resume-role">${escapeHtml(item.key)}</span>
                          <span class="resume-date">${escapeHtml(item.date || '')}</span>
                        </div>
                        ${companyName ? `<span class="resume-company">${escapeHtml(companyName)}</span>` : ''}
                        <ul id="${pid}">[${pid}]</ul>
                      </div>`;
                    
                    aiPrompts[pid] = `Rewrite experience for role '${item.key}'. Write 3 DETAILED sentences using keywords from JD: "${jd.slice(0,200)}...". Return pipe-separated string.`;
                    aiFallbacks[pid] = `<li>${escapeHtml(item.key)}</li>`;
                    aiTypes[pid] = 'list';
                }
            } else {
                 // No Experience in profile? DO NOT INVENT if not asked, or invent relevant if asked.
                 // We will invent only if explicitly in scope, but typically for freshers we skip or show "Internship"
            }
        }

        // --- D. PROJECTS (Strictly 2) ---
        else if (label === 'Projects') {
             resumeBodyHtml += `<div class="resume-section-title">Projects</div>`;
             // Setup for 2 slots
             const pid = `sec_${sectionCounter++}`;
             resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
             
             // Check if user has projects
             const projSec = (profile.customSections || []).find(s => s.title.toLowerCase().includes('project'));
             
             if (projSec && projSec.items && projSec.items.length) {
                  // User has projects, try to use them but tailor to JD
                  const inputs = projSec.items.slice(0, 2).map(i => `${i.key}: ${i.bullets}`).join(' || ');
                  aiPrompts[pid] = `Rewrite these 2 projects: "${inputs}". Format: "<b>Title:</b> Desc | <b>Title:</b> Desc". Tailor to JD keywords.`;
             } else {
                  // Invent
                  aiPrompts[pid] = `Invent 2 academic projects for '${jd.slice(0,50)}'. Format: "<b>Project Name:</b> Tech stack & description | <b>Project Name:</b> Tech stack & description".`;
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
        
        // --- F. CERTIFICATIONS ---
        else if (label === 'Certifications') {
            resumeBodyHtml += `<div class="resume-section-title">Certifications</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            
            aiPrompts[pid] = `Invent 2 relevant certifications for '${jd.slice(0,50)}'. Format: "Cert Name | Cert Name".`;
            aiFallbacks[pid] = getSmartFallback('certifications', jd).split('|').map(c => `<li>${c.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
        }

        // --- G. ACHIEVEMENTS ---
        else if (label === 'Achievements') {
            resumeBodyHtml += `<div class="resume-section-title">Achievements</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            
            aiPrompts[pid] = `Invent 2 academic/professional achievements for '${jd.slice(0,50)}'. Pipe-separated.`;
            aiFallbacks[pid] = getSmartFallback('achievements', jd).split('|').map(a => `<li>${a.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
        }

        // --- H. TRAITS / OTHERS ---
        else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `List 6 character traits for '${jd.slice(0,50)}'. Comma-separated.`;
            const fallbackStr = getSmartFallback('traits', jd);
            aiFallbacks[pid] = fallbackStr.split('|').map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
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
                        const lis = val.split('|').map(b => `<li>${b.trim()}</li>`).join('');
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
const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

// 1. INVENTED DEFAULTS (Fixes blank sections)
function inventedFallbackForSection(title, jd) {
  const t = String(title || "").trim().toLowerCase();
  
  if (t.includes("certification")) {
    return `<ul>
      <li>AWS Certified Developer – Associate (Invented)</li>
      <li>PCEP – Certified Entry-Level Python Programmer (Invented)</li>
      <li>Google IT Automation with Python</li>
    </ul>`;
  }
  if (t.includes("achievement")) {
    return `<ul>
      <li>Reduced processing time by 40% through code optimization.</li>
      <li> recognized as 'Best Fresher' for consistent delivery.</li>
    </ul>`;
  }
  if (t.includes("project")) {
    return `<ul>
      <li><strong>E-Commerce API:</strong> Built a RESTful API using Django and Redis.</li>
      <li><strong>Task Manager:</strong> Developed a React-based productivity tool with real-time updates.</li>
    </ul>`;
  }
  // Generic
  return `<ul>
    <li>Relevant skill or achievement aligned with the job description.</li>
    <li>Demonstrated capacity to learn and apply new technologies.</li>
  </ul>`;
}

// 2. EXISTING DATA FORMATTER
function sectionToBulletsHtml(sec) {
  if (!sec) return "";
  const items = Array.isArray(sec.items) ? sec.items : [];
  if (!items.length) return "";

  // If type is "entries" (Work Exp, Projects), flatten bullets
  if (sec.type === 'entries') {
      const allBullets = [];
      items.forEach(it => {
          if (it.bullets && Array.isArray(it.bullets)) allBullets.push(...it.bullets);
      });
      if (allBullets.length) return `<ul>${allBullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`;
      return "";
  } 
  
  // Simple list (Traits)
  return `<ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

// 3. CANONICAL NAMES (Fixes Duplicates)
function canonicalSectionName(name) {
  const s = String(name || "").trim().toLowerCase();
  if (s.includes("work") || s.includes("experience")) return "Work Experience"; 
  if (s.includes("technical") || s.includes("skill")) return "Skills";
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
    .generated-resume p { margin-bottom: 4px; font-size: 11px; }
    
    /* BOX/CHIP STYLE FOR SKILLS & TRAITS */
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
      temperature: 0.85, 
      maxOutputTokens: 3000,
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
    
    // AI Tracking
    const aiPrompts = {}; 
    const aiFallbacks = {}; 
    const aiTypes = {}; 
    
    let sectionCounter = 0;

    // --- DEDUPLICATE SCOPE ---
    const seen = new Set();
    const sectionsToRender = [];
    const rawScope = (scope && scope.length) ? scope : ['Summary', 'Skills', 'Work Experience', 'Education'];
    
    for (const s of rawScope) {
        const c = canonicalSectionName(s);
        if (!seen.has(c)) {
            seen.add(c);
            sectionsToRender.push({ original: s, canonical: c });
        }
    }

    // Sort order
    const priority = ['Summary', 'Skills', 'Work Experience', 'Projects', 'Education'];
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
            aiPrompts[pid] = `Write a professional 3-sentence summary for a '${jd.slice(0,100)}' role. User input: "${original}". Expand this professionally.`;
            aiFallbacks[pid] = original.length > 10 ? `<p>${escapeHtml(original)}</p>` : inventedFallbackForSection('Summary', jd);
            aiTypes[pid] = 'summary';
        }
        
        // --- B. SKILLS (BOXES/CHIPS) ---
        else if (label === 'Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            // Force expansion
            aiPrompts[pid] = `List 10-12 technical skills for '${jd.slice(0,100)}'. MUST include: ${userSkills.join(', ')}. ADD relevant missing skills. Return comma-separated list.`;
            
            // Fallback: Use chips style
            const fallbackChips = userSkills.length 
                ? userSkills.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join('') 
                : `<span class="skill-tag">Python</span><span class="skill-tag">SQL</span><span class="skill-tag">Git</span><span class="skill-tag">REST APIs</span>`;
            
            aiFallbacks[pid] = fallbackChips;
            aiTypes[pid] = 'chips'; // Type 'chips' means convert CSV to boxes
        }
        
        // --- C. CHARACTER TRAITS (BOXES/CHIPS) ---
        else if (label === 'Character Traits') {
            resumeBodyHtml += `<div class="resume-section-title">Character Traits</div>`;
            const pid = `sec_${sectionCounter++}`;
            // Find data if exists
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().includes('trait') || s.title.toLowerCase().includes('character'));
            const original = existingSec ? (existingSec.items || []).join(', ') : "";

            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = `List 6 professional character traits for a developer. User input: "${original}". Return comma-separated list (e.g. "Fast Learner, Team Player").`;
            
            // Fallback: Chips
            const fallbackItems = original.split(',').filter(x=>x).map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join('');
            aiFallbacks[pid] = fallbackItems || inventedFallbackForSection('traits', jd).replace(/li>/g, 'span class="skill-tag">').replace(/ul>/g, 'div>'); // Hacky convert to chips if invented
            aiTypes[pid] = 'chips';
        }

        // --- D. WORK EXPERIENCE ---
        else if (label === 'Work Experience') {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            if (experienceSections.length > 0) {
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                for (const sec of experienceSections) {
                    for (const item of (sec.items || [])) {
                        const pid = `sec_${sectionCounter++}`;
                        const originalBullets = (Array.isArray(item.bullets) && item.bullets.length) ? item.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('') : "";
                        
                        // Fix: Don't show "Work Experience" as the Company Name if that's the section title
                        const companyName = (sec.title.toLowerCase().includes('work') || sec.title.toLowerCase().includes('experience')) ? "" : sec.title;

                        resumeBodyHtml += `
                          <div class="resume-item">
                            <div class="resume-row">
                              <span class="resume-role">${escapeHtml(item.key)}</span>
                              <span class="resume-date">${escapeHtml(item.date || '')}</span>
                            </div>
                            ${companyName ? `<span class="resume-company">${escapeHtml(companyName)}</span>` : ''}
                            <ul id="${pid}">[${pid}]</ul>
                          </div>`;
                        
                        aiPrompts[pid] = `Rewrite these bullets for '${item.key}': "${item.bullets}". Focus on impact. Return pipe-separated strings.`;
                        aiFallbacks[pid] = originalBullets || `<li>${escapeHtml(item.key)}</li>`;
                        aiTypes[pid] = 'list';
                    }
                }
            } else {
                // INVENT
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                const pid = `sec_${sectionCounter++}`;
                resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
                aiPrompts[pid] = `User has no experience. Generate 2 generic 'Personal Project' bullets for '${jd.slice(0,50)}'. Return pipe-separated strings.`;
                aiFallbacks[pid] = "<ul><li><i>(No experience data)</i></li></ul>";
                aiTypes[pid] = 'block-list';
            }
        }

        // --- E. PROJECTS (Limit to 2) ---
        else if (label === 'Projects') {
             resumeBodyHtml += `<div class="resume-section-title">Projects</div>`;
             // Check if user has projects
             const projSec = (profile.customSections || []).find(s => s.title.toLowerCase().includes('project'));
             
             if (projSec && projSec.items && projSec.items.length) {
                 // User has projects -> Limit to 2
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
                    aiPrompts[pid] = `Write 2 short bullets for project '${item.key}': "${item.bullets}". Return pipe-separated.`;
                    aiFallbacks[pid] = `<li>${escapeHtml(item.key)}</li>`;
                    aiTypes[pid] = 'list';
                 }
             } else {
                 // Invent 2 Projects for Fresher
                 const pid = `sec_${sectionCounter++}`;
                 resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
                 aiPrompts[pid] = `Invent 2 relevant academic projects for a fresher applying to '${jd.slice(0,50)}'. Format: "<b>Title:</b> Desc | <b>Title:</b> Desc"`;
                 aiFallbacks[pid] = inventedFallbackForSection('project', jd);
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
        
        // --- G. OTHER SECTIONS (Certifications, Achievements) ---
        else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().trim() === label.toLowerCase());
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            if (existingSec) {
                const fallbackHtml = sectionToBulletsHtml(existingSec);
                aiPrompts[pid] = `Refine this list for '${label}': ${JSON.stringify(existingSec)}. Return pipe-separated strings.`;
                aiFallbacks[pid] = fallbackHtml;
                aiTypes[pid] = 'block-list';
            } else {
                aiPrompts[pid] = `User checked '${label}' but has no data. INVENT 2 realistic examples for '${jd.slice(0,50)}'. Return pipe-separated strings.`;
                aiFallbacks[pid] = inventedFallbackForSection(label, jd);
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
        const prompt = `
        You are a Resume Content Generator.
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
                    if (type === 'chips') { // Skills & Traits -> Chips
                        const chips = val.split(',').map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join('');
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
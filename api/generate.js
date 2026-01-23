const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

// 1. INVENTED DEFAULTS (Content for empty sections)
function inventedFallbackForSection(title, jd) {
  const t = String(title || "").trim().toLowerCase();
  
  if (t.includes("certification")) {
    return `<ul>
      <li>AWS Certified Cloud Practitioner (Invented)</li>
      <li>Certified Entry-Level Python Programmer (PCEP)</li>
    </ul>`;
  }
  if (t.includes("achievement")) {
    return `<ul>
      <li>Awarded 'Best Student Project' for final year submission.</li>
      <li>Solved 500+ coding problems on LeetCode/HackerRank.</li>
    </ul>`;
  }
  if (t.includes("trait") || t.includes("character")) {
    // Return as pipe-separated for the chip parser
    return "Fast Learner | Team Player | Problem Solver | Adaptable | Proactive";
  }
  if (t.includes("project")) {
    return `<ul>
      <li><strong>Portfolio Website:</strong> Built a responsive site using React and deployed on Vercel.</li>
      <li><strong>Task App:</strong> Created a Python CLI tool for managing daily tasks.</li>
    </ul>`;
  }
  return `<ul><li>Relevant skill or achievement aligned with the job description.</li></ul>`;
}

// 2. CANONICAL NAMES (Merges "Work" and "Experience")
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
    
    const aiPrompts = {}; 
    const aiFallbacks = {}; 
    const aiTypes = {}; 
    let sectionCounter = 0;

    // --- SCOPE DEDUPLICATION ---
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

    const priority = ['Summary', 'Skills', 'Work Experience', 'Projects', 'Education', 'Character Traits'];
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
            aiPrompts[pid] = `Write a professional 3-sentence summary for a Fresher/Entry-Level '${jd.slice(0,50)}' role. Input: "${original}". Focus on potential, quick learning, and education.`;
            aiFallbacks[pid] = original.length > 10 ? `<p>${escapeHtml(original)}</p>` : `<p>Results-oriented Fresher aspiring to work as a ${jd.slice(0,30)}.</p>`;
            aiTypes[pid] = 'summary';
        }
        
        // --- B. SKILLS (CHIPS) ---
        else if (label === 'Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            // Force AI to invent at least 10 skills
            aiPrompts[pid] = `List 10-15 technical skills for '${jd.slice(0,50)}'. MUST INCLUDE: ${userSkills.join(', ')}. Return simple comma-separated list.`;
            
            // Fallback: If AI fails, use Python + others
            const fallbackList = userSkills.length ? userSkills : ["Python", "SQL", "Git", "Problem Solving"];
            aiFallbacks[pid] = fallbackList.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join('');
            aiTypes[pid] = 'chips';
        }
        
        // --- C. CHARACTER TRAITS (CHIPS) ---
        else if (label === 'Character Traits') {
            resumeBodyHtml += `<div class="resume-section-title">Character Traits</div>`;
            const pid = `sec_${sectionCounter++}`;
            
            // Try to find existing
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().includes('trait') || s.title.toLowerCase().includes('character'));
            const original = existingSec ? (existingSec.items || []).join(', ') : "";

            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = `List 6 professional character traits (e.g. Hardworking, Enthusiastic). Input: "${original}". Return comma-separated list.`;
            
            // Fallback
            const fallbackStr = original || "Enthusiastic | Quick Learner | Responsible | Team Player";
            // Convert fallback pipe/comma to chips
            const cleanFallback = fallbackStr.split(/[,|]/).map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join('');
            
            aiFallbacks[pid] = cleanFallback;
            aiTypes[pid] = 'chips';
        }

        // --- D. WORK EXPERIENCE (Duplication Fixed) ---
        else if (label === 'Work Experience') {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            if (experienceSections.length > 0) {
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                for (const sec of experienceSections) {
                    for (const item of (sec.items || [])) {
                        const pid = `sec_${sectionCounter++}`;
                        const originalBullets = (Array.isArray(item.bullets) && item.bullets.length) ? item.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('') : "";
                        
                        // Strict check to hide Company Name if it is "Work Experience"
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
                        
                        aiPrompts[pid] = `Rewrite these bullets: "${item.bullets}". Make them impactful. Return pipe-separated string.`;
                        aiFallbacks[pid] = originalBullets || `<li>${escapeHtml(item.key)}</li>`;
                        aiTypes[pid] = 'list';
                    }
                }
            } else {
                // INVENT
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                const pid = `sec_${sectionCounter++}`;
                resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
                aiPrompts[pid] = `Generate 2 generic 'Personal Project' bullets for '${jd.slice(0,50)}' (Fresher). Pipe-separated.`;
                aiFallbacks[pid] = "<ul><li><i>(No experience data)</i></li></ul>";
                aiTypes[pid] = 'block-list';
            }
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
        
        // --- F. OTHER SECTIONS (Invented) ---
        else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().trim() === label.toLowerCase());
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            if (existingSec) {
                // If it's a list (like Traits), convert to chips? No, only specific sections get chips.
                const items = existingSec.items || [];
                const fallbackList = items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
                aiPrompts[pid] = `Refine this list: ${JSON.stringify(items)}. Return pipe-separated.`;
                aiFallbacks[pid] = `<ul>${fallbackList}</ul>`;
                aiTypes[pid] = 'block-list';
            } else {
                aiPrompts[pid] = `User checked '${label}' but has no data. INVENT 2 examples for '${jd.slice(0,50)}'. Return pipe-separated.`;
                aiFallbacks[pid] = inventedFallbackForSection(label, jd);
                aiTypes[pid] = 'block-list';
            }
        }
    }

    // --- STEP 3: CALL AI ---
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
                    if (type === 'chips') { // Skills & Traits
                        const chips = val.split(/[,|]/).map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join('');
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
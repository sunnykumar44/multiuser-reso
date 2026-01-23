const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

// 1. INVENTED DEFAULTS (Fixes "AI could not generate this section")
function inventedFallbackForSection(title, jd) {
  const t = String(title || "").trim().toLowerCase();
  
  if (t.includes("certification")) {
    return `<ul>
      <li>AWS Certified Developer – Associate (Invented Example)</li>
      <li>PCEP – Certified Entry-Level Python Programmer</li>
      <li>Google IT Automation with Python</li>
    </ul>`;
  }
  if (t.includes("achievement")) {
    return `<ul>
      <li>Reduced API latency by 30% through caching optimizations.</li>
      <li>Awarded 'Employee of the Month' for delivering critical module ahead of schedule.</li>
    </ul>`;
  }
  if (t.includes("character") || t.includes("trait")) {
    return `<ul><li>Ownership Mindset</li><li>Fast Learner</li><li>Team Player</li><li>Problem Solver</li></ul>`;
  }
  if (t.includes("summary")) {
    return `<p>Results-oriented Developer with experience in building scalable web applications. Skilled in backend optimization and cloud deployment. Committed to delivering high-quality code and driving business success.</p>`;
  }
  // Generic
  return `<ul>
    <li>Demonstrated ability to deliver results in a fast-paced environment.</li>
    <li>Proactive in identifying and resolving technical bottlenecks.</li>
  </ul>`;
}

// 2. EXISTING DATA FORMATTER (Fixes Raw JSON dumps)
function sectionToBulletsHtml(sec) {
  if (!sec) return "";
  const items = Array.isArray(sec.items) ? sec.items : [];
  if (!items.length) return "";

  // If type is "entries" (like Work Exp), flatten bullets
  if (sec.type === 'entries') {
      const allBullets = [];
      items.forEach(it => {
          if (it.bullets && Array.isArray(it.bullets)) allBullets.push(...it.bullets);
      });
      if (allBullets.length) return `<ul>${allBullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`;
      return "";
  } 
  
  // Simple list (like Traits)
  return `<ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

// 3. CANONICAL NAMES (Fixes Duplicate Sections)
function canonicalSectionName(name) {
  const s = String(name || "").trim().toLowerCase();
  if (s.includes("work") || s.includes("experience")) return "Work Experience"; // Merge these
  if (s.includes("technical") || s.includes("skill")) return "Skills";
  if (s.includes("summary")) return "Summary";
  if (s.includes("education")) return "Education";
  return name.trim(); // Keep others as is (Certifications, etc)
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
      temperature: 0.85, // High creativity for invention
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
    
    // --- TRACKING FOR AI ---
    // pid -> instruction
    const aiPrompts = {}; 
    // pid -> HTML fallback
    const aiFallbacks = {}; 
    // pid -> type ('summary', 'skills', 'list', 'block-list', 'traits')
    const aiTypes = {}; 
    // pid -> canonical label (for invented fallbacks)
    const aiLabels = {};
     
     let sectionCounter = 0;

    // --- STEP 1: DEDUPLICATE SCOPE ---
    const seen = new Set();
    const sectionsToRender = [];
    
    // Prefer user scope, else default
    const rawScope = (scope && scope.length) ? scope : ['Summary', 'Skills', 'Work Experience', 'Education'];
    
    // Map to canonical names and dedup
    for (const s of rawScope) {
        const c = canonicalSectionName(s);
        if (!seen.has(c)) {
            seen.add(c);
            sectionsToRender.push({ original: s, canonical: c });
        }
    }

    // Sort: Summary -> Skills -> Experience -> Education -> Others
    const priority = ['Summary', 'Skills', 'Work Experience', 'Education'];
    sectionsToRender.sort((a, b) => {
        const ia = priority.indexOf(a.canonical);
        const ib = priority.indexOf(b.canonical);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return 0;
    });

    // --- STEP 2: BUILD SECTIONS ---
    for (const secObj of sectionsToRender) {
        const label = secObj.canonical; // Display Name
        
        // --- A. SUMMARY ---
        if (label === 'Summary') {
            resumeBodyHtml += `<div class="resume-section-title">Summary</div>`;
            const pid = `sec_${sectionCounter++}`;
            const original = profile.summary || "";
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `Write a professional 3-sentence summary tailored to this job. JD: "${jd.slice(0,300)}...". User input: "${original}". DO NOT use the word "${original}" directly. Expand it professionally.`;
            aiFallbacks[pid] = original.length > 10 ? `<p>${escapeHtml(original)}</p>` : inventedFallbackForSection('Summary', jd);
            aiTypes[pid] = 'summary';
            aiLabels[pid] = 'Summary';
         }
        
        // --- B. SKILLS ---
        else if (label === 'Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `List 8-12 technical skills relevant to '${jd.slice(0,50)}'. Include user skills: ${userSkills.join(', ')}. Return comma-separated list.`;
            
            // Fallback: Original chips OR Invented chips
            const fallbackChips = userSkills.length 
                ? userSkills.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join('') 
                : `<span class="skill-tag">Python</span><span class="skill-tag">SQL</span><span class="skill-tag">Git</span>`;
            
            aiFallbacks[pid] = fallbackChips;
            aiTypes[pid] = 'skills';
            aiLabels[pid] = 'Skills';
         }
        
        // --- C. EXPERIENCE ---
        else if (label === 'Work Experience') {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            if (experienceSections.length > 0) {
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                for (const sec of experienceSections) {
                    for (const item of (sec.items || [])) {
                        const pid = `sec_${sectionCounter++}`;
                        const originalBullets = (Array.isArray(item.bullets) && item.bullets.length) ? item.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('') : "";
                        
                        resumeBodyHtml += `
                          <div class="resume-item">
                            <div class="resume-row">
                              <span class="resume-role">${escapeHtml(item.key)}</span>
                              <span class="resume-date">${escapeHtml(item.date || '')}</span>
                            </div>
                            <span class="resume-company">${escapeHtml(sec.title)}</span>
                            <ul id="${pid}">[${pid}]</ul>
                          </div>`;
                        
                        aiPrompts[pid] = `Rewrite these bullet points for '${item.key}' to match the JD: "${item.bullets}". Focus on metrics. Return pipe-separated strings (Item 1 | Item 2).`;
                        aiFallbacks[pid] = originalBullets || `<li>${escapeHtml(item.key)}</li>`;
                        aiTypes[pid] = 'list'; // Insert LI tags into UL
                        aiLabels[pid] = sec.title || 'Work Experience';
                     }
                }
            } else {
                // INVENT EXPERIENCE
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                const pid = `sec_${sectionCounter++}`;
                resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
                
                aiPrompts[pid] = `User has no experience. Generate 2 generic 'Personal Project' bullets for a '${jd.slice(0,50)}' role. Return pipe-separated strings.`;
                aiFallbacks[pid] = "<ul><li><i>(No experience data)</i></li></ul>";
                aiTypes[pid] = 'block-list'; // Wrap LI in UL
                aiLabels[pid] = 'Work Experience';
             }
        }
        
        // --- D. EDUCATION ---
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
        
        // --- E. CUSTOM SECTIONS (Certifications, Achievements, Traits) ---
        else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            
            // Check existing
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().trim() === secObj.original.toLowerCase().trim());
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            if (existingSec) {
                // IMPROVE EXISTING
                const fallbackHtml = sectionToBulletsHtml(existingSec);
                aiPrompts[pid] = `Refine this list for '${label}': ${JSON.stringify(existingSec)}. Return pipe-separated strings.`;
                aiFallbacks[pid] = fallbackHtml;
                aiTypes[pid] = 'block-list';
                // If this is Character Traits, render as tags
                if ((label||'').toLowerCase().includes('character') || (label||'').toLowerCase().includes('trait')) {
                    aiTypes[pid] = 'traits';
                } else {
                    aiTypes[pid] = 'block-list';
                }
                aiLabels[pid] = label;
             } else {
                // INVENT DATA (Fix for empty sections)
                aiPrompts[pid] = `User checked '${label}' but has no data. INVENT 2 realistic examples for a '${jd.slice(0,50)}' resume. Return pipe-separated strings.`;
                aiFallbacks[pid] = inventedFallbackForSection(label, jd);
                aiTypes[pid] = 'block-list';
                aiLabels[pid] = label;
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
        TASK: Respond with a valid JSON object. Keys: ${Object.keys(aiPrompts).join(', ')}.
        
        INSTRUCTIONS:
        ${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
        
        FORMATTING RULES:
        - Skills: "Skill1, Skill2, Skill3"
        - Lists/Bullets: "Item 1 | Item 2 | Item 3" (Use pipes to separate)
        - Summaries: Plain text paragraph.
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
                const label = aiLabels[pid] || '';
                
                if (val && typeof val === 'string' && val.length > 2) {
                    if (type === 'skills') {
                        // normalize various separators (comma, pipe, newline)
                        const parts = val.split(/[,|\n;]+/).map(s=>s.trim()).filter(Boolean);
                        const chips = parts.length ? parts.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('') : aiFallbacks[pid];
                         htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                     } 
                     else if (type === 'list') { // Insert LI only (for inside UL)
                         const lis = val.split('|').map(b => `<li>${escapeHtml(b.trim())}</li>`).join('');
                         htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                     }
                     else if (type === 'block-list') { // Wrap LI in UL
                         const lis = val.split('|').map(b => `<li>${escapeHtml(b.trim())}</li>`).join('');
                         htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<ul>${lis}</ul>`);
                     }
                     else if (type === 'traits') {
                        // render as inline tags for concise traits
                        const parts = val.split(/[,|\n;]+/).map(s=>s.trim()).filter(Boolean);
                        const chips = parts.length ? parts.map(s=>`<span class="skill-tag">${escapeHtml(s)}</span>`).join('') : aiFallbacks[pid];
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                     }
                     else { // Summary
                         htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<p>${escapeHtml(val)}</p>`);
                     }
                 } else {
                     htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
                 }
             });

        } catch (e) {
            console.error("AI Error", e);
            Object.keys(aiPrompts).forEach(pid => {
                htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
            });
         }
    } else {
         Object.keys(aiPrompts).forEach(pid => {
             htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
         });
    }
    // FINAL: Ensure Projects limited to two if present: search for sections titled 'Projects' or 'Project' and trim lists
    htmlSkeleton = htmlSkeleton.replace(/(<div class="resume-section-title">\s*Projects\s*<\/div>[\s\S]*?<ul>)([\s\S]*?)<\/ul>/i, (m, head, listHtml) => {
      const items = listHtml.split(/<li>/i).slice(1).map(s => '<li>' + s.split('</li>')[0] + '</li>');
      const kept = items.slice(0,2).join('');
      return head + kept + '</ul>';
    });

    // FINAL: Fill any remaining empty placeholders with invented content
    htmlSkeleton = htmlSkeleton.replace(/\[sec_\d+\]/g, (m) => {
      // try to infer label from aiLabels map by pid
      const pid = m.replace(/\[|\]/g,'');
      const label = (typeof aiLabels === 'object' && aiLabels && aiLabels[pid]) ? aiLabels[pid] : 'Details';
      return inventedFallbackForSection(label, jd);
    });
 
     return res.status(200).json({ ok: true, generated: { html: htmlSkeleton } });

   } catch (err) {
     console.error(err);
     return res.status(500).json({ error: err.message });
   }
 };
const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    
    /* Skills as Chips */
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
      temperature: 0.8, // High creativity to INVENT data
      maxOutputTokens: 3000
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
    
    // AI Instructions
    const aiPrompts = {}; 
    const aiFallbacks = {};
    let sectionCounter = 0;

    // --- FIX 1: DEDUPLICATE SECTIONS ---
    // If "Experience" and "Work Experience" are both ticked, keep only one.
    let uniqueScope = [...new Set((scope || []).map(s => s.trim()))];
    const hasExp = uniqueScope.some(s => s.toLowerCase().includes('experience') || s.toLowerCase().includes('work'));
    if (hasExp) {
        // Remove all variations and add back just one standard "Work Experience"
        uniqueScope = uniqueScope.filter(s => !s.toLowerCase().includes('experience') && !s.toLowerCase().includes('work'));
        uniqueScope.push("Work Experience"); 
    }
    
    // Ensure standard order
    const priority = ['Summary', 'Skills', 'Work Experience', 'Education'];
    uniqueScope.sort((a, b) => {
        const ia = priority.indexOf(a);
        const ib = priority.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return 0;
    });

    // If empty, default set
    if (uniqueScope.length === 0) uniqueScope = ['Summary', 'Skills', 'Work Experience', 'Education'];

    for (const sectionName of uniqueScope) {
        const key = sectionName.trim();
        const lowerKey = key.toLowerCase();
        
        // --- A. SUMMARY ---
        if (lowerKey === 'summary') {
            resumeBodyHtml += `<div class="resume-section-title">Summary</div>`;
            const pid = `sec_${sectionCounter++}`;
            const original = profile.summary || "";
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `Write a professional 3-sentence summary for a '${jd.slice(0,50)}' role. Input: "${original}". Expand this professionally.`;
            aiFallbacks[pid] = `<p>${escapeHtml(original)}</p>`;
        }
        
        // --- B. SKILLS (CHIPS) ---
        else if (lowerKey.includes('skills')) {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `List 8-12 technical skills relevant to '${jd.slice(0,50)}'. Include: ${userSkills.join(', ')}. Return COMMA-SEPARATED list only.`;
            
            const fallbackHtml = userSkills.length 
                ? userSkills.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join('') 
                : "<span>(Add skills)</span>";
            aiFallbacks[pid] = fallbackHtml;
        }
        
        // --- C. EXPERIENCE ---
        else if (lowerKey.includes('experience') || lowerKey.includes('work')) {
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
                        
                        aiPrompts[pid] = `Write 3 strong, metric-driven bullet points for '${item.key}'. Input: "${item.bullets}". Output format: Bullet 1 | Bullet 2 | Bullet 3`;
                        aiFallbacks[pid] = originalBullets || `<li>${escapeHtml(item.key)}</li>`;
                    }
                }
            } else {
                // INVENT EXPERIENCE IF MISSING
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                const pid = `sec_${sectionCounter++}`;
                resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
                aiPrompts[pid] = `User has no experience. Generate 2 generic 'Personal Project' bullets for a '${jd.slice(0,50)}' role. Output: Bullet 1 | Bullet 2`;
                aiFallbacks[pid] = "<p><i>(No experience data)</i></p>";
            }
        }
        
        // --- D. EDUCATION ---
        else if (lowerKey.includes('education')) {
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
        
        // --- E. NEW/CUSTOM SECTIONS (Fixing JSON Dump) ---
        else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(key)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            
            // Check existing
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().trim() === lowerKey);
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            // --- FIX 2: Better Fallback for Existing Data (No JSON) ---
            let cleanFallback = "";
            if (existingSec) {
                if (existingSec.items && Array.isArray(existingSec.items)) {
                    // It's a list (like Character Traits)
                    cleanFallback = "<ul>" + existingSec.items.map(i => `<li>${escapeHtml(i)}</li>`).join('') + "</ul>";
                    aiPrompts[pid] = `Refine this list for section '${key}': "${existingSec.items.join(', ')}". Return items separated by '|'.`;
                } else {
                    cleanFallback = `<p>${escapeHtml(JSON.stringify(existingSec))}</p>`; // Last resort
                }
            } else {
                // --- FIX 3: Force Invention for Empty Sections ---
                cleanFallback = "<p><i>(AI could not generate this section)</i></p>";
                aiPrompts[pid] = `User checked '${key}' but has no data. INVENT 2 realistic examples for a '${jd.slice(0,50)}' resume. Return them separated by '|'.`;
            }
            aiFallbacks[pid] = cleanFallback;
        }
    }

    // 3. ASSEMBLE SKELETON
    let htmlSkeleton = `
    <div class="generated-resume">
      ${RESUME_CSS}
      <div class="resume-header">
        <div class="resume-name">${escapeHtml(name)}</div>
        <div class="resume-contact">${contactLinks}</div>
      </div>
      ${resumeBodyHtml}
    </div>`;

    // 4. CALL AI
    if (Object.keys(aiPrompts).length > 0 && jd) {
        const prompt = `
        You are a Resume Content Generator.
        JOB: ${jd.slice(0, 1000)}
        
        TASK: Respond with a valid JSON object.
        Keys: ${Object.keys(aiPrompts).join(', ')}
        Values: Generated text based on instructions.
        
        INSTRUCTIONS:
        ${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
        
        IMPORTANT FORMATTING:
        - Skills: "Skill1, Skill2, Skill3"
        - Lists/Bullets: "Item 1 | Item 2 | Item 3"
        - Paragraphs: Plain text.
        `;

        try {
            const aiJsonText = await callGeminiFlash(prompt);
            let aiData = {};
            try {
                const clean = aiJsonText.replace(/```json|```/g, '').trim();
                aiData = JSON.parse(clean);
            } catch (e) { console.error("JSON Error", e); }

            Object.keys(aiPrompts).forEach(pid => {
                let val = aiData[pid];
                
                if (val && typeof val === 'string' && val.length > 2) {
                    const instruction = aiPrompts[pid].toLowerCase();
                    
                    if (instruction.includes("comma-separated")) {
                        // Skills -> Chips
                        const skills = val.split(',').map(s => s.trim()).filter(s => s);
                        const chips = skills.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('');
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                    } 
                    else if (instruction.includes("|")) {
                        // Lists -> Bullets
                        const items = val.split('|').map(s => s.trim()).filter(s => s);
                        const lis = items.map(b => `<li>${escapeHtml(b)}</li>`).join('');
                        
                        // Wrap in UL if not already (Experience is already in UL)
                        if (htmlSkeleton.includes(`<ul id="${pid}">`)) {
                             htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                        } else {
                             htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<ul>${lis}</ul>`);
                        }
                    } 
                    else {
                        // Paragraph
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

    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton } });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
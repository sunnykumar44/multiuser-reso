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
  </style>
`;

async function callGeminiFlash(promptText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.6, // Increased creativity for filling gaps
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

    // 1. Static Header (Always accurate)
    const name = (profile.fullName || nickname || "User").toUpperCase();
    const contactLinks = [
      profile.email ? `<a href="mailto:${profile.email}">${profile.email}</a>` : null,
      profile.phone,
      profile.linkedin ? `<a href="${profile.linkedin}">LinkedIn</a>` : null,
      profile.github ? `<a href="${profile.github}">GitHub</a>` : null,
    ].filter(Boolean).join(" | ");

    let resumeBodyHtml = "";
    
    // We store instructions here: { "sec_1": "Write 3 bullets..." }
    const aiPrompts = {}; 
    const aiFallbacks = {};
    let sectionCounter = 0;

    // 2. Build Sections based on SCOPE (User Selection)
    // Default to standard sections if scope is missing
    const sectionsToRender = (scope && scope.length > 0) 
      ? scope 
      : ['Summary', 'Skills', 'Experience', 'Education'];

    for (const sectionName of sectionsToRender) {
        const key = sectionName.trim();
        const lowerKey = key.toLowerCase();
        
        // --- HEADER ---
        resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(key)}</div>`;
        
        // --- A. SUMMARY ---
        if (lowerKey === 'summary') {
            const pid = `sec_${sectionCounter++}`;
            const original = profile.summary || "";
            
            // Placeholder in HTML
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            // Instruction to AI
            if (original.length < 10) {
               aiPrompts[pid] = `Write a professional 3-sentence Summary for a '${jd.slice(0,50)}' role. The user only provided: "${original}". Expand this into a full professional summary.`;
            } else {
               aiPrompts[pid] = `Rewrite this summary for ATS optimization: "${original}". Keep it to 3 sentences.`;
            }
            aiFallbacks[pid] = `<p>${escapeHtml(original)}</p>`;
        }
        
        // --- B. SKILLS ---
        else if (lowerKey.includes('skills')) {
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `List 8-10 technical skills relevant to '${jd.slice(0,50)}'. User's current skills: ${JSON.stringify(userSkills)}. If user list is short, ADD relevant skills based on the Job Description. Return HTML: <ul><li>Skill</li>...</ul>`;
            
            aiFallbacks[pid] = userSkills.length ? `<ul>${userSkills.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : "";
        }
        
        // --- C. EXPERIENCE ---
        else if (lowerKey.includes('experience') || lowerKey.includes('work')) {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            if (experienceSections.length > 0) {
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
                        
                        aiPrompts[pid] = `Write 3 strong, metric-driven bullet points for the role '${item.key}'. User provided: "${item.bullets}". REWRITE these to be professional and impactful for a '${jd.slice(0,50)}' job. Return valid HTML <li>...</li> tags only.`;
                        
                        aiFallbacks[pid] = originalBullets || `<li>${escapeHtml(item.key)}</li>`;
                    }
                }
            } else {
                // User asked for Experience but has none? Invent a placeholder project.
                const pid = `sec_${sectionCounter++}`;
                resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
                aiPrompts[pid] = `User has no experience listed. Generate 2 generic but realistic bullet points for a 'Personal Project' relevant to '${jd.slice(0,50)}'. Format: HTML <ul><li>...</li></ul>`;
                aiFallbacks[pid] = "<p><i>(No experience data found)</i></p>";
            }
        }
        
        // --- D. EDUCATION (Static) ---
        else if (lowerKey.includes('education')) {
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
        
        // --- E. NEW SECTIONS (Certifications, Achievements, etc.) ---
        else {
            const pid = `sec_${sectionCounter++}`;
            
            // Check if profile has data
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().trim() === lowerKey);
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            if (existingSec) {
                // Improve existing data
                aiPrompts[pid] = `Refine this content for section '${key}': ${JSON.stringify(existingSec)}. Format as HTML list.`;
                aiFallbacks[pid] = JSON.stringify(existingSec);
            } else {
                // INVENT DATA (This solves your "New Section" issue)
                aiPrompts[pid] = `User selected '${key}' but provided no data. Generate 2 realistic, professional examples of ${key} for a '${jd.slice(0,50)}' candidate. Return HTML <ul><li>...</li></ul>.`;
                aiFallbacks[pid] = "<p><i>(AI could not generate this section)</i></p>";
            }
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
        JOB DESCRIPTION: ${jd.slice(0, 1000)}
        
        TASK: You are a Resume Builder. Return a JSON object where keys are exactly: ${Object.keys(aiPrompts).join(', ')}.
        Values must be the HTML content requested.
        
        INSTRUCTIONS:
        ${Object.entries(aiPrompts).map(([k, v]) => `${k}: ${v}`).join('\n')}
        `;

        try {
            const aiJsonText = await callGeminiFlash(prompt);
            let aiData = {};
            try {
                aiData = JSON.parse(aiJsonText.replace(/```json|```/g, '').trim());
            } catch (e) { console.error("JSON Error", e); }

            Object.keys(aiPrompts).forEach(pid => {
                const val = aiData[pid];
                // Replace placeholder if valid content returned
                if (val && typeof val === 'string' && val.length > 5) {
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, val);
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
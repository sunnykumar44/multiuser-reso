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
  </style>
`;

async function callGeminiFlash(promptText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.5,
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

    // 1. Static Header
    const name = (profile.fullName || nickname || "User").toUpperCase();
    const contactLinks = [
      profile.email ? `<a href="mailto:${profile.email}">${profile.email}</a>` : null,
      profile.phone,
      profile.linkedin ? `<a href="${profile.linkedin}">LinkedIn</a>` : null,
      profile.github ? `<a href="${profile.github}">GitHub</a>` : null,
    ].filter(Boolean).join(" | ");

    let resumeBodyHtml = "";
    
    // We will collect instructions for AI here
    // key: "section_id", value: "Instructions"
    const aiPrompts = {}; 
    const aiFallbacks = {};

    // 2. Iterate through SCOPE to build the resume structure
    // This ensures that if "Certifications" is ticked, it APPEARS.
    // Default order if scope is empty:
    const sectionsToRender = (scope && scope.length > 0) 
      ? scope 
      : ['Summary', 'Skills', 'Experience', 'Education'];

    let sectionCounter = 0;

    for (const sectionName of sectionsToRender) {
        const key = sectionName.trim();
        const lowerKey = key.toLowerCase();
        
        // --- HEADER ---
        resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(key)}</div>`;
        
        // --- CONTENT LOGIC ---
        
        // A. SUMMARY
        if (lowerKey === 'summary') {
            const pid = `sec_${sectionCounter++}`;
            const original = profile.summary ? `<p>${escapeHtml(profile.summary)}</p>` : "";
            
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = "Write a 3-sentence professional summary tailored to the JD.";
            aiFallbacks[pid] = original || "<p><i>(AI failed to generate summary)</i></p>";
        }
        
        // B. SKILLS
        else if (lowerKey.includes('skills')) {
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            const original = userSkills.length ? `<ul>${userSkills.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : "";

            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = "Write a list of technical skills from profile matching JD. Return HTML <ul><li>Skill</li></ul>.";
            aiFallbacks[pid] = original || "<ul><li><i>(Add skills)</i></li></ul>";
        }
        
        // C. EXPERIENCE / WORK
        else if (lowerKey.includes('experience') || lowerKey.includes('work')) {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            if (experienceSections.length > 0) {
                for (const sec of experienceSections) {
                    for (const item of (sec.items || [])) {
                        const pid = `sec_${sectionCounter++}`;
                        const originalBullets = (Array.isArray(item.bullets) && item.bullets.length) ? item.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('') : "";
                        
                        // Render structure immediately, put placeholder in the UL
                        resumeBodyHtml += `
                          <div class="resume-item">
                            <div class="resume-row">
                              <span class="resume-role">${escapeHtml(item.key)}</span>
                              <span class="resume-date">${escapeHtml(item.date || '')}</span>
                            </div>
                            <span class="resume-company">${escapeHtml(sec.title)}</span>
                            <ul id="${pid}">[${pid}]</ul>
                          </div>`;
                        
                        aiPrompts[pid] = `Write 3 strong bullet points for role '${item.key}'. Metrics & JD keywords. Return HTML <li>...</li> tags.`;
                        aiFallbacks[pid] = originalBullets || `<li>${escapeHtml(item.key)} - (Add details)</li>`;
                    }
                }
            } else {
                // User asked for Experience but has none in profile?
                const pid = `sec_${sectionCounter++}`;
                resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
                aiPrompts[pid] = "User has no experience listed. Suggest 2 generic relevant project bullets based on JD.";
                aiFallbacks[pid] = "<p><i>(No experience data found)</i></p>";
            }
        }
        
        // D. EDUCATION (Usually Static)
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
        
        // E. GENERIC / NEW SECTIONS (Certifications, Achievements)
        else {
            const pid = `sec_${sectionCounter++}`;
            
            // Check if profile has data for this
            const existingSec = (profile.customSections || []).find(s => s.title.toLowerCase().trim() === lowerKey);
            let context = "User has no data. Invent realistic placeholders based on JD.";
            let fallback = "<p><i>(New section - Add details)</i></p>";

            if (existingSec) {
                context = `Refine this data: ${JSON.stringify(existingSec)}.`;
                fallback = JSON.stringify(existingSec.items || []);
            }

            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = `Write content for section '${key}'. ${context} Format as HTML list or paragraph.`;
            aiFallbacks[pid] = fallback;
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
        JOB: ${jd.slice(0, 1000)}
        PROFILE: ${JSON.stringify(profile).slice(0, 2000)}
        
        TASK: Return JSON object. Keys: ${Object.keys(aiPrompts).join(', ')}.
        Values: HTML content per instruction.
        
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
                // Replace the [sec_0] placeholder
                if (val && val.length > 5) {
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
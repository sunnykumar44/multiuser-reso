const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

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
      temperature: 0.45,
      maxOutputTokens: 2500,
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
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const { profile, jd, nickname, scope = [] } = body;

    // Helper: is this section requested by the user?
    const isScopeSelected = (key) => scope.some(s => s.toLowerCase().trim() === key.toLowerCase().trim());

    // 1. Static Header
    const name = (profile.fullName || nickname || "User").toUpperCase();
    const contactLinks = [
      profile.email ? `<a href="mailto:${profile.email}">${profile.email}</a>` : null,
      profile.phone,
      profile.linkedin ? `<a href="${profile.linkedin}">LinkedIn</a>` : null,
      profile.github ? `<a href="${profile.github}">GitHub</a>` : null,
    ].filter(Boolean).join(" | ");

    let resumeBodyHtml = "";
    const placeholders = {};
    const fallbackContent = {};

    // --- SECTION 1: SUMMARY ---
    if (profile.summary || isScopeSelected('Summary')) {
        resumeBodyHtml += `<div class="resume-section-title">Summary</div>`;
        const originalSummary = profile.summary ? `<p>${escapeHtml(profile.summary)}</p>` : "";
        
        if (isScopeSelected('Summary')) {
            const ph = "[AI_SUMMARY]";
            resumeBodyHtml += `<div class="resume-item">${ph}</div>`;
            placeholders[ph] = "Write a 3-sentence professional summary tailored to the JD.";
            fallbackContent[ph] = originalSummary || "<p><i>(AI failed to generate summary)</i></p>";
        } else {
            resumeBodyHtml += `<div class="resume-item">${originalSummary}</div>`;
        }
    }

    // --- SECTION 2: SKILLS ---
    const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
    if (userSkills.length > 0 || isScopeSelected('Skills')) {
        resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
        const originalSkills = userSkills.length ? `<ul>${userSkills.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : "";
        
        if (isScopeSelected('Skills')) {
            const ph = "[AI_SKILLS]";
            resumeBodyHtml += `<div class="resume-item">${ph}</div>`;
            placeholders[ph] = "Write a list of technical skills from the profile that match the JD. Return HTML: <ul><li>Skill</li></ul>.";
            fallbackContent[ph] = originalSkills || "<ul><li><i>(Add skills here)</i></li></ul>";
        } else {
            resumeBodyHtml += `<div class="resume-item">${originalSkills}</div>`;
        }
    }

    // --- SECTION 3: EXPERIENCE ---
    const experienceSections = (profile.customSections || [])
      .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));

    if (experienceSections.length > 0) {
        resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
        for (const sec of experienceSections) {
            for (const item of (sec.items || [])) {
                const roleKey = slugify(item.key);
                const originalBullets = (Array.isArray(item.bullets) && item.bullets.length) ? item.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('') : "";
                
                let content = "";
                // If ticked in Scope, ask AI. Else, use original.
                if (isScopeSelected('Experience') || isScopeSelected('Work Experience')) {
                    const ph = `[AI_BULLETS_${roleKey}]`;
                    content = ph;
                    placeholders[ph] = `Write 3 strong, metric-driven bullet points for the role '${item.key}' at company '${sec.title}'. Tailor to JD. Return HTML <li>...</li> tags only.`;
                    // FALLBACK: Use original bullets if AI fails
                    fallbackContent[ph] = originalBullets || `<li>${escapeHtml(item.key)} - (Add details)</li>`;
                } else {
                    content = originalBullets || `<li>${escapeHtml(item.key)}</li>`;
                }

                resumeBodyHtml += `
                  <div class="resume-item">
                    <div class="resume-row">
                      <span class="resume-role">${escapeHtml(item.key)}</span>
                      <span class="resume-date">${escapeHtml(item.date || '')}</span>
                    </div>
                    <span class="resume-company">${escapeHtml(sec.title)}</span>
                    <ul>${content}</ul>
                  </div>`;
            }
        }
    }

    // --- SECTION 4: EDUCATION ---
    // Handle both profile.education (array) AND profile.college (string)
    const eduList = (profile.education && profile.education.length) 
        ? profile.education 
        : (profile.college ? [profile.college] : []);

    if (eduList.length > 0 || isScopeSelected('Education')) {
        resumeBodyHtml += `<div class="resume-section-title">Education</div>`;
        resumeBodyHtml += `<div class="resume-item">`;
        if (eduList.length > 0) {
             resumeBodyHtml += eduList.map(e => `<div>${escapeHtml(e)}</div>`).join('');
        } else if (isScopeSelected('Education')) {
             // User checked Education but has no data?
             resumeBodyHtml += `<div><i>(Add Education Details)</i></div>`;
        }
        resumeBodyHtml += `</div>`;
    }

    // --- SECTION 5: CUSTOM / OTHER SCOPE ITEMS (Achievements, Certifications) ---
    const standardKeys = ['summary', 'skills', 'technical skills', 'experience', 'work experience', 'education'];
    // Filter out standard keys to find "extra" sections user ticked
    const extraScope = scope.filter(s => !standardKeys.includes(s.toLowerCase().trim()));

    for (const scopeItem of extraScope) {
        // Check if this exists in profile
        const profileSec = (profile.customSections || []).find(s => s.title.toLowerCase().trim() === scopeItem.toLowerCase().trim());
        
        resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(scopeItem)}</div>`;
        const ph = `[AI_SECTION_${slugify(scopeItem)}]`;
        resumeBodyHtml += `<div class="resume-item">${ph}</div>`;
        
        // Context for AI
        let context = "";
        let originalContent = "";

        if (profileSec) {
             context = `User's existing data: ${JSON.stringify(profileSec)}. Improve this.`;
             if (profileSec.type === 'entries') {
                 originalContent = (profileSec.items||[]).map(i => `<div><strong>${escapeHtml(i.key)}</strong></div><ul>${(i.bullets||[]).map(b=>`<li>${escapeHtml(b)}</li>`).join('')}</ul>`).join('');
             } else {
                 originalContent = `<ul>${(profileSec.items||[]).map(i=>`<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
             }
        } else {
             context = "User has NO data for this section. Invent 2 realistic, relevant placeholders based on the Job Description.";
             originalContent = "<p><i>(New section added by AI scope - Edit to customize)</i></p>";
        }
        
        placeholders[ph] = `Write content for '${scopeItem}'. ${context} Format as HTML.`;
        fallbackContent[ph] = originalContent;
    }

    // 3. ASSEMBLE HTML SKELETON
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
    if (Object.keys(placeholders).length > 0 && jd) {
        const prompt = `
        JOB DESCRIPTION: ${jd.slice(0, 3000)}
        USER PROFILE: ${JSON.stringify(profile).slice(0, 4000)}

        TASK: Generate HTML content for the specific placeholders below.
        ${Object.entries(placeholders).map(([key, instr]) => `- "${key}": ${instr}`).join('\n')}
        
        OUTPUT: JSON object with keys matching above exactly.
        Example: { "[AI_SUMMARY]": "<p>Content...</p>" }
        `;

        try {
            const aiJsonText = await callGeminiFlash(prompt);
            let aiData = {};
            try {
                // Remove markdown formatting if present
                aiData = JSON.parse(aiJsonText.replace(/```json|```/g, '').trim());
            } catch (e) {
                console.error("JSON Parse Error", e);
            }
            
            // Apply replacements
            Object.keys(placeholders).forEach(ph => {
                const cleanKey = ph.replace(/[\[\]]/g, '');
                // Try exact match OR match without brackets
                const val = aiData[ph] || aiData[cleanKey];

                if (val && typeof val === 'string' && val.length > 5) {
                    htmlSkeleton = htmlSkeleton.split(ph).join(val);
                } else {
                    // FALLBACK: If AI returned nothing/garbage, use original/fallback text
                    htmlSkeleton = htmlSkeleton.split(ph).join(fallbackContent[ph] || "");
                }
            });

        } catch (e) {
            console.error("AI Generation Error", e);
            // Global failure: revert all placeholders to fallback
            Object.keys(placeholders).forEach(ph => {
                htmlSkeleton = htmlSkeleton.split(ph).join(fallbackContent[ph] || "");
            });
        }
    } else {
        // No AI needed, cleanup placeholders
        Object.keys(placeholders).forEach(ph => {
             htmlSkeleton = htmlSkeleton.split(ph).join(fallbackContent[ph] || "");
        });
    }

    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton } });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
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

// The "Sunny Kumar" CSS Template
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
      font-size: 13px;
      margin: 16px 0 8px;
      border-bottom: 1.5px solid #2b6cb0;
      color: #1a365d;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: bold;
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
      temperature: 0.4,
      maxOutputTokens: 2048,
      responseMimeType: "application/json" // Force JSON response
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

    // Helper to check if user checked a box
    const isScopeSelected = (key) => scope.some(s => s.toLowerCase().includes(key.toLowerCase()));

    // 1. Build Static HTML Parts (Name, Contact, Education)
    const name = (profile.fullName || nickname || "User").toUpperCase();
    const email = profile.email || "";
    const phone = profile.phone || "";
    const linkedin = profile.linkedin || "";
    const github = profile.github || "";
    
    const contactLinks = [
      email ? `<a href="mailto:${email}">${email}</a>` : null,
      phone,
      linkedin ? `<a href="${linkedin}">LinkedIn</a>` : null,
      github ? `<a href="${github}">GitHub</a>` : null,
    ].filter(Boolean).join(" | ");

    // 2. Logic: Do we ask AI or use existing data?
    const placeholders = {}; // Store what we need AI to generate

    // --- SUMMARY ---
    let summaryHtml = "";
    if (isScopeSelected('Summary')) {
        summaryHtml = "[AI_SUMMARY]";
        placeholders["[AI_SUMMARY]"] = "Write a 3-sentence professional summary tailored to the Job Description.";
    } else {
        summaryHtml = `<p>${escapeHtml(profile.summary || '')}</p>`;
    }

    // --- SKILLS ---
    let skillsHtml = "";
    if (isScopeSelected('Skills')) {
        skillsHtml = "[AI_SKILLS]";
        placeholders["[AI_SKILLS]"] = "Write a list of technical skills from the profile that match the Job Description. Format as: <ul><li>Skill 1</li><li>Skill 2</li></ul>";
    } else {
        const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
        if (userSkills.length) {
            skillsHtml = `<ul>${userSkills.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
        }
    }

    // --- EXPERIENCE ---
    // This is the tricky part. We keep the Titles static, but generate bullets.
    const experienceSection = (profile.customSections || [])
      .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')))
      .map(sec => {
        return (sec.items || []).map(item => {
            const roleKey = slugify(item.key); // e.g., 'data-analyst'
            const placeholderKey = `[AI_BULLETS_FOR_${roleKey}]`;
            
            let bulletContent = "";
            if (isScopeSelected('Experience') || isScopeSelected('Work')) {
                // User wants AI to fix this
                bulletContent = placeholderKey;
                placeholders[placeholderKey] = `Write 3 impactful bullet points for the role '${item.key}' at '${sec.title}'. Use metrics. Tailor to JD. Return valid HTML <li>...</li> tags.`;
            } else {
                // User wants their original text
                if (Array.isArray(item.bullets) && item.bullets.length) {
                    bulletContent = item.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('');
                }
            }

            return `
              <div class="resume-item">
                <div class="resume-row">
                  <span class="resume-role">${escapeHtml(item.key)}</span>
                  <span class="resume-date">${escapeHtml(item.date || '')}</span>
                </div>
                <span class="resume-company">${escapeHtml(sec.title)}</span>
                <ul>
                   ${bulletContent}
                </ul>
              </div>`;
        }).join('');
      }).join('');

    // --- BUILD THE SKELETON ---
    let htmlSkeleton = `
    <div class="generated-resume">
      ${RESUME_CSS}
      
      <div class="resume-header">
        <div class="resume-name">${escapeHtml(name)}</div>
        <div class="resume-contact">${contactLinks}</div>
      </div>

      <div class="resume-section-title">Summary</div>
      <div class="resume-item">${summaryHtml}</div>

      <div class="resume-section-title">Technical Skills</div>
      <div class="resume-item">${skillsHtml}</div>

      <div class="resume-section-title">Experience</div>
      ${experienceSection}
      
      <div class="resume-section-title">Education</div>
      <div class="resume-item">
         ${(profile.education || []).map(e => `<div>${escapeHtml(e)}</div>`).join('')}
      </div>
    </div>`;

    // 3. CALL AI (Only if we have placeholders)
    if (Object.keys(placeholders).length > 0 && jd) {
        const prompt = `
        You are an expert Resume Writer.
        
        JOB DESCRIPTION:
        ${jd.slice(0, 3000)}

        USER PROFILE DATA:
        ${JSON.stringify(profile).slice(0, 5000)}

        TASK:
        I need you to generate HTML content for the following specific placeholders.
        
        INSTRUCTIONS:
        ${Object.entries(placeholders).map(([key, instr]) => `- "${key}": ${instr}`).join('\n')}
        
        OUTPUT FORMAT:
        Return ONLY a JSON object. Keys must be exactly the placeholders listed above.
        Example: { "[AI_SUMMARY]": "<p>...</p>", "[AI_BULLETS_FOR_...]": "<li>Result A</li><li>Result B</li>" }
        `;

        try {
            const aiJsonText = await callGeminiFlash(prompt);
            // Parse AI response
            let aiData = {};
            try {
                aiData = JSON.parse(aiJsonText);
            } catch (e) {
                // Sometimes AI returns markdown like \`\`\`json ... \`\`\`
                const clean = aiJsonText.replace(/```json|```/g, '').trim();
                aiData = JSON.parse(clean);
            }
            
            // Replace placeholders in skeleton
            Object.keys(aiData).forEach(key => {
                // Use split/join for global replacement without regex issues
                htmlSkeleton = htmlSkeleton.split(key).join(aiData[key]);
            });

        } catch (e) {
            console.error("AI Generation Error", e);
            // If AI fails, we must remove the placeholders so the user doesn't see "[AI_...]"
            Object.keys(placeholders).forEach(key => {
                htmlSkeleton = htmlSkeleton.split(key).join("");
            });
        }
    } else {
        // If no AI needed (scope empty), just clean up any leftover placeholders
        // (Though logically there shouldn't be any)
    }

    // 4. Return Final HTML
    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton } });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
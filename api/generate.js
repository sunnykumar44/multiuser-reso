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
  
  // Use the modern Gemini 1.5 Flash endpoint
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 2048,
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
    const { profile, jd, nickname, mode, scope } = body;

    // 1. Build Static HTML Parts (Name, Contact, Education)
    // We do this in JS so it's 100% accurate and never hallucinated
    const name = (profile.fullName || nickname || "User").toUpperCase();
    const email = profile.email || "";
    const phone = profile.phone || "";
    const linkedin = profile.linkedin || "";
    const github = profile.github || ""; // Assuming you might have this field
    
    const contactLinks = [
      email ? `<a href="mailto:${email}">${email}</a>` : null,
      phone,
      linkedin ? `<a href="${linkedin}">LinkedIn</a>` : null,
      github ? `<a href="${github}">GitHub</a>` : null,
    ].filter(Boolean).join(" | ");

    // 2. Build the "Skeleton" HTML
    // We leave placeholders [AI_SUMMARY], [AI_EXPERIENCE], etc.
    let htmlSkeleton = `
    <div class="generated-resume">
      ${RESUME_CSS}
      
      <div class="resume-header">
        <div class="resume-name">${escapeHtml(name)}</div>
        <div class="resume-contact">${contactLinks}</div>
      </div>

      <div class="resume-section-title">Summary</div>
      <div class="resume-item">
        [AI_SUMMARY]
      </div>

      <div class="resume-section-title">Technical Skills</div>
      <div class="resume-item">
        [AI_SKILLS]
      </div>

      <div class="resume-section-title">Experience</div>
      ${(profile.customSections || []).filter(s => s.type === 'entries' && s.title.toLowerCase().includes('experience')).map(sec => 
        (sec.items || []).map(item => `
          <div class="resume-item">
            <div class="resume-row">
              <span class="resume-role">${escapeHtml(item.key)}</span>
              <span class="resume-date"></span>
            </div>
            <span class="resume-company">${escapeHtml(sec.title)}</span> <ul>
               [AI_BULLETS_FOR_${slugify(item.key)}]
            </ul>
          </div>
        `).join('')
      ).join('')}
      
      <div class="resume-section-title">Education</div>
      <div class="resume-item">
         ${(profile.education || []).map(e => `<div>${escapeHtml(e)}</div>`).join('')}
      </div>
      
    </div>`;

    // 3. Create the Prompt
    const prompt = `
    You are an expert Resume Writer. 
    JOB DESCRIPTION: ${jd.slice(0, 3000)}
    USER PROFILE: ${JSON.stringify(profile)}

    TASK:
    I have an HTML template with placeholders. You need to provide the content for these placeholders.
    
    1. [AI_SUMMARY]: Write a 3-sentence summary tailored to the JD.
    2. [AI_SKILLS]: Write a comma-separated list of hard skills from the profile that match the JD.
    3. [AI_BULLETS_FOR_...]: For each experience role, write 3 bullet points. Focus on metrics, impact, and keywords from the JD.

    OUTPUT FORMAT:
    Return a JSON object ONLY. No markdown.
    {
      "[AI_SUMMARY]": "<p>...</p>",
      "[AI_SKILLS]": "<p>...</p>",
      "[AI_BULLETS_FOR_role-name]": "<li>Action...</li><li>Result...</li>"
    }
    `;

    // 4. Call AI
    let generatedHtml = htmlSkeleton;
    if (jd) {
        try {
            const aiJsonText = await callGeminiFlash(prompt);
            // Clean up code blocks
            const cleanJson = aiJsonText.replace(/```json|```/g, '').trim();
            const aiData = JSON.parse(cleanJson);
            
            // Replace placeholders
            Object.keys(aiData).forEach(key => {
                // simple replace, handling potential regex issues by not using regex
                generatedHtml = generatedHtml.split(key).join(aiData[key]);
            });
            
            // Cleanup unused placeholders
            generatedHtml = generatedHtml.replace(/\[AI_[A-Z_]+\]/g, '');
        } catch (e) {
            console.error("AI Generation Error", e);
            // Fallback: If AI fails, return skeleton with basic data
            generatedHtml = generatedHtml.replace(/\[AI_SUMMARY\]/g, `<p>${escapeHtml(profile.summary || '')}</p>`);
        }
    }

    // 5. Return
    return res.status(200).json({ ok: true, generated: { html: generatedHtml } });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
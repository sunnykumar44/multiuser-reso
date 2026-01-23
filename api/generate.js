const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Heuristic helpers: used when AI fails or returns no content
function extractKeywords(text, limit = 6) {
  if (!text || typeof text !== 'string') return [];
  const stop = new Set(['the','and','to','a','an','of','in','for','with','on','as','is','are','be','by','at','from','that','this','will','have','has']);
  const toks = text.toLowerCase().replace(/[^a-z0-9\s\-_/\.]/g,' ').split(/\s+/).filter(Boolean);
  const counts = {};
  for (const t of toks) {
    if (t.length < 3) continue;
    if (stop.has(t)) continue;
    counts[t] = (counts[t]||0)+1;
  }
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,limit).map(x=>x[0]);
}

function makeHeuristicSummary(profile, jd) {
  const name = (profile && (profile.fullName || profile.nickname)) ? (profile.fullName || profile.nickname) : '';
  const skills = Array.isArray(profile.skills) ? profile.skills.slice(0,3) : [];
  const jdKeys = extractKeywords(jd, 3);
  const parts = [];
  if (name) parts.push(`${name} is a ${skills[0] ? skills[0] + ' professional' : 'skilled professional'}.`);
  if (skills.length) parts.push(`Experienced with ${skills.join(', ')}.`);
  if (jdKeys.length) parts.push(`Relevant experience includes ${jdKeys.join(', ')}.`);
  return `<p>${parts.join(' ')}</p>`;
}

function makeHeuristicSkills(profile, jd) {
  const skills = Array.isArray(profile.skills) && profile.skills.length ? profile.skills : extractKeywords(jd, 8);
  if (!skills || !skills.length) return '';
  return '<ul>' + skills.slice(0,8).map(s => `<li>${escapeHtml(String(s))}</li>`).join('') + '</ul>';
}

function makeHeuristicBulletsForRole(profile, roleKey, jd) {
  const sections = Array.isArray(profile.customSections) ? profile.customSections : [];
  let roleTitle = roleKey.replace(/[-_]/g,' ');
  for (const sec of sections) {
    if (!sec || !Array.isArray(sec.items)) continue;
    for (const it of sec.items) {
      if (slugify(it.key) === roleKey) { roleTitle = it.key; break; }
    }
  }
  const jdKeys = extractKeywords(jd, 3);
  const topSkill = (Array.isArray(profile.skills) && profile.skills[0]) ? profile.skills[0] : (jdKeys[0] || 'relevant technologies');
  const bullets = [];
  bullets.push(`<li>Implemented ${escapeHtml(roleTitle)} features using ${escapeHtml(topSkill)}, addressing core requirements.</li>`);
  bullets.push(`<li>Collaborated cross-functionally to deliver improvements related to ${escapeHtml(jdKeys[0] || 'system performance')}.</li>`);
  bullets.push(`<li>Improved process or metrics through testing, automation, and deployment efforts.</li>`);
  return bullets.join('');
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

    const isScopeSelected = (key) => scope.some(s => s.toLowerCase().includes(key.toLowerCase()));

    // 1. Static Header
    const name = (profile.fullName || nickname || "User").toUpperCase();
    const contactLinks = [
      profile.email ? `<a href="mailto:${profile.email}">${profile.email}</a>` : null,
      profile.phone,
      profile.linkedin ? `<a href="${profile.linkedin}">LinkedIn</a>` : null,
      profile.github ? `<a href="${profile.github}">GitHub</a>` : null,
    ].filter(Boolean).join(" | ");

    // 2. Logic: Prepare Placeholders & Fallbacks
    const placeholders = {}; 
    const fallbackContent = {}; // Stores original text to use if AI fails

    // --- SUMMARY ---
    let summaryHtml = "";
    const originalSummary = profile.summary ? `<p>${escapeHtml(profile.summary)}</p>` : "";
    
    if (isScopeSelected('Summary')) {
        summaryHtml = "[AI_SUMMARY]";
        placeholders["[AI_SUMMARY]"] = "Write a 3-sentence professional summary tailored to the JD.";
        fallbackContent["[AI_SUMMARY]"] = originalSummary;
    } else {
        summaryHtml = originalSummary;
    }

    // --- SKILLS ---
    let skillsHtml = "";
    const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
    const originalSkills = userSkills.length ? `<ul>${userSkills.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : "";
    
    if (isScopeSelected('Skills')) {
        skillsHtml = "[AI_SKILLS]";
        placeholders["[AI_SKILLS]"] = "Write a list of technical skills from the profile that match the JD. Format as HTML <ul><li>Skill</li>...</ul>";
        fallbackContent["[AI_SKILLS]"] = originalSkills;
    } else {
        skillsHtml = originalSkills;
    }

    // --- EXPERIENCE ---
    const experienceSection = (profile.customSections || [])
      .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')))
      .map(sec => {
        return (sec.items || []).map(item => {
            const roleKey = slugify(item.key);
            const placeholderKey = `[AI_BULLETS_FOR_${roleKey}]`;
            
            let originalBullets = "";
            if (Array.isArray(item.bullets) && item.bullets.length) {
                originalBullets = item.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('');
            }

            let bulletContent = "";
            if (isScopeSelected('Experience') || isScopeSelected('Work')) {
                bulletContent = placeholderKey;
                placeholders[placeholderKey] = `Write 3 impactful bullet points for the role '${item.key}' at '${sec.title}'. Use metrics. Tailor to JD. Return valid HTML <li>...</li> tags.`;
                fallbackContent[placeholderKey] = originalBullets;
            } else {
                bulletContent = originalBullets;
            }

            return `
              <div class="resume-item">
                <div class="resume-row">
                  <span class="resume-role">${escapeHtml(item.key)}</span>
                  <span class="resume-date">${escapeHtml(item.date || '')}</span>
                </div>
                <span class="resume-company">${escapeHtml(sec.title)}</span>
                <ul>${bulletContent}</ul>
              </div>`;
        }).join('');
      }).join('');

    // --- BUILD SKELETON ---
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

    // 3. CALL AI
    // track which placeholders were filled by AI vs fallback
    let placeholdersFilled = {};

    if (Object.keys(placeholders).length > 0 && jd) {
        const prompt = `
        JOB DESCRIPTION: ${jd.slice(0, 3000)}
        USER PROFILE: ${JSON.stringify(profile).slice(0, 5000)}

        TASK: Generate HTML content for these keys.
        ${Object.entries(placeholders).map(([key, instr]) => `- "${key}": ${instr}`).join('\n')}
        
        OUTPUT: JSON object with keys matching above exactly.
        Example: { "[AI_SUMMARY]": "<p>Content...</p>" }
        `;

        try {
            const aiJsonText = await callGeminiFlash(prompt);
            let aiData = {};
            try {
                // Remove Markdown if present
                const cleanJson = aiJsonText.replace(/```json|```/g, '').trim();
                aiData = JSON.parse(cleanJson);
            } catch (e) {
                console.error("JSON Parse Error", e);
            }
            
            // --- CRITICAL FIX: Loop through REQUESTED placeholders, not received keys ---
            Object.keys(placeholders).forEach(ph => {
                // Attempt 1: Exact Match
                let val = aiData[ph];

                // Attempt 2: Match without brackets (common AI mistake)
                if (!val) {
                    const cleanKey = ph.replace(/[\[\]]/g, ''); // AI_SUMMARY
                    val = aiData[cleanKey];
                }

                if (val) {
                    // Success: Use AI content
                    htmlSkeleton = htmlSkeleton.split(ph).join(val);
                    placeholdersFilled[ph] = 'ai';
                } else {
                    // Fail: Revert to Original content (Fallback) or heuristics
                    let replacement = fallbackContent[ph] || "";
                    if (!replacement || replacement.trim() === "") {
                        // generate heuristic content based on placeholder type
                        if (ph === '[AI_SUMMARY]') replacement = makeHeuristicSummary(profile, jd);
                        else if (ph === '[AI_SKILLS]') replacement = makeHeuristicSkills(profile, jd);
                        else if (/^\[AI_BULLETS_FOR_/.test(ph)) {
                            const roleKey = ph.replace(/\[AI_BULLETS_FOR_(.+)\]/, '$1');
                            replacement = makeHeuristicBulletsForRole(profile, roleKey, jd);
                        }
                    }
                    htmlSkeleton = htmlSkeleton.split(ph).join(replacement);
                    placeholdersFilled[ph] = 'fallback';
                }
            });

            // Final cleanup: remove any leftover unresolved placeholders
            htmlSkeleton = htmlSkeleton.replace(/\[AI_[^\]]+\]/g, '');

        } catch (e) {
            console.error("AI Generation Error", e);
            // GLOBAL FAIL: Revert EVERYTHING to original content
            Object.keys(placeholders).forEach(ph => {
                htmlSkeleton = htmlSkeleton.split(ph).join(fallbackContent[ph] || "");
            });
            // Cleanup
            htmlSkeleton = htmlSkeleton.replace(/\[AI_[^\]]+\]/g, '');
            placeholdersFilled = Object.keys(placeholders).reduce((acc,k)=>{acc[k]='error';return acc;},{});
        }
    } else {
        // No AI needed, cleanup placeholders (if any existed for some reason)
        Object.keys(placeholders).forEach(ph => {
             htmlSkeleton = htmlSkeleton.split(ph).join(fallbackContent[ph] || "");
        });
        htmlSkeleton = htmlSkeleton.replace(/\[AI_[^\]]+\]/g, '');
        placeholdersFilled = Object.keys(placeholders).reduce((acc,k)=>{acc[k]='none';return acc;},{});
    }

    // Return debug info about placeholders and scope so client can verify
    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton }, debug: { scope: scope || [], placeholders: placeholders, placeholdersFilled: placeholdersFilled } });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
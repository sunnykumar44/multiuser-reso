const { saveHistory } = require("./firebase");

// --- HELPER 1: DYNAMIC KEYWORD EXTRACTOR (The Safety Net) ---
// If AI fails, this extracts real words from YOUR JD string.
function extractKeywordsFromJD(jd) {
  if (!jd) return ["Communication", "Problem Solving", "Agile"];
  
  const stopWords = new Set([
    "and", "the", "for", "with", "ing", "to", "in", "a", "an", "of", "on", "at", "by", "is", "are", 
    "was", "were", "be", "been", "job", "role", "work", "experience", "skills", "candidate", "ability", 
    "knowledge", "looking", "seeking", "must", "have", "will", "can", "good", "strong", "years", "description"
  ]);

  // Clean and split text
  const words = jd.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  const uniqueWords = new Set();
  const meaningfulWords = [];

  words.forEach(w => {
    if (w.length > 3 && !stopWords.has(w) && !uniqueWords.has(w)) {
      uniqueWords.add(w);
      // Capitalize first letter
      meaningfulWords.push(w.charAt(0).toUpperCase() + w.slice(1));
    }
  });

  return meaningfulWords.slice(0, 12); // Return top 12 keywords
}

// --- HELPER 2: DYNAMIC FALLBACK GENERATOR (100% JD-DERIVED) ---
function getSmartFallback(section, jd) {
  const job = String(jd || "").toLowerCase();
  // Extract real keywords from the JD input
  const dynamicKeywords = extractKeywordsFromJD(jd);
  const mainKeyword = dynamicKeywords[0] || jd.trim().split(' ')[0] || "Technical";
  const secondKeyword = dynamicKeywords[1] || jd.trim().split(' ')[1] || "Skills";
  const thirdKeyword = dynamicKeywords[2] || "Development";

  // A. SKILLS - ALWAYS use JD keywords
  if (section === 'skills') {
     // Return top 12 keywords from JD directly
     return dynamicKeywords.slice(0, 12);
  }

  // B. CERTIFICATIONS - Use JD keywords
  if (section === 'certifications') {
    return `Certified ${mainKeyword} Professional | ${secondKeyword} Specialist Certification`;
  }

  // C. PROJECTS - Use JD keywords
  if (section === 'projects') {
     return `<b>${mainKeyword} ${thirdKeyword} System:</b> Implemented ${mainKeyword} features using ${secondKeyword} technologies. | <b>${secondKeyword} Optimization Tool:</b> Built ${thirdKeyword} solution for ${mainKeyword} processing.`;
  }

  // D. ACHIEVEMENTS - Use JD keywords
  if (section === 'achievements') {
      return `Improved ${mainKeyword} performance by 25% through ${secondKeyword} optimization. | Recognized for ${thirdKeyword} excellence in ${mainKeyword} implementation.`;
  }

  return "";
}

function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function canonicalSectionName(name) {
  const s = String(name || "").trim().toLowerCase();
  if (s.includes("work") || s.includes("experience")) return "Work Experience"; 
  if (s.includes("technical") || s.includes("skill")) return "Technical Skills";
  if (s.includes("summary")) return "Summary";
  if (s.includes("education")) return "Education";
  if (s.includes("project")) return "Projects";
  if (s.includes("trait") || s.includes("character")) return "Character Traits";
  if (s.includes("cert")) return "Certifications";
  if (s.includes("achieve")) return "Achievements";
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
    .generated-resume li { margin-bottom: 4px; font-size: 11px; }
    .generated-resume p { margin-bottom: 4px; font-size: 11px; text-align: justify; }
    
    .skill-tag {
      display: inline-block; padding: 3px 8px; margin: 0 4px 4px 0;
      border: 1px solid #cbd5e1; border-radius: 4px; background-color: #f8fafc;
      font-size: 10px; font-weight: 600; color: #334155;
    }
  </style>
`;

async function callGeminiFlash(promptText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.6, // Low temp for focused adherence to JD
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

    const seen = new Set();
    const sectionsToRender = [];
    const rawScope = (scope && scope.length) ? scope : ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Education', 'Certifications', 'Achievements', 'Character Traits'];
    
    for (const s of rawScope) {
        const c = canonicalSectionName(s);
        if (!seen.has(c)) {
            seen.add(c);
            sectionsToRender.push({ original: s, canonical: c });
        }
    }

    const priority = ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Education', 'Certifications', 'Achievements', 'Character Traits'];
    sectionsToRender.sort((a, b) => {
        const ia = priority.indexOf(a.canonical);
        const ib = priority.indexOf(b.canonical);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return 0;
    });

    for (const secObj of sectionsToRender) {
        const label = secObj.canonical;
        
        if (label === 'Summary') {
            resumeBodyHtml += `<div class="resume-section-title">Summary</div>`;
            const pid = `sec_${sectionCounter++}`;
            const original = profile.summary || "";
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `Write a professional 3-4 sentence summary for a FRESHER applying to this role: "${jd.slice(0,200)}". Use ONLY keywords from the JD. Make it compelling and relevant.`;
            // Fallback uses first JD keyword
            const kw = extractKeywordsFromJD(jd)[0] || jd.trim().split(' ')[0] || "Professional";
            aiFallbacks[pid] = `<p>Motivated ${kw} professional with strong academic foundation and hands-on project experience in ${extractKeywordsFromJD(jd).slice(1,3).join(', ')}. Eager to contribute to organizational success.</p>`;
            aiTypes[pid] = 'summary';
        }
        else if (label === 'Technical Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            
            aiPrompts[pid] = `Extract 12-15 technical skills STRICTLY from this JD: "${jd.slice(0, 600)}". User has: ${userSkills.join(',')}. Add them ONLY if relevant to JD. Return comma-separated list of ONLY JD-relevant skills.`;
            
            // DYNAMIC FALLBACK: Use JD keywords as skills
            const dynamicSkills = getSmartFallback('skills', jd);
            const relevantUserSkills = userSkills.filter(s => jd.toLowerCase().includes(s.toLowerCase()));
            const combined = [...new Set([...relevantUserSkills, ...dynamicSkills])].slice(0, 15);
            aiFallbacks[pid] = combined.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiTypes[pid] = 'chips';
        }
        else if (label === 'Work Experience') {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
            // Dedupe
            const uniqueItems = new Map();
            if (experienceSections.length > 0) {
                 experienceSections.forEach(sec => {
                     (sec.items || []).forEach(item => {
                         if (!uniqueItems.has(item.key)) uniqueItems.set(item.key, { item, secTitle: sec.title });
                     });
                 });
            }

            if (uniqueItems.size > 0) {
                resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;
                for (const [key, data] of uniqueItems.entries()) {
                    const { item, secTitle } = data;
                    const pid = `sec_${sectionCounter++}`;
                    let companyName = secTitle.toLowerCase().includes('experience') ? "" : secTitle;
                    resumeBodyHtml += `
                      <div class="resume-item">
                        <div class="resume-row"><span class="resume-role">${escapeHtml(item.key)}</span><span class="resume-date">${escapeHtml(item.date || '')}</span></div>
                        ${companyName ? `<span class="resume-company">${escapeHtml(companyName)}</span>` : ''}
                        <ul id="${pid}">[${pid}]</ul>
                      </div>`;
                    aiPrompts[pid] = `Rewrite experience: "${item.bullets}". Write 2 concise sentences using keywords: "${jd.slice(0,200)}...". Pipe-separated.`;
                    aiFallbacks[pid] = `<li>${escapeHtml(item.key)}</li>`;
                    aiTypes[pid] = 'list';
                }
            }
        }
        else if (label === 'Projects') {
             resumeBodyHtml += `<div class="resume-section-title">Projects</div>`;
             const pid = `sec_${sectionCounter++}`;
             resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
             
            const projSec = (profile.customSections || []).find(s => s.title.toLowerCase().includes('project'));
             if (projSec && projSec.items && projSec.items.length) {
                  const inputs = projSec.items.slice(0, 2).map(i => `${i.key}: ${i.bullets}`).join(' || ');
                  aiPrompts[pid] = `Rewrite 2 projects using ONLY keywords from JD: "${jd.slice(0,300)}". Input: "${inputs}". Format: "<b>JD-Relevant Title:</b> Description | <b>Title:</b> Description".`;
             } else {
                  aiPrompts[pid] = `Create 2 academic projects using ONLY these JD keywords: "${jd.slice(0,200)}". Format: "<b>Title with JD keyword:</b> Desc | <b>Title:</b> Desc".`;
             }
             
             // Dynamic Fallback
             aiFallbacks[pid] = getSmartFallback('projects', jd).split('|').map(p => `<li>${p.trim()}</li>`).join('');
             aiTypes[pid] = 'list';
        }
        else if (label === 'Education') {
             resumeBodyHtml += `<div class="resume-section-title">Education</div>`;
             const eduList = (profile.education && profile.education.length) ? profile.education : (profile.college ? [profile.college] : []);
             resumeBodyHtml += `<div class="resume-item">`;
             if (eduList.length > 0) resumeBodyHtml += eduList.map(e => `<div>${escapeHtml(e)}</div>`).join('');
             else resumeBodyHtml += `<div><i>(Add Education)</i></div>`;
             resumeBodyHtml += `</div>`;
        }
        else if (label === 'Certifications') {
            resumeBodyHtml += `<div class="resume-section-title">Certifications</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            aiPrompts[pid] = `Create 2 certifications using ONLY keywords from: "${jd.slice(0,200)}". Format: "Cert Name with JD keyword | Cert Name with JD keyword".`;
            aiFallbacks[pid] = getSmartFallback('certifications', jd).split('|').map(c => `<li>${c.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
        }
        else if (label === 'Achievements') {
            resumeBodyHtml += `<div class="resume-section-title">Achievements</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            aiPrompts[pid] = `Create 2 achievements using ONLY keywords from: "${jd.slice(0,200)}". Pipe-separated. Make them metric-driven and JD-relevant.`;
            aiFallbacks[pid] = getSmartFallback('achievements', jd).split('|').map(a => `<li>${a.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
        }
        else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = `List 6 character traits that match this JD: "${jd.slice(0,200)}". Comma-separated. Use ONLY JD-relevant traits.`;
            // Dynamic Traits from JD Keywords
            const kws = extractKeywordsFromJD(jd).slice(0, 6);
            const fallbackStr = kws.length ? kws.join(' | ') : extractKeywordsFromJD(jd).slice(0,4).join(' | ');
            aiFallbacks[pid] = fallbackStr.split('|').map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiTypes[pid] = 'chips';
        }
    }

    let htmlSkeleton = `
    <div class="generated-resume">
      ${RESUME_CSS}
      <div class="resume-header">
        <div class="resume-name">${escapeHtml(name)}</div>
        <div class="resume-contact">${contactLinks}</div>
      </div>
      ${resumeBodyHtml}
    </div>`;

    // CRITICAL FIX: If JD is too short (< 20 chars), skip AI and use JD-derived fallbacks
    const jdTooShort = !jd || jd.trim().length < 20;

    if (Object.keys(aiPrompts).length > 0 && jd && !jdTooShort) {
        // Simple prompt to reduce load
        const prompt = `You are a Resume Content Generator. TASK: Return valid JSON. Keys: ${Object.keys(aiPrompts).join(', ')}. INSTRUCTIONS:\n${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;

        try {
            const aiJsonText = await callGeminiFlash(prompt);
            let aiData = {};
            try { aiData = JSON.parse(aiJsonText.replace(/```json|```/g, '').trim()); } catch (e) {
                console.error('AI JSON parse failed:', e);
            }

            Object.keys(aiPrompts).forEach(pid => {
                let val = aiData[pid];
                const type = aiTypes[pid];
                if (val && typeof val === 'string' && val.length > 2) {
                    if (type === 'chips') { 
                        const chips = val.split(/[,|]/).map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
                    } else if (type === 'list') { 
                        const lis = val.split('|').map(b => `<li>${b.trim()}</li>`).join('');
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
                    } else if (type === 'summary') {
                        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, `<p>${escapeHtml(val)}</p>`);
                    }
                } else {
                    // AI didn't return this key, use fallback
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
                }
            });
        } catch (e) {
            console.error('AI call failed:', e);
            Object.keys(aiPrompts).forEach(pid => htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]));
        }
    } else {
         // No AI call needed or JD too short - use JD-derived fallbacks
         console.log('Using JD-derived fallbacks (JD too short or no prompts)');
         Object.keys(aiPrompts).forEach(pid => htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]));
    }

    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton } });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
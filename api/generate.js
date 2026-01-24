const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function escapeHtml(s = "") {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Extract important keywords from JD to force AI to focus
function extractKeywords(text, limit = 8) {
  if (!text || typeof text !== 'string') return [];
  const stop = new Set(['the','and','to','a','an','of','in','for','with','on','as','is','are','be','by','at','from','that','this','will','have','has','role','responsibilities']);
  const toks = text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
  const counts = {};
  for (const t of toks) {
    if (t.length < 3) continue;
    if (stop.has(t)) continue;
    counts[t] = (counts[t]||0)+1;
  }
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,limit).map(x=>x[0]);
}

function getSmartFallback(section, jd) {
  const job = String(jd || "").toLowerCase();
  
  if (section === 'skills') {
     const common = ["Problem Solving", "Git", "Agile"];
     if (job.includes('java')) return ["Java", "Spring Boot", "SQL", "REST APIs", ...common];
     if (job.includes('python')) return ["Python", "Django", "SQL", "Pandas", ...common];
     if (job.includes('react') || job.includes('front')) return ["React.js", "JavaScript", "HTML5", "CSS3", ...common];
     return ["Technical Skill 1", "Technical Skill 2", "Communication", "Teamwork"];
  }

  if (section === 'certifications') {
    if (job.includes('cloud') || job.includes('aws')) return "AWS Certified Cloud Practitioner | Azure Fundamentals";
    if (job.includes('python')) return "PCEP – Certified Entry-Level Python Programmer | Google Data Analytics";
    if (job.includes('java')) return "Oracle Certified Associate (Java SE) | Spring Professional";
    return "Course Completion: Full Stack Development | Professional Communication";
  }

  if (section === 'projects') {
     if (job.includes('java')) return "<b>Employee System:</b> Java Swing & MySQL app. | <b>Bookstore API:</b> Spring Boot REST API.";
     if (job.includes('python')) return "<b>Weather App:</b> Python CLI tool with API integration. | <b>Analysis Tool:</b> Data processing script using Pandas.";
     if (job.includes('web')) return "<b>Admin Dashboard:</b> React.js admin panel. | <b>Portfolio Site:</b> Responsive HTML5/CSS3 website.";
     return "<b>Academic Project 1:</b> Database design and implementation. | <b>Academic Project 2:</b> Web application prototype.";
  }

  if (section === 'achievements') {
      return "Awarded 'Best Student Project' for final year submission. | Ranked top 10% in Annual Coding Hackathon.";
  }

  return "";
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
      temperature: 0.25, // low creativity to stick to JD
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

    // compute JD keywords once and use in prompts
    const jdKeywords = extractKeywords(jd || '', 8);
    const jdKeyline = jdKeywords.length ? `JD keywords: ${jdKeywords.join(', ')}.` : '';

    const seen = new Set();
    const sectionsToRender = [];
    const rawScope = (scope && scope.length) ? scope : ['Summary', 'Technical Skills', 'Work Experience', 'Projects', 'Education', 'Certifications', 'Achievements'];
    
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
            
            aiPrompts[pid] = `Write a 3-sentence summary for a Fresher '${jd.slice(0,50)}' role. Input: "${original}". STRICTLY tailor to JD keywords. ${jdKeyline} Avoid generic, unrelated content.`;
            aiFallbacks[pid] = `<p>Aspiring ${jd.slice(0,30)} with strong academic background and relevant project experience.</p>`;
            aiTypes[pid] = 'summary';
        }
        else if (label === 'Technical Skills') {
            resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
            const pid = `sec_${sectionCounter++}`;
            const userSkills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(',') : []);
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = `List 10-12 technical skills STRICTLY for JD: "${jd.slice(0, 300)}". Include user skills (${userSkills.join(',')}). ${jdKeyline} Return comma-separated list; avoid generic skills not relevant to JD.`;
            const fallbackList = getSmartFallback('skills', jd);
            const combined = [...new Set([...userSkills, ...fallbackList])].slice(0, 10);
            aiFallbacks[pid] = combined.map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
            aiTypes[pid] = 'chips';
        }
        else if (label === 'Work Experience') {
            const experienceSections = (profile.customSections || [])
               .filter(s => s.type === 'entries' && (s.title.toLowerCase().includes('experience') || s.title.toLowerCase().includes('work')));
            
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
                    aiPrompts[pid] = `Rewrite experience: "${item.bullets}". Write 2 concise, metric-driven sentences tailored to JD. Pipe-separated. ${jdKeyline} Use JD context and do not invent unrelated domains.`;
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
                  aiPrompts[pid] = `Rewrite 2 projects: "${inputs}". Format: "<b>Title:</b> Desc | <b>Title:</b> Desc". Tailor strictly to JD. ${jdKeyline}`;
             } else {
                  aiPrompts[pid] = `Invent 2 academic projects for '${jd.slice(0,50)}'. Format: "<b>Title:</b> Desc | <b>Title:</b> Desc". ${jdKeyline} Ensure projects are relevant to the JD.`;
             }
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
            aiPrompts[pid] = `Invent 2 certifications for '${jd.slice(0,50)}'. Format: "Cert Name | Cert Name". ${jdKeyline} Prefer certifications relevant to JD.`;
            aiFallbacks[pid] = getSmartFallback('certifications', jd).split('|').map(c => `<li>${c.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
        }
        else if (label === 'Achievements') {
            resumeBodyHtml += `<div class="resume-section-title">Achievements</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item"><ul id="${pid}">[${pid}]</ul></div>`;
            aiPrompts[pid] = `Invent 2 achievements for '${jd.slice(0,50)}'. Pipe-separated. ${jdKeyline} Ensure achievements sound relevant to the JD.`;
            aiFallbacks[pid] = getSmartFallback('achievements', jd).split('|').map(a => `<li>${a.trim()}</li>`).join('');
            aiTypes[pid] = 'list';
        }
        else {
            resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(secObj.original)}</div>`;
            const pid = `sec_${sectionCounter++}`;
            resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;
            aiPrompts[pid] = `List 6 character traits for '${jd.slice(0,50)}'. Comma-separated. ${jdKeyline} Prefer traits that align with JD competencies.`;
            aiFallbacks[pid] = "Fast Learner | Adaptable | Reliable".split('|').map(s => `<span class="skill-tag">${escapeHtml(s.trim())}</span>`).join(' ');
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

    if (Object.keys(aiPrompts).length > 0 && jd) {
        const prompt = `You are a Resume Content Generator. TASK: Return valid JSON. Keys: ${Object.keys(aiPrompts).join(', ')}. INSTRUCTIONS:\n${Object.entries(aiPrompts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;

        try {
            const aiJsonText = await callGeminiFlash(prompt);
            let aiData = {};
            try { aiData = JSON.parse(aiJsonText.replace(/```json|```/g, '').trim()); } catch (e) {}

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
                    htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
                }
            });
        } catch (e) {
            Object.keys(aiPrompts).forEach(pid => htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]));
        }
    } else {
         Object.keys(aiPrompts).forEach(pid => htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]));
    }

    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton } });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
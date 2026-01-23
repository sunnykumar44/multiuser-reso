const { saveHistory } = require("./firebase");

// --- HELPER FUNCTIONS ---
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeLower(s) {
  return String(s || "").trim().toLowerCase();
}

function canonicalSectionName(name) {
  const s = safeLower(name);

  // Treat these as the same section
  if (s.includes("work experience")) return "experience";
  if (s === "work") return "experience";
  if (s.includes("experience")) return "experience";

  // Common aliases
  if (s.includes("technical skills")) return "skills";
  if (s.includes("skill")) return "skills";

  if (s.includes("character")) return "character traits";
  if (s.includes("trait")) return "character traits";

  if (s.includes("certification")) return "certifications";
  if (s.includes("achievement")) return "achievements";

  return s;
}

function dedupeScope(scopeArr) {
  const seen = new Set();
  const out = [];
  for (const sec of (Array.isArray(scopeArr) ? scopeArr : [])) {
    const canon = canonicalSectionName(sec);
    if (!canon) continue;
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(sec);
  }
  return out;
}

// Invent content when user has no data (NEVER output "could not generate")
function inventedFallbackForSection(title, jd) {
  const t = canonicalSectionName(title);
  const jdLower = safeLower(jd);

  if (t === "certifications") {
    // Reasonable defaults for tech roles (esp Python dev)
    return `<ul>
      <li>AWS Certified Developer – Associate</li>
      <li>PCEP – Certified Entry-Level Python Programmer</li>
      <li>Google IT Automation with Python</li>
    </ul>`;
  }

  if (t === "achievements") {
    return `<ul>
      <li>Improved workflow efficiency by 20% by automating repetitive tasks and reporting.</li>
      <li>Delivered a key feature ahead of schedule while maintaining code quality and test coverage.</li>
      <li>Reduced manual errors by introducing validation and monitoring checks.</li>
    </ul>`;
  }

  if (t === "character traits") {
    return `<ul>
      <li>Ownership mindset</li>
      <li>Clear communicator</li>
      <li>Fast learner</li>
      <li>Detail-oriented</li>
      <li>Team-first attitude</li>
    </ul>`;
  }

  if (t === "experience") {
    // If user has no experience data, generate personal-project-style bullets
    // Keep it broad but aligned to JD
    const roleHint = jdLower.includes("python") ? "Python" : "software";
    return `<ul>
      <li>Built a ${roleHint}-based project demonstrating clean architecture, reusable modules, and error handling.</li>
      <li>Integrated APIs and implemented basic authentication, validation, and logging for maintainability.</li>
      <li>Used Git for version control and documented setup, usage, and key design decisions.</li>
    </ul>`;
  }

  if (t === "skills") {
    // Always chips, never "(Add skills)"
    const base = jdLower.includes("python")
      ? ["Python", "SQL", "Git", "REST APIs", "Flask/FastAPI", "Pandas", "Unit Testing", "Linux"]
      : ["Communication", "Problem Solving", "Teamwork", "Time Management"];
    return base.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join("");
  }

  // Generic fallback for any other selected section
  return `<ul>
    <li>Relevant experience and strengths aligned with the job description.</li>
    <li>Demonstrates practical capability, consistency, and initiative.</li>
  </ul>`;
}

// Convert an existing section object to clean HTML (prevents JSON showing in UI)
function sectionToBulletsHtml(sec) {
  if (!sec) return "";
  const items = Array.isArray(sec.items) ? sec.items : [];
  if (!items.length) return "";

  // bullets type: items: ["a","b"]
  if (sec.type !== "entries") {
    const lis = items
      .map(x => String(x || "").trim())
      .filter(Boolean)
      .slice(0, 8)
      .map(t => `<li>${escapeHtml(t)}</li>`)
      .join("");
    return lis ? `<ul>${lis}</ul>` : "";
  }

  // entries type: items: [{key, bullets:[]}]
  const out = [];
  for (const it of items) {
    if (it?.key && String(it.key).trim()) out.push(String(it.key).trim());
    const bullets = Array.isArray(it?.bullets) ? it.bullets : [];
    for (const b of bullets) {
      const s = String(b || "").trim();
      if (s) out.push(s);
    }
  }
  const lis = out
    .filter(Boolean)
    .slice(0, 8)
    .map(t => `<li>${escapeHtml(t)}</li>`)
    .join("");
  return lis ? `<ul>${lis}</ul>` : "";
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

    /* Skills as Boxes/Chips */
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
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;

  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.75, // keep creativity for invention
      maxOutputTokens: 3000,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
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
    const body =
      typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const { profile = {}, jd = "", nickname = "", scope = [] } = body;

    // 1. Static Header
    const name = (profile.fullName || nickname || "User").toUpperCase();
    const contactLinks = [
      profile.email
        ? `<a href="mailto:${escapeHtml(profile.email)}">${escapeHtml(
            profile.email
          )}</a>`
        : null,
      profile.phone ? escapeHtml(profile.phone) : null,
      profile.linkedin
        ? `<a href="${escapeHtml(profile.linkedin)}">LinkedIn</a>`
        : null,
      profile.github ? `<a href="${escapeHtml(profile.github)}">GitHub</a>` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    let resumeBodyHtml = "";

    // We will collect instructions here.
    const aiPrompts = {};
    const aiFallbacks = {};
    const aiTypes = {}; // pid -> 'summary' | 'skills' | 'ul_items' | 'div_ul'
    let sectionCounter = 0;

    // Default sections if scope is empty
    const rawSectionsToRender =
      scope && scope.length > 0
        ? scope
        : ["Summary", "Skills", "Experience", "Education"];

    // ✅ DEDUPE to prevent Experience + Work Experience duplicates
    const sectionsToRender = dedupeScope(rawSectionsToRender);

    for (const sectionName of sectionsToRender) {
      const key = String(sectionName || "").trim();
      const canon = canonicalSectionName(key);

      // --- A. SUMMARY ---
      if (canon === "summary") {
        resumeBodyHtml += `<div class="resume-section-title">Summary</div>`;
        const pid = `sec_${sectionCounter++}`;
        const original = String(profile.summary || "").trim();

        resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;

        // ✅ Force rewrite (no lazy "good"), tailored to JD
        aiPrompts[pid] = `
Write a 3-sentence professional summary tailored to this job.
JD: ${String(jd || "").slice(0, 600)}
User input summary: "${original}"

Rules:
- Do NOT reuse the raw input as-is (e.g., if it is "good", don't output "good").
- Make it specific: role title, core skills, and impact/strengths.
- 3 sentences only.
Return plain text only (no HTML).
        `.trim();

        aiTypes[pid] = "summary";
        // Fallback: if user summary empty/short -> invent
        aiFallbacks[pid] =
          original && original.length > 10
            ? `<p>${escapeHtml(original)}</p>`
            : `<p>Results-oriented candidate with strong fundamentals aligned to the target role, focused on delivering clean and reliable outcomes. Skilled in problem-solving, learning quickly, and applying best practices to real tasks and projects. Motivated to contribute to a team environment and grow through challenging responsibilities.</p>`;
      }

      // --- B. SKILLS (CHIPS) ---
      else if (canon === "skills") {
        resumeBodyHtml += `<div class="resume-section-title">Technical Skills</div>`;
        const pid = `sec_${sectionCounter++}`;

        const userSkills = Array.isArray(profile.skills)
          ? profile.skills
          : profile.skills
          ? String(profile.skills).split(",")
          : [];

        resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;

        aiPrompts[pid] = `
List 8-12 technical skills relevant to this job.
Job: ${String(jd || "").slice(0, 500)}
User skills to include if relevant: ${userSkills.join(", ")}

Return ONLY a COMMA-SEPARATED list (no bullets, no numbering, no HTML).
        `.trim();

        aiTypes[pid] = "skills";

        // ✅ Never show "(Add skills)" — always show chips
        const fallbackChips =
          userSkills.length > 0
            ? userSkills
                .map((s) =>
                  `<span class="skill-tag">${escapeHtml(String(s).trim())}</span>`
                )
                .join("")
            : inventedFallbackForSection("skills", jd);

        aiFallbacks[pid] = fallbackChips;
      }

      // --- C. EXPERIENCE (DEDUPED) ---
      else if (canon === "experience") {
        // Find all entries sections matching experience/work
        const experienceSections = (profile.customSections || []).filter(
          (s) =>
            s &&
            s.type === "entries" &&
            (safeLower(s.title).includes("experience") ||
              safeLower(s.title).includes("work"))
        );

        if (experienceSections.length > 0) {
          resumeBodyHtml += `<div class="resume-section-title">Work Experience</div>`;

          for (const sec of experienceSections) {
            for (const item of sec.items || []) {
              const pid = `sec_${sectionCounter++}`;

              resumeBodyHtml += `
                <div class="resume-item">
                  <div class="resume-row">
                    <span class="resume-role">${escapeHtml(item.key || "")}</span>
                    <span class="resume-date">${escapeHtml(item.date || "")}</span>
                  </div>
                  <span class="resume-company">${escapeHtml(sec.title || "")}</span>
                  <ul id="${pid}">[${pid}]</ul>
                </div>`;

              aiPrompts[pid] = `
Write 3 strong, metric-driven resume bullet points for this role.
Role: ${String(item.key || "")}
Job: ${String(jd || "").slice(0, 600)}
Existing bullets (if any): ${JSON.stringify(item.bullets || [])}

Return ONLY pipe-separated bullets:
Bullet 1 | Bullet 2 | Bullet 3
No HTML.
              `.trim();

              aiTypes[pid] = "ul_items";

              const originalBullets =
                Array.isArray(item.bullets) && item.bullets.length
                  ? item.bullets
                      .map((b) => `<li>${escapeHtml(b)}</li>`)
                      .join("")
                  : "";

              aiFallbacks[pid] =
                originalBullets ||
                `<li>Contributed to deliverables aligned with team goals and timelines.</li>
                 <li>Applied best practices to improve reliability and maintainability.</li>
                 <li>Collaborated effectively and communicated progress clearly.</li>`;
            }
          }
        } else {
          // ✅ No experience data: STILL generate projects-style bullets (never show "No experience data")
          resumeBodyHtml += `<div class="resume-section-title">Experience</div>`;
          const pid = `sec_${sectionCounter++}`;
          resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;

          aiPrompts[pid] = `
User has no work experience listed. Create a small "Projects / Experience" section aligned to the job.
Job: ${String(jd || "").slice(0, 600)}

Return ONLY pipe-separated bullets:
Bullet 1 | Bullet 2 | Bullet 3
No HTML.
          `.trim();

          aiTypes[pid] = "div_ul";
          aiFallbacks[pid] = inventedFallbackForSection("experience", jd);
        }
      }

      // --- D. EDUCATION ---
      else if (canon === "education") {
        resumeBodyHtml += `<div class="resume-section-title">Education</div>`;
        const eduList =
          profile.education && profile.education.length
            ? profile.education
            : profile.college
            ? [profile.college]
            : [];

        resumeBodyHtml += `<div class="resume-item">`;
        if (eduList.length > 0) {
          resumeBodyHtml += eduList
            .map((e) => `<div>${escapeHtml(e)}</div>`)
            .join("");
        } else {
          resumeBodyHtml += `<div>${escapeHtml("Education details available upon request.")}</div>`;
        }
        resumeBodyHtml += `</div>`;
      }

      // --- E. OTHER / NEW SECTIONS (Certifications, Achievements, Character Traits, etc.) ---
      else {
        // Use user-selected key as display label, but canon for logic
        const displayTitle =
          canon === "character traits"
            ? "Character Traits"
            : canon === "certifications"
            ? "Certifications"
            : canon === "achievements"
            ? "Achievements"
            : key;

        resumeBodyHtml += `<div class="resume-section-title">${escapeHtml(
          displayTitle
        )}</div>`;

        const pid = `sec_${sectionCounter++}`;

        resumeBodyHtml += `<div class="resume-item" id="${pid}">[${pid}]</div>`;

        // Try to find an existing section by canonical match (prevents mismatch)
        const existingSec = (profile.customSections || []).find((s) => {
          const st = canonicalSectionName(s?.title || "");
          return st && st === canon;
        });

        if (existingSec) {
          // Improve existing, but fallback must NEVER be JSON
          aiPrompts[pid] = `
Refine this resume section for the job. Keep it realistic and professional.
Section: ${displayTitle}
Job: ${String(jd || "").slice(0, 600)}
Current data: ${JSON.stringify(existingSec)}

Return ONLY pipe-separated bullets:
Bullet 1 | Bullet 2 | Bullet 3
No HTML.
          `.trim();

          aiTypes[pid] = "div_ul";

          aiFallbacks[pid] =
            sectionToBulletsHtml(existingSec) ||
            inventedFallbackForSection(displayTitle, jd);
        } else {
          // INVENT DATA (no "could not generate")
          aiPrompts[pid] = `
User needs a "${displayTitle}" section but has no data.
Job: ${String(jd || "").slice(0, 600)}

Invent 2-3 realistic bullet points that fit the job and the candidate profile.
Return ONLY pipe-separated bullets:
Bullet 1 | Bullet 2 | Bullet 3
No HTML.
          `.trim();

          aiTypes[pid] = "div_ul";
          aiFallbacks[pid] = inventedFallbackForSection(displayTitle, jd);
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
    if (Object.keys(aiPrompts).length > 0 && String(jd || "").trim()) {
      const prompt = `
You are a Resume Content Generator.

JOB DESCRIPTION:
${String(jd || "").slice(0, 1200)}

TASK:
Respond with a VALID JSON object.
Keys: ${Object.keys(aiPrompts).join(", ")}
Values: Generated TEXT ONLY.

INSTRUCTIONS PER KEY:
${Object.entries(aiPrompts)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

IMPORTANT RULES:
- Return only JSON.
- No markdown fences.
- No HTML tags in values.
- For skills: comma-separated only.
- For bullets: pipe-separated only.
- For summary: plain text paragraph (3 sentences).
`.trim();

      try {
        const aiJsonText = await callGeminiFlash(prompt);

        let aiData = {};
        try {
          const clean = String(aiJsonText || "")
            .replace(/```json|```/g, "")
            .trim();
          aiData = JSON.parse(clean);
        } catch (e) {
          console.error("JSON parse error:", e);
        }

        for (const pid of Object.keys(aiPrompts)) {
          let val = aiData[pid];

          // Basic sanitize
          if (typeof val === "string") val = val.trim();

          if (val && typeof val === "string" && val.length > 2) {
            const type = aiTypes[pid];

            if (type === "skills") {
              // Skills -> Chips
              const skills = val
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 14);

              const chips =
                skills.length > 0
                  ? skills
                      .map(
                        (s) =>
                          `<span class="skill-tag">${escapeHtml(s)}</span>`
                      )
                      .join("")
                  : aiFallbacks[pid];

              htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, chips);
            } else if (type === "ul_items") {
              // UL items only (already inside <ul>)
              const bullets = val
                .split("|")
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 6);

              const lis =
                bullets.length > 0
                  ? bullets
                      .map((b) => `<li>${escapeHtml(b)}</li>`)
                      .join("")
                  : aiFallbacks[pid];

              htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, lis);
            } else if (type === "div_ul") {
              // Wrap bullets in <ul> inside a div
              const bullets = val
                .split("|")
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 6);

              const ul =
                bullets.length > 0
                  ? `<ul>${bullets
                      .map((b) => `<li>${escapeHtml(b)}</li>`)
                      .join("")}</ul>`
                  : aiFallbacks[pid];

              htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, ul);
            } else {
              // Summary -> paragraph
              htmlSkeleton = htmlSkeleton.replace(
                `[${pid}]`,
                `<p>${escapeHtml(val)}</p>`
              );
            }
          } else {
            htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
          }
        }
      } catch (e) {
        console.error("AI Error", e);
        // fallback to safe HTML
        for (const pid of Object.keys(aiPrompts)) {
          htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
        }
      }
    } else {
      // No JD -> fall back immediately
      for (const pid of Object.keys(aiPrompts)) {
        htmlSkeleton = htmlSkeleton.replace(`[${pid}]`, aiFallbacks[pid]);
      }
    }

    return res.status(200).json({ ok: true, generated: { html: htmlSkeleton } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

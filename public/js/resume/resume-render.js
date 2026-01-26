import { getHeaderLinks } from "../../js/register/register-sections.js";

// --- Helper for URLs ---
export function normalizeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return "https://" + s;
}

function safe(s) {
  return String(s ?? "").trim();
}

function titleCase(s = "") {
  return String(s)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const hasText = (v) => String(v || "").trim().length > 0;
const hasArr = (a) => Array.isArray(a) && a.length > 0;

const normTitle = (t) =>
  String(t || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

function mergeEntriesSections(sections) {
  const map = new Map();
  const order = [];

  for (const s of sections) {
    const titleRaw = String(s?.title || "").trim() || "Experience";
    const key = `${s?.type || "entries"}|${s?.placement || "section"}|${normTitle(titleRaw)}`;

    const items = Array.isArray(s?.items) ? s.items : [];
    const keepEmpty = !!(s?.keepEmpty || (map.has(key) && map.get(key).keepEmpty));

    if (!map.has(key)) {
      map.set(key, { ...s, title: titleRaw, items: [...items], keepEmpty });
      order.push(key);
    } else {
      const entry = map.get(key);
      entry.items.push(...items);
      entry.keepEmpty = keepEmpty;
    }
  }
  return order.map((k) => map.get(k));
}

function mergeBulletsSections(sections) {
  const map = new Map();
  const order = [];

  for (const s of sections) {
    const titleRaw = String(s?.title || "").trim() || "Custom Section";
    const key = `${s?.type || "bullets"}|${s?.placement || "section"}|${normTitle(titleRaw)}`;

    const items = Array.isArray(s?.items) ? s.items : [];
    const keepEmpty = !!(s?.keepEmpty || (map.has(key) && map.get(key).keepEmpty));

    if (!map.has(key)) {
      map.set(key, { ...s, title: titleRaw, items: [...items], keepEmpty });
      order.push(key);
    } else {
      const entry = map.get(key);
      entry.items.push(...items);
      entry.keepEmpty = keepEmpty;
    }
  }

  return order.map((k) => {
    const sec = map.get(k);
    sec.items = [...new Set(sec.items.map((x) => String(x).trim()).filter(Boolean))];
    return sec;
  });
}

const EDIT_ATTRS = 'contenteditable="true" spellcheck="false"';

function scopeHas(scope, title) {
  const t = String(title || "").trim().toLowerCase();
  return (scope || []).some((x) => String(x || "").trim().toLowerCase() === t);
}

export function renderPaper({ paperEl, profile, jd, mode, template, scope = [], htmlOverride = "" }) {
  if (!paperEl) return;

  // If user edited resume, we honor the saved HTML (fast MVP)
  if (htmlOverride && String(htmlOverride).trim().length > 0) {
    paperEl.innerHTML = htmlOverride;
    return;
  }

  // Defensive defaults (prevents blank preview if profile is missing some fields)
  profile = (profile && typeof profile === 'object') ? profile : {};
  if (!Array.isArray(profile.customSections)) profile.customSections = [];
  if (!Array.isArray(profile.skills)) {
    if (typeof profile.skills === 'string') {
      profile.skills = profile.skills.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
    } else {
      profile.skills = [];
    }
  }

  const summaryText = (profile.summary || "").trim();
  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  const college = (profile.college || "").trim();

  const sectionsRaw = Array.isArray(profile.customSections) ? profile.customSections : [];
  const headerLinks = getHeaderLinks(sectionsRaw);

  const parts = [];
  if (hasText(profile.phone)) parts.push(`<span ${EDIT_ATTRS}>${safe(profile.phone)}</span>`);
  if (hasText(profile.email)) parts.push(`<span ${EDIT_ATTRS}>${safe(profile.email)}</span>`);
  if (hasText(profile.linkedin)) parts.push(`<a href="${normalizeUrl(profile.linkedin)}" target="_blank">LinkedIn</a>`);
  if (hasText(profile.github)) parts.push(`<a href="${normalizeUrl(profile.github)}" target="_blank">GitHub</a>`);

  for (const l of headerLinks) {
    parts.push(`<a href="${normalizeUrl(l.url)}" target="_blank">${safe(l.label)}</a>`);
  }
  const contactLine = parts.join(" | ");

  // Filter
  const rawEntries = sectionsRaw.filter((s) => s?.type === "entries" && (s?.placement ?? "section") === "section");
  const rawBullets = sectionsRaw.filter((s) => (s?.type === "bullets" || !s?.type) && (s?.placement ?? "section") === "section");

  const entries = mergeEntriesSections(rawEntries);
  const bullets = mergeBulletsSections(rawBullets);

  const pickEntriesByTitle = (kw) => entries.filter((s) => String(s.title || "").toLowerCase().includes(kw));
  const pickBulletsByTitle = (kw) => bullets.filter((s) => String(s.title || "").toLowerCase().includes(kw));

  const renderPillsSection = (title, items, keepEmpty) => {
    const list = Array.isArray(items) ? items : [];
    if (!hasArr(list) && !keepEmpty) return "";

    const content = hasArr(list)
      ? list.map((x) => `<span class="pill" ${EDIT_ATTRS}>${String(x).trim()}</span>`).join("")
      : `<span class="pill" ${EDIT_ATTRS}>AI will fill this</span>`;

    return `
      <div class="r-section">
        <div class="r-title">${title}</div>
        <div class="pillrow">${content}</div>
      </div>
    `;
  };

  const renderEntriesSection = (s) => {
    const title = titleCase(String(s.title || "").trim()) || "Experience";
    const list = Array.isArray(s.items) ? s.items : [];

    if (!hasArr(list) && !s.keepEmpty) return "";

    const isEmpty = !hasArr(list);

    const block = isEmpty
      ? `<div class="r-text muted" style="font-style:italic;" ${EDIT_ATTRS}>(AI will fill this section)</div>`
      : list
          .map((e) => {
            const key = String(e.key || "").trim().replace(/[“”"]/g, "");
            const b = Array.isArray(e.bullets) ? e.bullets : [];
            if (!key && !hasArr(b)) return "";
            return `
              ${key ? `<div class="r-text" style="font-weight:800;margin-top:6px;" ${EDIT_ATTRS}>${key}</div>` : ""}
              ${hasArr(b) ? `<ul class="r-bullets">${b.map((x) => `<li ${EDIT_ATTRS}>${x}</li>`).join("")}</ul>` : ""}
            `;
          })
          .join("");

    return `
      <div class="r-section">
        <div class="r-title">${title}</div>
        ${block}
      </div>
    `;
  };

  const renderBulletsSection = (s) => {
    const title = titleCase(String(s.title || "").trim()) || "Custom Section";
    const items = Array.isArray(s.items) ? s.items : [];

    if (!hasArr(items) && !s.keepEmpty) return "";

    const isEmpty = !hasArr(items);

    const content = isEmpty
      ? `<div class="r-text muted" style="font-style:italic;" ${EDIT_ATTRS}>(AI will fill this list)</div>`
      : `<ul class="r-bullets">${items.map((it) => `<li ${EDIT_ATTRS}>${it}</li>`).join("")}</ul>`;

    return `
      <div class="r-section">
        <div class="r-title">${title}</div>
        ${content}
      </div>
    `;
  };

  // Ordering buckets
  const workSections = [...new Set([...pickEntriesByTitle("work"), ...pickEntriesByTitle("experience"), ...pickEntriesByTitle("employment"), ...pickEntriesByTitle("intern")])];
  const projectSections = [...new Set([...pickEntriesByTitle("project")])];
  const certSections = pickBulletsByTitle("cert");
  const achievementSections = pickBulletsByTitle("achieve");
  const traitSections = pickBulletsByTitle("trait");

  const usedEntries = new Set([...workSections, ...projectSections]);
  const usedBullets = new Set([...certSections, ...achievementSections, ...traitSections]);

  const otherEntries = entries.filter((s) => !usedEntries.has(s));
  const otherBullets = bullets.filter((s) => !usedBullets.has(s));

  // Summary/Skills only show if user has content OR selected in scope
  const showEmptySummary = scopeHas(scope, "Summary");
  const showEmptySkills = scopeHas(scope, "Skills");

  paperEl.innerHTML = `
    <div style="text-align:center; margin-bottom:10px;">
      <div style="font-size:26px;font-weight:900;" ${EDIT_ATTRS}>
        ${safe(profile.fullName) || "Your Name"}
      </div>
      ${contactLine ? `<div style="margin-top:6px;font-size:12px;color:#334155;">${contactLine}</div>` : ""}
    </div>

    <div class="hr"></div>

    ${(hasText(summaryText) || showEmptySummary) ? `
      <div class="r-section">
        <div class="r-title">Summary</div>
        <div class="r-text" ${EDIT_ATTRS}>${summaryText || "(AI will generate summary here)"}</div>
      </div>
    ` : ""}

    ${hasText(college) ? `
      <div class="r-section">
        <div class="r-title">Education</div>
        <div class="r-text" ${EDIT_ATTRS}>${college}</div>
      </div>
    ` : ""}

    ${(hasArr(skills) || showEmptySkills) ? `
      <div class="r-section">
        <div class="r-title">Skills</div>
        <div class="pillrow">
          ${
            skills.length
              ? skills.map((s) => `<span class="pill" ${EDIT_ATTRS}>${s}</span>`).join("")
              : `<span class="pill" ${EDIT_ATTRS}>AI will generate skills here</span>`
          }
        </div>
      </div>
    ` : ""}

    ${workSections.map(renderEntriesSection).join("")}
    ${projectSections.map(renderEntriesSection).join("")}
    ${certSections.map(renderBulletsSection).join("")}
    ${achievementSections.map(renderBulletsSection).join("")}
    ${traitSections.map(s => renderPillsSection(titleCase(s.title || "Character Traits"), s.items || [], s.keepEmpty)).join("")}

    ${otherEntries.map(renderEntriesSection).join("")}
    ${otherBullets.map(renderBulletsSection).join("")}
  `;
}

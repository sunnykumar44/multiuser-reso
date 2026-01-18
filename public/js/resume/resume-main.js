import { renderPaper } from "./resume-render.js";
import * as History from "./history-manager.js";

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "") {
  const s = $("status");
  if (!s) return;
  s.className = "note" + (kind ? " " + kind : "");
  s.textContent = msg;
}

function setupChips(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const chips = [...el.querySelectorAll(".chip")];
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      persistDraftFromUI(); // save when user changes mode/template
    });
  });
}

function getActive(containerId, attr) {
  const el = document.getElementById(containerId);
  if (!el) return "";
  const chips = [...el.querySelectorAll(".chip")];
  return chips.find((c) => c.classList.contains("active"))?.getAttribute(attr) || "";
}

function setActive(containerId, attr, value) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const chips = [...el.querySelectorAll(".chip")];
  chips.forEach((c) => {
    if (c.getAttribute(attr) === value) c.classList.add("active");
    else c.classList.remove("active");
  });
}

setupChips("modes");
setupChips("templates");

// Make all buttons feel magnetic via a CSS class (apply site-wide on this page)
document.querySelectorAll('button').forEach(b => {
  try { b.classList.add('magnetic'); } catch (e) { /* ignore if not available */ }
});

// Flash a button with a success or warn animation
function flashButton(el, kind = "success") {
  if (!el) return;
  const cls = kind === "success" ? "flash-success" : "flash-warn";
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 900);
}

// Toast helper
function showToast(msg, kind = "success", ms = 1800) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = kind;
  t.style.display = "block";
  setTimeout(() => {
    t.style.display = "none";
    t.className = "";
  }, ms);
}

// Ensure toast exists. Some environments or edits might remove it; create a fallback.
;(function ensureToast() {
  try {
    if (!document.getElementById('toast')) {
      const t = document.createElement('div');
      t.id = 'toast';
      t.setAttribute('role','status');
      t.setAttribute('aria-live','polite');
      t.style.display = 'none';
  document.body.appendChild(t);
    }
  } catch (e) {
    console.error('[debug] ensureToast error', e);
  }
})();

// Session
const rawProfile = sessionStorage.getItem("unlockedProfile");
const nickname = sessionStorage.getItem("unlockedNickname");
const paperEl = $("paper");

const DRAFT_KEY = nickname ? `resumeDraft:${nickname}` : "resumeDraft:anon";
const HIST_KEY = "resumeHistory";

// Ensure we always use the current unlockedNickname (sessionStorage may change after module load)
function getEffectiveNickname() {
  try {
    return (
      sessionStorage.getItem('unlockedNickname') ||
      (rawProfile ? (safeParseJSON(rawProfile, {})?.nickname) : null) ||
      (rawProfile ? (safeParseJSON(rawProfile, {})?.fullName) : null) ||
      'anon'
    );
  } catch (e) {
    return 'anon';
  }
}
function getDraftKey() {
  return `resumeDraft:${getEffectiveNickname()}`;
}

// Override loadDraft/saveDraft to use dynamic draft key
function loadDraft() {
  try {
    const key = getDraftKey();
    const raw = sessionStorage.getItem(key);
    if (!raw) return defaultDraft();
    return safeParseJSON(raw, defaultDraft());
  } catch (e) {
    console.warn('loadDraft error', e);
    return defaultDraft();
  }
}

function saveDraft(draftObj) {
  try {
    const key = getDraftKey();
    sessionStorage.setItem(key, JSON.stringify(draftObj));
  } catch (e) {
    console.warn('saveDraft error', e);
  }
}

function nowISO() {
  return new Date().toISOString();
}

function safeParseJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// --------------------
// Draft model
// --------------------
function defaultDraft() {
  return {
    schema: "resume_draft_v1",
    updatedAt: nowISO(),
    jd: "",
    mode: "ats",
    template: "classic",
    scope: [],              // array of section titles selected for AI
    aiOnlySections: [],     // array of { type, title, placement, items, keepEmpty:true }
    htmlOverride: ""        // saved edited HTML
  };
}

function loadDraft() {
  try {
    const key = getDraftKey();
    const raw = sessionStorage.getItem(key);
    if (!raw) return defaultDraft();
    const d = safeParseJSON(raw, null);
    if (!d || d.schema !== "resume_draft_v1") return defaultDraft();
    // normalize
    if (!Array.isArray(d.scope)) d.scope = [];
    if (!Array.isArray(d.aiOnlySections)) d.aiOnlySections = [];
    if (typeof d.htmlOverride !== "string") d.htmlOverride = "";
    if (!d.mode) d.mode = "ats";
    if (!d.template) d.template = "classic";
    if (typeof d.jd !== "string") d.jd = "";
    return d;
  } catch (e) {
    console.warn('loadDraft error', e);
    return defaultDraft();
  }
}

function saveDraft(draft) {
  draft.updatedAt = nowISO();
  try {
    const key = getDraftKey();
    sessionStorage.setItem(key, JSON.stringify(draft));
  } catch (e) {
    console.warn('saveDraft error', e);
  }
}

function updateEditBadge() {
  const badge = $("editBadge");
  if (!badge) return;
  const present = draft && typeof draft.htmlOverride === "string" && draft.htmlOverride.trim().length > 0;
  badge.style.display = present ? "inline-block" : "none";
  // show undo only if there is a saved edit and we have something to undo
  showUndoButton(present && !!lastSavedHtmlOverride);
}

// Undo buffer for last saved htmlOverride (one-step undo)
let lastSavedHtmlOverride = null;
function showUndoButton(show) {
  const btn = $("btnUndoEdits");
  if (!btn) return;
  btn.style.display = show ? "inline-block" : "none";
}

// In-memory pending edits (autosave writes here; Save persists to draft.htmlOverride)
let pendingHtmlOverride = null;
// Timestamp until which autosave should be ignored (ms since epoch)
let ignoreAutosaveUntil = 0;

let draft = loadDraft();
updateEditBadge();

// --------------------
// AI Scope list (dynamic)
// --------------------
function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");
}

function titleCase(str) {
  return String(str || "").replace(/\w\S*/g, (txt) =>
    txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
}

function uniqByLower(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x || "").trim().toLowerCase();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(titleCase(x));
  }
  return out;
}

function getScopeFromUI() {
  const list = $("ai-scope-list");
  const checkboxes = list ? list.querySelectorAll("input[type=checkbox]") : [];
  const scope = [];
  checkboxes.forEach((cb) => {
    if (cb.checked) scope.push(cb.value);
  });
  return scope;
}

function setScopeToUI(scopeArr) {
  const set = new Set((scopeArr || []).map((x) => String(x).toLowerCase().trim()));
  const list = $("ai-scope-list");
  const checkboxes = list ? list.querySelectorAll("input[type=checkbox]") : [];
  checkboxes.forEach((cb) => {
    cb.checked = set.has(String(cb.value).toLowerCase().trim());
  });
}

function addCheckbox(container, labelText) {
  const label = document.createElement("label");
  label.style.cssText =
    "margin:0; cursor:pointer; display:flex; align-items:center; gap:6px; width:100%;";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = `scope-${slugify(labelText)}`;
  input.value = labelText;

  // default ON only when draft.scope saved OR profile has content for this title
  const hasSavedScope = Array.isArray(draft.scope) && draft.scope.length > 0;
  const profileHas = typeof labelText === 'string' && profileHasContentForTitle(labelText);
  input.checked = hasSavedScope ? draft.scope.map(x => String(x).toLowerCase()).includes(String(labelText).toLowerCase()) : !!profileHas;

  input.addEventListener("change", () => {
    draft.scope = getScopeFromUI();
    // changing scope invalidates html override (because sections may hide/show)
    draft.htmlOverride = "";
    saveDraft(draft);
    renderWithDraft();
  });

  const span = document.createElement("span");
  span.textContent = labelText;

  label.appendChild(input);
  label.appendChild(span);
  container.appendChild(label);
  updateEditBadge();
}

// Helper: does the current unlocked profile have content for the given title?
function profileHasContentForTitle(title) {
  try {
    const raw = sessionStorage.getItem('unlockedProfile');
    if (!raw) return false;
    const profile = JSON.parse(raw);
    const t = String(title || '').trim().toLowerCase();

    if (t === 'summary') return !!(profile.summary && String(profile.summary).trim());
    if (t === 'skills' || t === 'technical skills') return Array.isArray(profile.skills) && profile.skills.length > 0;
    // check custom sections match by title
    const secs = Array.isArray(profile.customSections) ? profile.customSections : [];
    for (const s of secs) {
      const st = String(s?.title || '').trim().toLowerCase();
      if (!st) continue;
      if (st.includes(t) || t.includes(st) || st === t) {
        // determine if section has items
        const items = Array.isArray(s.items) ? s.items : [];
        if (s.type === 'entries') {
          if (items.some(e => (String(e?.key || '').trim()) || (Array.isArray(e?.bullets) && e.bullets.length > 0))) return true;
        } else {
          if (items.some(x => String(x || '').trim())) return true;
        }
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

function renderAiScope(profile) {
  const list = $("ai-scope-list");
  if (!list) return;
  list.innerHTML = "";

  // Standards (show these by default in the UI)
  const standards = ["Summary", "Skills", "Certifications", "Achievements", "Experience", "Character Traits"];

  // Custom sections from profile
  const profileTitles = (profile.customSections || [])
    .map((s) => s?.title)
    .filter(Boolean);

  // Also include 'Education' if the profile contains common education fields
  const hasEducation = (profile.education && profile.education.length) || (profile.educationEntries && profile.educationEntries.length) || (profile.college && String(profile.college).trim());
  if (hasEducation) profileTitles.push('Education');

  // AI-only sections from draft
  const aiOnlyTitles = (draft.aiOnlySections || []).map((s) => s?.title).filter(Boolean);

  const allTitles = uniqByLower([...standards, ...profileTitles, ...aiOnlyTitles]);

  allTitles.forEach((t) => addCheckbox(list, titleCase(t)));

  // If draft.scope exists, apply it
  if (Array.isArray(draft.scope) && draft.scope.length > 0) {
    setScopeToUI(draft.scope);
  }
}

// Toggle history visibility button
const btnToggleHistory = $('btnToggleHistory');
if (btnToggleHistory) {
  btnToggleHistory.addEventListener('click', () => {
    const container = $('history-container');
    if (!container) return;
    if (container.style.display === 'none' || container.style.display === '') {
      container.style.display = 'block';
      if (typeof History.render === 'function') History.render();
    } else {
      container.style.display = 'none';
    }
  });
}

// --------------------
// History
// --------------------
// Initialize history manager for this user
if (typeof History.initHistoryManager === 'function') {
  History.initHistoryManager(nickname, loadHistoryItem);
}

function loadHistoryItem(item) {
  $("jd").value = item.fullJd;
  setActive("modes", "data-mode", item.mode);
  setActive("templates", "data-template", item.template);

  // Apply to draft
  draft.jd = item.fullJd;
  draft.mode = item.mode;
  draft.template = item.template;
  draft.htmlOverride = "";
  saveDraft(draft);

  // Render directly from the draft without triggering Generate (avoids re-recording history)
  renderWithDraft();
  setStatus('Loaded resume from history.', 'ok');
}

// --------------------
// Render helpers
// --------------------
function hasAnyItems(section) {
  const items = section?.items;
  if (Array.isArray(items) && items.length > 0) return true;

  // entries items: [{key, bullets:[]}]
  if (Array.isArray(items)) return items.some((x) => x && (String(x.key || "").trim() || (Array.isArray(x.bullets) && x.bullets.length)));
  return false;
}

function scopeIncludes(scopeArr, title) {
  const t = String(title || "").trim().toLowerCase();
  return (scopeArr || []).some((x) => String(x || "").trim().toLowerCase() === t);
}

function buildDerivedProfile(baseProfile) {
  const scope = draft.scope || [];

  // Combine base customSections + AI-only sections
  const combined = [
    ...(Array.isArray(baseProfile.customSections) ? baseProfile.customSections : []),
    ...(Array.isArray(draft.aiOnlySections) ? draft.aiOnlySections : []),
  ];

  // Apply rule:
  // - If section has items => keepEmpty true (it should render)
  // - If empty => keepEmpty only if selected in AI scope
  const patched = combined.map((s) => {
    const title = String(s?.title || "").trim();
    const filled = hasAnyItems(s);
    return {
      ...s,
      title,
      keepEmpty: filled ? true : scopeIncludes(scope, title),
    };
  });

  return {
    ...baseProfile,
    customSections: patched,
  };
}

function attachEditAutosave() {
  if (!paperEl) return;

  let t = null;
  const scheduleSave = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
  // If within suppression window, skip autosave to avoid re-marking unsaved.
  if (Date.now() < ignoreAutosaveUntil) return;
  // Keep edits pending in-memory; user must click Save to persist.
  pendingHtmlOverride = paperEl.innerHTML || "";
  // show unsaved visual on Save button
  const saveBtn = $("btnSaveEdits");
  if (saveBtn) saveBtn.classList.add("unsaved");
  // small toast to indicate auto-capture (subtle)
  const who = $("who"); // no-op to keep lint quiet
    }, 400);
  };

  // capture edits
  paperEl.addEventListener("input", scheduleSave);
  paperEl.addEventListener("blur", scheduleSave, true);
}

function renderWithDraft() {
  const raw = sessionStorage.getItem("unlockedProfile");
  if (!raw) return;

  const profile = safeParseJSON(raw, null);
  if (!profile) return;

  // Restore UI state from draft
  if ($("jd") && typeof draft.jd === "string") $("jd").value = draft.jd;
  setActive("modes", "data-mode", draft.mode || "ats");
  setActive("templates", "data-template", draft.template || "classic");

  const derivedProfile = buildDerivedProfile(profile);

  renderPaper({
    paperEl,
    profile: derivedProfile,
    jd: draft.jd || "",
    mode: draft.mode || "ats",
    template: draft.template || "classic",
    scope: draft.scope || [],
    htmlOverride: draft.htmlOverride || "",
  });
}

// --------------------
// Locked / Ready
// --------------------
function renderLocked() {
  const who = $("who");
  if (who) who.textContent = "Not unlocked";
  setStatus("Locked. Go back and unlock your profile first.", "err");
  renderPaper({
    paperEl,
    profile: { fullName: "", college: "", nickname: "", summary: "", skills: [], customSections: [] },
    jd: "",
    mode: "ats",
    template: "classic",
    scope: [],
    htmlOverride: "",
  });
}

function renderReady(profile) {
  const who = $("who");
  if (who) who.textContent = `Unlocked as: ${nickname}`;
  setStatus("Ready. Paste a job description and generate.", "ok");
  renderAiScope(profile);
  if (!nickname) {
    // show hint in history area
    const container = $('history-container');
    const list = $('history-list');
    if (container && list) {
      container.style.display = 'block';
      list.innerHTML = '<div class="hist-item">No user unlocked. Unlock your profile to see your recent resumes. (Tip: visit /resume.html, not /public/resume.html)</div>';
    }
  } else {
    if (typeof History.render === 'function') History.render();
  }

  renderWithDraft();
  attachEditAutosave();
}

// MAIN INIT
if (!rawProfile || !nickname) {
  renderLocked();
} else {
  try {
    const profile = safeParseJSON(rawProfile, null);
    if (!profile) throw new Error("Profile parse error");
    if (!Array.isArray(profile.customSections)) profile.customSections = [];
    renderReady(profile);
  } catch (e) {
    console.error("Profile parse error:", e);
    renderLocked();
  }
}

// --------------------
// Persist draft from UI (mode/template/jd)
// --------------------
function persistDraftFromUI() {
  const jdField = $("jd");
  draft.jd = jdField ? jdField.value.trim() : "";
  draft.mode = getActive("modes", "data-mode") || "ats";
  draft.template = getActive("templates", "data-template") || "classic";
  draft.scope = getScopeFromUI();
  saveDraft(draft);
}

// Keep draft in sync while typing JD
const jdEl = $("jd");
if (jdEl) {
  jdEl.addEventListener("input", () => {
    draft.jd = jdEl.value;
    // editing JD invalidates html override
    draft.htmlOverride = "";
    saveDraft(draft);
    updateEditBadge();
  });
}

// --------------------
// Add AI-only section
// --------------------
const btnAddAiSection = $("btnAddAiSection");
if (btnAddAiSection) {
  btnAddAiSection.addEventListener("click", () => {
    const name = prompt("Enter section name (e.g., 'Volunteering', 'Awards'):");
    const title = String(name || "").trim();
    if (!title) return;

    // AI-only section (draft only)
    const newSection = {
      type: "entries",       // safe default; later you can choose bullets/entries in UI
      title,
      placement: "section",
      items: [],
      keepEmpty: true,
    };

    // Avoid duplicates by title (case-insensitive)
    const exists = (draft.aiOnlySections || []).some(
      (s) => String(s?.title || "").trim().toLowerCase() === title.toLowerCase()
    );
    if (exists) {
      setStatus(`Section "${title}" already exists in draft.`, "err");
      return;
    }

    draft.aiOnlySections = [...(draft.aiOnlySections || []), newSection];
    // auto-check new section in scope
    draft.scope = uniqByLower([...(draft.scope || []), title]);
    draft.htmlOverride = "";
    saveDraft(draft);

    // refresh scope UI + preview
    const raw = sessionStorage.getItem("unlockedProfile");
    const profile = raw ? safeParseJSON(raw, { customSections: [] }) : { customSections: [] };
    renderAiScope(profile);
    renderWithDraft();
    setStatus(`Added AI section: "${title}".`, "ok");
  });
}

// --------------------
// Generate (no AI calls yet, just draft creation)
// --------------------
const btnGen = $("btnGen");
if (btnGen) {
  btnGen.addEventListener("click", () => {
    const raw = sessionStorage.getItem("unlockedProfile");
    if (!raw) {
      setStatus("Locked. Unlock first.", "err");
      return;
    }

    const profile = safeParseJSON(raw, null);
    if (!profile) {
      setStatus("Profile parse failed.", "err");
      return;
    }

    const jdField = $("jd");
    const jd = jdField ? jdField.value.trim() : "";
    if (!jd) {
      setStatus("Paste a job description first.", "err");
      return;
    }

    const mode = getActive("modes", "data-mode") || "ats";
    const template = getActive("templates", "data-template") || "classic";
    const scope = getScopeFromUI();

    // Save draft
    draft.jd = jd;
    draft.mode = mode;
    draft.template = template;
    draft.scope = scope;
    draft.htmlOverride = ""; // new generation resets manual edits
    saveDraft(draft);

    renderWithDraft();
    // record generation in history manager
    if (typeof History.addHistoryItem === 'function') {
      History.addHistoryItem({ jd, mode, template, name: nickname || '' });
    }
    setStatus(`Generated (draft). AI scope: ${scope.join(", ") || "None"}`, "ok");
  });
}

// Server generate integration: POST to /api/generate and return parsed JSON
async function callGenerateAPI(payload) {
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Generate API error: ' + res.status + ' ' + txt);
    }
    return await res.json();
  } catch (err) {
    console.error('callGenerateAPI error:', err);
    throw err;
  }
}

// Wire the existing Generate button to call the server and render returned HTML
(function wireGenerateButton() {
  const btn = $('btnGen');
  if (!btn) return;

  btn.addEventListener('click', async (e) => {
    try {
      e.preventDefault();
      const jd = $('jd')?.value || '';
      const mode = getActive('modes', 'data-mode') || 'ats';
      const template = getActive('templates', 'data-template') || 'classic';
      const scope = typeof getScopeFromUI === 'function' ? getScopeFromUI() : [];
      const profile = rawProfile ? safeParseJSON(rawProfile, null) : null;

      // determine effective nickname (prefer unlockedNickname, then profile, then anon)
      const effectiveNickname = sessionStorage.getItem('unlockedNickname') || (profile && (profile.nickname || profile.fullName)) || 'anon';

      setStatus('Generating via server...');
      const result = await callGenerateAPI({ profile, jd, mode, template, scope, nickname: effectiveNickname });
      if (result && result.generated && result.generated.html) {
        // Persist returned HTML into draft and render
        draft.htmlOverride = result.generated.html;
        saveDraft(draft);
        // Ensure immediate visible update even if module scope prevents calling renderWithDraft elsewhere
        try { if (typeof renderWithDraft === 'function') { renderWithDraft(); } else if (paperEl) { paperEl.innerHTML = result.generated.html; } } catch(e){ if (paperEl) paperEl.innerHTML = result.generated.html; }
        // Persist using the effective nickname key so drafts are tied to the right user
        try {
          const draftKey = `resumeDraft:${effectiveNickname}`;
          sessionStorage.setItem(draftKey, JSON.stringify(draft));
        } catch (e) { /* ignore storage errors */ }
        updateEditBadge();
        setStatus('Generated (server)');
        showToast('Generated', 'success', 1600);

        // Optionally add to local history UI if History helper present
        if (typeof History !== 'undefined' && History.addHistoryItem) {
          try {
            History.addHistoryItem({
              id: result.id || Date.now(),
              nickname: effectiveNickname,
              date: new Date().toISOString(),
              jdPreview: jd.slice(0, 140),
              mode,
              template,
              htmlSnapshot: result.generated.html,
            });
            if (History.render) History.render();
          } catch (hErr) { console.warn('history add failed', hErr); }
        }
      } else {
        setStatus('No generated result', 'err');
        showToast('No result from server', 'err');
      }
    } catch (err) {
      console.error('Generate click error:', err);
      setStatus('Generation failed', 'err');
      showToast('Generation failed', 'err');
    }
  });
})();

// --------------------
// Reset edits (remove htmlOverride, keep draft)
// --------------------
const btnResetEdits = $("btnResetEdits");
if (btnResetEdits) {
  btnResetEdits.addEventListener("click", () => {
  const ok = confirm("Reset edits? This will discard your manual changes to the preview.");
    if (!ok) return;
    draft.htmlOverride = "";
    saveDraft(draft);
  updateEditBadge();
    renderWithDraft();
  const resetBtn = $("btnResetEdits");
  flashButton(resetBtn, "warn");
  showToast("Edits reset", "warn");
  setStatus("Edits reset (re-rendered from draft data).", "ok");
  });
}

// --------------------
// Save edits (persist manual changes into draft.htmlOverride)
// --------------------
const btnSaveEdits = $("btnSaveEdits");
if (btnSaveEdits) {
  btnSaveEdits.addEventListener("click", () => {
    if (!paperEl) return;
    // Ask user to confirm they want to keep current manual edits
    const ok = confirm("Save your manual edits to this resume preview? (This will persist the current preview and reuse it until you reset or regenerate.)");
  if (!ok) return;

  // keep previous for undo
  lastSavedHtmlOverride = draft.htmlOverride || null;
  // persist pending edits if present, else use current preview
  let toSave = pendingHtmlOverride != null ? pendingHtmlOverride : (paperEl.innerHTML || "");
  // sanitize debug markers if any remained
  try { toSave = String(toSave).replace(/\s*\[DEBUG\]\s*/g, ' '); } catch (e) {}
  draft.htmlOverride = toSave;
  saveDraft(draft);
  updateEditBadge();
  // show undo button
  showUndoButton(!!lastSavedHtmlOverride);
  // clear pending and unsaved indicator
  pendingHtmlOverride = null;
  // remove .unsaved from all buttons to be robust
  document.querySelectorAll('button.unsaved').forEach(b => b.classList.remove('unsaved'));
  // suppress autosave for a short window to avoid immediate re-marking
  ignoreAutosaveUntil = Date.now() + 1200;

  // pulse badge briefly
  const badge = $("editBadge");
  if (badge) {
    badge.classList.add("pulse");
    setTimeout(() => badge.classList.remove("pulse"), 1400);
  }

  const saveBtn = $("btnSaveEdits");
  flashButton(saveBtn, "success");
  showToast("Saved edits", "success");
  if (saveBtn) {
    const orig = saveBtn.textContent;
    saveBtn.textContent = "Saved ✓";
    setTimeout(() => (saveBtn.textContent = orig), 1400);
  }

  setStatus("Manual edits saved. They will persist until reset or next generation.", "ok");
  });
}

// Undo last save
const btnUndoEdits = $("btnUndoEdits");
if (btnUndoEdits) {
  btnUndoEdits.addEventListener("click", () => {
    if (lastSavedHtmlOverride == null) return;
    const ok = confirm("Undo last saved edits and restore previous preview? This will replace current saved edits.");
    if (!ok) return;
    draft.htmlOverride = lastSavedHtmlOverride;
    lastSavedHtmlOverride = null;
    saveDraft(draft);
    updateEditBadge();
    showUndoButton(false);
    renderWithDraft();
  const undoBtn = $("btnUndoEdits");
  flashButton(undoBtn, "success");
  showToast("Undo applied", "success");
  setStatus("Undid last saved edits.", "ok");
  });
}

// --------------------
// Clear draft (fresh start)
// --------------------
const btnClearDraft = $("btnClearDraft");
if (btnClearDraft) {
  btnClearDraft.addEventListener("click", () => {
      updateEditBadge();
    const ok = confirm("Clear draft (JD, scope, AI sections, edits)?");
    if (!ok) return;
    draft = defaultDraft();
    saveDraft(draft);

    // reset UI
    if ($("jd")) $("jd").value = "";
    setActive("modes", "data-mode", "ats");
    setActive("templates", "data-template", "classic");

    const raw = sessionStorage.getItem("unlockedProfile");
    const profile = raw ? safeParseJSON(raw, { customSections: [] }) : { customSections: [] };
    renderAiScope(profile);
    renderWithDraft();
      updateEditBadge();
    setStatus("Draft cleared.", "ok");
  });
}

// --------------------
// PDF
// --------------------
const btnPdf = $("btnPdf");
if (btnPdf) {
  btnPdf.addEventListener("click", () => {
    const raw = sessionStorage.getItem("unlockedProfile");
    if (!raw) {
      setStatus("Locked.", "err");
      return;
    }
    if (!($("jd")?.value || "").trim()) {
      setStatus("Paste JD first.", "err");
      return;
    }
    // record download event before printing
    if (typeof History.addHistoryItem === 'function') {
      // include name and time; the history manager records date itself
      const jdField = $("jd");
      const jd = jdField ? jdField.value.trim() : '';
      History.addHistoryItem({ jd, mode: draft.mode, template: draft.template, name: nickname || '' });
    }
    window.print();
  });
}

// Edit profile
const btnEdit = $("btnEdit");
if (btnEdit) btnEdit.addEventListener("click", () => (window.location.href = "./register.html?edit=1"));

// Clear JD
const btnClear = $("btnClear");
if (btnClear) {
  btnClear.addEventListener("click", () => {
    const jd = $("jd");
    if (jd) jd.value = "";
    draft.jd = "";
    draft.htmlOverride = "";
    saveDraft(draft);
    renderWithDraft();
    setStatus("Job description cleared.", "ok");
  });
}

// Logout
const btnLogout = $("btnLogout");
if (btnLogout) {
  btnLogout.addEventListener("click", () => {
    sessionStorage.removeItem("unlockedProfile");
    sessionStorage.removeItem("unlockedNickname");
    // keep draft key separate — optional: you can clear it too if you want
    window.location.href = "./index.html";
  });
}

// Debug helper: simulate an edit and report whether autosave set the unsaved flag and toast display.
window.__debug_triggerAutosave = function () {
  return new Promise((resolve) => {
    try {
      const paper = document.getElementById('paper');
      if (!paper) return resolve({ error: 'paper not found' });
      // perform a harmless replacement
      paper.innerHTML = paper.innerHTML.replace('Your Name', 'Your Name [DEBUG]');
      paper.dispatchEvent(new Event('input', { bubbles: true }));

      // wait slightly longer than autosave debounce
      setTimeout(() => {
        const saveBtn = document.getElementById('btnSaveEdits');
        const toastEl = document.getElementById('toast');
        resolve({
          unsaved: !!(saveBtn && saveBtn.classList.contains('unsaved')),
          toastDisplay: window.getComputedStyle(toastEl || document.body).display,
          paperSample: (document.getElementById('paper')?.innerText || '').slice(0, 120)
        });
      }, 700);
    } catch (e) {
      resolve({ error: String(e) });
    }
  });
  };

// public/js/resume/resume-main.js
import { renderPaper } from "./resume-render.js";
import * as History from "./history-manager.js";

// Helper to get current time in ISO format (must exist before saveDraft is ever called)
// Use guarded assignment so we don't redeclare if it already exists later in the file.
// eslint-disable-next-line no-var
var nowISO = (typeof nowISO === 'function') ? nowISO : (() => {
  try { return new Date().toISOString(); } catch { return String(Date.now()); }
});

// ----- bootstrap fallbacks (must be top-of-file) -----
// Some hosted builds evaluated loadDraft before helper definitions; keep these at the very top.
const __safeParseJSON = (raw, fallback = null) => {
  try {
    if (raw == null) return fallback;
    if (typeof raw !== 'string') return raw;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
};

const __defaultDraft = () => ({
  schema: 'resume_draft_v1',
  jd: '',
  mode: 'ats',
  template: 'classic',
  scope: [],
  aiOnlySections: [],
  htmlOverride: '',
});

// Public API for safe JSON parsing (overrides bootstrap fallback if present)
function safeParseJSON(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

// Public API for default draft object (overrides bootstrap fallback if present)
function defaultDraft() {
  return {
    schema: 'resume_draft_v1',
    jd: '',
    mode: 'ats',
    template: 'classic',
    scope: [],
    aiOnlySections: [],
    htmlOverride: '',
  };
}

// Local selector helpers (avoid clobbering libraries like jQuery on hosted builds)
// Use guarded `var` to tolerate accidental duplicate injection in this file.
// eslint-disable-next-line no-var
var $id = (typeof $id === 'function') ? $id : ((id) => document.getElementById(id));
// eslint-disable-next-line no-var
var $qs = (typeof $qs === 'function') ? $qs : ((sel) => document.querySelector(sel));
// Back-compat: some older functions in this file expect `$()`.
// Keep it local to this module unless not present.
if (typeof window.$ !== 'function') {
  window.$ = (sel) => {
    if (typeof sel !== 'string') return null;
    const s = sel.trim();
    if (!s) return null;
    if (s.startsWith('#') || s.startsWith('.') || s.includes(' ') || s.includes('[') || s.includes('>')) {
      return $qs(s);
    }
    return $id(s);
  };
}

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

// Unified button UX helpers (feel-click + prevent double taps)
function withButtonFeedback(btn, fn, { busyText } = {}) {
  if (!btn || typeof fn !== 'function') return;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    const originalText = btn.textContent;
    try {
      btn.classList.add('is-busy');
      btn.disabled = true;
      if (busyText) btn.textContent = busyText;
      // force pressed style for keyboard/mouse consistency
      btn.classList.add('force-active');
      setTimeout(() => btn.classList.remove('force-active'), 140);
      await fn(e);
    } catch (err) {
      console.error('button action failed', err);
      flashButton(btn, 'warn');
      showToast('Action failed', 'warn');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (busyText) btn.textContent = originalText;
    }
  });
}

function clearDraftStorage() {
  try {
    const key = getDraftKey();
    sessionStorage.removeItem(key);
  } catch (e) {
    console.warn('clearDraftStorage error', e);
  }
}

function clearHistoryStorage() {
  // history-manager owns the actual server history; this clears client session cache only.
  try {
    sessionStorage.removeItem(HIST_KEY);
  } catch (e) {
    console.warn('clearHistoryStorage error', e);
  }
}

async function downloadAsPdf() {
  if (!paperEl) {
    setStatus('Nothing to print yet.', 'err');
    return;
  }
  // Ensure any pending edits are present in DOM before printing
  if (pendingHtmlOverride != null) {
    try { paperEl.innerHTML = pendingHtmlOverride; } catch (_) {}
  }
  setStatus('Preparing PDF…', 'ok');
  showToast('Opening print dialog…', 'success', 1400);
  // Give DOM a tick to apply
  await new Promise(r => setTimeout(r, 80));
  window.print();
}

function goEditProfile() {
  // Send user to unlock wall with next=edit (same pattern as lobby menu)
  const whoNick = getEffectiveNickname();
  window.location.href = `./unlock.html?u=${encodeURIComponent(whoNick)}&next=edit`;
}

function clearJdField() {
  const jdField = $('jd');
  if (jdField) jdField.value = '';
  draft.jd = '';
  // clearing JD invalidates html override
  draft.htmlOverride = '';
  saveDraft(draft);
  updateEditBadge();
  renderWithDraft();
  setStatus('JD cleared.', 'ok');
  showToast('JD cleared', 'warn', 1200);
}

function clearDraftAll() {
  const ok = confirm('Clear draft? This will reset JD, mode/template, scope selections, and manual edits for this user.');
  if (!ok) return;
  clearDraftStorage();
  draft = loadDraft();
  lastSavedHtmlOverride = null;
  pendingHtmlOverride = null;
  ignoreAutosaveUntil = Date.now() + 400;
  updateEditBadge();
  renderWithDraft();
  setStatus('Draft cleared.', 'ok');
  showToast('Draft cleared', 'warn', 1400);
}

function lockSession() {
  const ok = confirm('Lock now? You will need to unlock again to generate resumes.');
  if (!ok) return;
  try {
    // Clear unlocked session
    sessionStorage.removeItem('unlockedProfile');
    sessionStorage.removeItem('unlockedNickname');
  } catch (_) {}
  showToast('Locked', 'warn', 1200);
  window.location.href = './index.html';
}

// Session
const rawProfile = sessionStorage.getItem("unlockedProfile");
const nickname = sessionStorage.getItem("unlockedNickname");
const paperEl = $("paper");

// Module-scope state (declare once, early)
let draft = null;
let pendingHtmlOverride = null;
let ignoreAutosaveUntil = 0;
let lastSavedHtmlOverride = null;

// Show/hide the Undo-edits button
function showUndoButton(show) {
  try {
    const btn = $("btnUndoEdits");
    if (!btn) return;
    btn.style.display = show ? "inline-block" : "none";
  } catch (_) {}
}

// Update the "Edited" badge visibility based on draft.htmlOverride
function updateEditBadge() {
  try {
    const badge = $("editBadge");
    if (!badge) return;
    const present = draft && typeof draft.htmlOverride === "string" && draft.htmlOverride.trim().length > 0;
    badge.style.display = present ? "inline-block" : "none";
    showUndoButton(present && !!lastSavedHtmlOverride);
  } catch (_) {}
}

// Ensure these helpers are available on window for non-module callers
try { window.updateEditBadge = updateEditBadge; window.showUndoButton = showUndoButton; } catch (_) {}

// Ensure draft is defined as early as possible (some functions reference it during init)
// eslint-disable-next-line no-var
// var draft = (typeof draft !== 'undefined' && draft) ? draft : null;

// DRAFT_KEY is used for both draft and history (legacy)
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

function loadDraft() {
  try {
    const key = getDraftKey();
    const raw = sessionStorage.getItem(key);
    if (!raw) return defaultDraft();
    // Back-compat: older builds accidentally stored raw HTML under resumeDraft:<nick>.
    // If it's not a JSON object, ignore it so profile rendering works.
    const d = safeParseJSON(raw, null);
    if (typeof d === 'string') return defaultDraft();
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

// Ensure draft exists immediately after loadDraft is defined
draft = loadDraft();

function ensureDraft() {
  if (!draft) draft = loadDraft();
  // Ensure shape
  if (!draft || typeof draft !== 'object') draft = defaultDraft();
  if (!Array.isArray(draft.scope)) draft.scope = [];
  if (!Array.isArray(draft.aiOnlySections)) draft.aiOnlySections = [];
  if (typeof draft.htmlOverride !== 'string') draft.htmlOverride = '';
  if (!draft.mode) draft.mode = 'ats';
  if (!draft.template) draft.template = 'classic';
  if (typeof draft.jd !== 'string') draft.jd = '';
  return draft;
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
  // Ensure draft is available and normalized
  const d = ensureDraft();
  const label = document.createElement("label");
  label.style.cssText =
    "margin:0; cursor:pointer; display:flex; align-items:center; gap:6px; width:100%;";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = `scope-${slugify(labelText)}`;
  input.value = labelText;

  // default ON only when draft.scope saved OR profile has content for this title
  const hasSavedScope = Array.isArray(d.scope) && d.scope.length > 0;
  const profileHas = typeof labelText === 'string' && profileHasContentForTitle(labelText);
  input.checked = hasSavedScope ? d.scope.map(x => String(x).toLowerCase()).includes(String(labelText).toLowerCase()) : !!profileHas;

  input.addEventListener("change", () => {
    d.scope = getScopeFromUI();
    // changing scope invalidates html override (because sections may hide/show)
    d.htmlOverride = "";
    saveDraft(d);
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
  const d = ensureDraft();
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
  const aiOnlyTitles = (d.aiOnlySections || []).map((s) => s?.title).filter(Boolean);

  const allTitles = uniqByLower([...standards, ...profileTitles, ...aiOnlyTitles]);

  allTitles.forEach((t) => addCheckbox(list, titleCase(t)));

  // If draft.scope exists, apply it
  if (Array.isArray(d.scope) && d.scope.length > 0) {
    setScopeToUI(d.scope);
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
  // If history item includes html, store it in draft.htmlOverride (not raw key)
  if (item && item.htmlSnapshot) draft.htmlOverride = String(item.htmlSnapshot || '');
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
  ensureDraft();
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

// Remove legacy draft-only Generate handler (it conflicts with the server Generate wiring below).
// The server Generate wiring will handle draft persistence + rendering.

// --------------------
// Generate (server integration)
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
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (__) {
      json = null;
    }
    if (!res.ok) {
      const error = new Error(json?.error || `Generate API error: ${res.status}`);
      error.status = res.status;
      error.data = json;
      error.rawText = text;
      throw error;
    }
    if (!json) {
      throw new Error('Empty server response');
    }
    return json;
  } catch (err) {
    console.error('callGenerateAPI error:', err);
    throw err;
  }
}

const FREE_TIER_COOLDOWN_KEY = 'geminiFreeTierCooldownUntil';
const FREE_TIER_MESSAGE = 'Free daily limit reached. Try again after 1:30 PM IST.';

function getNextFreeTierResetTimestamp() {
  const now = new Date();
  const reset = new Date(now);
  reset.setUTCHours(8, 0, 0, 0); // 08:00 UTC (midnight Pacific)
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset.getTime();
}

function getStoredFreeTierCooldown() {
  if (typeof localStorage === 'undefined') return 0;
  const raw = localStorage.getItem(FREE_TIER_COOLDOWN_KEY);
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

function isFreeTierCooldownActive() {
  return getStoredFreeTierCooldown() > Date.now();
}

function applyFreeTierCooldownState(btn) {
  const active = isFreeTierCooldownActive();
  if (btn) {
    btn.disabled = active;
    btn.dataset.freeTierCooldown = active ? '1' : '0';
  }
}

function triggerFreeTierCooldown(btn) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(FREE_TIER_COOLDOWN_KEY, String(getNextFreeTierResetTimestamp()));
  }
  if (btn) {
    btn.disabled = true;
    btn.dataset.freeTierCooldown = '1';
  }
  return getStoredFreeTierCooldown();
}

// Wire the existing Generate button to call the server and render returned HTML
(function wireGenerateButton() {
  const btn = $('btnGen');
  if (!btn) return;

  // Prevent double-binding if this module is evaluated twice.
  if (btn.__serverGenWired) return;
  btn.__serverGenWired = true;

  applyFreeTierCooldownState(btn);
  setInterval(() => applyFreeTierCooldownState(btn), 60000);

  btn.addEventListener('click', async (e) => {
    if (isFreeTierCooldownActive()) {
      setStatus(FREE_TIER_MESSAGE, 'err');
      showToast(FREE_TIER_MESSAGE, 'warn');
      return;
    }
    try {
      e.preventDefault();
      const jd = $('jd')?.value || '';
      const mode = getActive('modes', 'data-mode') || 'ats';
      const template = getActive('templates', 'data-template') || 'classic';
      const scope = typeof getScopeFromUI === 'function' ? getScopeFromUI() : [];

      // Read latest unlockedProfile from sessionStorage at click time
      const rawNow = sessionStorage.getItem('unlockedProfile');
      if (!rawNow) {
        setStatus('Locked. Unlock first.', 'err');
        return;
      }
      const currentProfile = safeParseJSON(rawNow, null);
      if (!currentProfile) {
        setStatus('Profile parse failed.', 'err');
        return;
      }

      const jdNow = $('jd')?.value || '';
      if (!jdNow.trim()) {
        setStatus('Paste a job description first.', 'err');
        return;
      }

      // determine effective nickname (prefer unlockedNickname, then profile, then anon)
      const effectiveNickname = sessionStorage.getItem('unlockedNickname') || (currentProfile && (currentProfile.nickname || currentProfile.fullName)) || 'anon';

      setStatus('Generating via server...');
      const result = await callGenerateAPI({ profile: currentProfile, jd: jdNow, mode, template, scope, nickname: effectiveNickname });

      // Support multiple server response shapes: { generated: { html } }, { resume }, or legacy
      let serverHtml = null;
      try {
        if (!result) throw new Error('Empty server response');
        if (result.generated && result.generated.html) serverHtml = result.generated.html;
        else if (result.resume) serverHtml = result.resume;
        else if (result.html) serverHtml = result.html;
        else if (result.generatedHtml) serverHtml = result.generatedHtml;
        else if (result.page) serverHtml = result.page;
      } catch (e) {
        console.warn('Unable to parse server response', e, result);
      }

      if (serverHtml) {
        // Persist current UI -> draft settings
        draft.jd = jdNow;
        draft.mode = mode;
        draft.template = template;
        draft.scope = scope;

        draft.htmlOverride = String(serverHtml || '');
        saveDraft(draft);

        if (paperEl) {
          try {
            paperEl.innerHTML = draft.htmlOverride;
            try { paperEl.contentEditable = true; } catch (_) {}
            enableInlineEditing(paperEl);
          } catch (e) {
            paperEl.innerHTML = draft.htmlOverride;
            try { paperEl.contentEditable = true; } catch (_) {}
            enableInlineEditing(paperEl);
          }
        }

        updateEditBadge();
        setStatus('Generated (server)', 'ok');
        showToast('Generated', 'success', 1600);
      } else {
        // fallback
        setStatus('Server returned no usable HTML; using local fallback', 'err');
        showToast('Using local fallback', 'warn');

        const fallbackHtml = clientBuildFallback(currentProfile, jdNow, mode, template, scope, effectiveNickname);
        draft.htmlOverride = fallbackHtml;
        saveDraft(draft);
        if (paperEl) {
          paperEl.innerHTML = draft.htmlOverride;
          try { paperEl.contentEditable = true; } catch (_) {}
          enableInlineEditing(paperEl);
        }
        updateEditBadge();
      }
    } catch (err) {
      console.error('Generate click error:', err);
      if (err.status === 429 || (err.data && String(err.data.error || '').toLowerCase().includes('daily'))) {
        triggerFreeTierCooldown(btn);
        setStatus(FREE_TIER_MESSAGE, 'err');
        showToast(FREE_TIER_MESSAGE, 'warn');
        return;
      }
      setStatus('Generation failed', 'err');
      showToast('Generation failed', 'err');
    }
  });
})();

// Client-side fallback generator (mirrors server fallback) to keep UX working when API errors
function clientBuildFallback(profile = {}, jd = '', mode = 'ats', template = 'classic', scope = [], nickname) {
  const displayName = (profile && profile.fullName) || nickname || 'User';
  const jdSnippet = String(jd || '').slice(0, 400);
  const parts = [];
  parts.push(`<div class="generated-resume"><h2>Generated resume for ${escapeHtml(displayName)}</h2><p>Mode: ${escapeHtml(mode)}, Template: ${escapeHtml(template)}</p>`);
  const sections = (Array.isArray(scope) && scope.length) ? scope : ['Summary','Skills','Experience'];
  for (const sec of sections) {
    const key = String(sec || '').trim().toLowerCase();
    if (key === 'summary') {
      if (profile.summary) parts.push(`<section><h3>Summary</h3><p>${escapeHtml(profile.summary)}</p></section>`);
    } else if (key === 'skills') {
      const skills = Array.isArray(profile.skills) ? profile.skills : (profile.skills ? String(profile.skills).split(/\r?\n/) : []);
      if (skills && skills.length) { parts.push('<section><h3>Skills</h3><ul>'); skills.forEach(s=>parts.push(`<li>${escapeHtml(s)}</li>`)); parts.push('</ul></section>'); }
    } else if (key === 'education') {
      // Prefer structured education array, then educationEntries, then legacy fields
      const eds = Array.isArray(profile.education) ? profile.education : (Array.isArray(profile.educationEntries) ? profile.educationEntries : null);
      if (eds && eds.length) {
        parts.push('<section><h3>Education</h3>');
        eds.forEach(ed => {
          const inst = ed.institution || ed.school || ed.college || '';
          const degree = ed.degree || ed.program || ed.branch || '';
          const year = ed.year || ed.graduationYear || ed.endYear || ((ed.startYear && ed.endYear) ? `${ed.startYear} - ${ed.endYear}` : '');
          parts.push('<div class="edu-item">');
          if (inst) parts.push(`<strong>${escapeHtml(inst)}</strong>`);
          if (degree) parts.push(`<div>${escapeHtml(degree)}</div>`);
          if (year) parts.push(`<small>${escapeHtml(String(year))}</small>`);
          parts.push('</div>');
        });
        parts.push('</section>');
      } else if (profile.college) {
        // legacy single college field + optional branch/year
        parts.push('<section><h3>Education</h3>');
        parts.push('<div class="edu-item">');
        parts.push(`<strong>${escapeHtml(profile.college)}</strong>`);
        const branch = profile.branch || profile.collegeBranch || profile.degree || '';
        const year = profile.graduationYear || profile.year || '';
        if (branch) parts.push(`<div>${escapeHtml(branch)}</div>`);
        if (year) parts.push(`<small>${escapeHtml(String(year))}</small>`);
        parts.push('</div>');
        parts.push('</section>');
      }
    } else if (key.includes('experience') || key.includes('work') || key.includes('project')) {
      const secs = Array.isArray(profile.customSections) ? profile.customSections.filter(s=>s && (String(s.type||'')==='entries')) : [];
      if (secs.length) {
        secs.forEach(sg=>{ parts.push(`<section><h3>${escapeHtml(sg.title||'Experience')}</h3>`); (sg.items||[]).forEach(it=>{ parts.push(`<div><strong>${escapeHtml(it.key||'')}</strong>`); if (Array.isArray(it.bullets)&&it.bullets.length){ parts.push('<ul>'); it.bullets.forEach(b=>parts.push(`<li>${escapeHtml(b)}</li>`)); parts.push('</ul>'); } parts.push('</div>'); }); parts.push('</section>'); });
      }
    } else {
      // generic match
      const match = (Array.isArray(profile.customSections)?profile.customSections:[]).find(sc=>String(sc.title||'').trim().toLowerCase()===key);
      if (match) {
        parts.push(`<section><h3>${escapeHtml(match.title)}</h3>`);
        if (match.type==='entries') { (match.items||[]).forEach(it=>{ parts.push(`<div><strong>${escapeHtml(it.key||'')}</strong>`); if (Array.isArray(it.bullets)&&it.bullets.length){ parts.push('<ul>'); it.bullets.forEach(b=>parts.push(`<li>${escapeHtml(b)}</li>`)); parts.push('</ul>'); } parts.push('</div>'); }); }
        else { parts.push('<ul>'); (match.items||[]).forEach(it=>parts.push(`<li>${escapeHtml(String(it||''))}</li>`)); parts.push('</ul>'); }
        parts.push('</section>');
      }
    }
  }
  if (jdSnippet) parts.push(`<section><h3>Target role</h3><pre>${escapeHtml(jdSnippet)}</pre></section>`);
  parts.push('</div>');
  return parts.join('\n');
}

// Ensure server failures fall back to client render so users can still edit
// We add handling inside the existing catch of the Generate handler by augmenting the catch below.
// --------------------
// Add Save / Reset / Undo handlers to ensure buttons work reliably
(function attachEditButtons() {
  const btnSaveEdits = $('btnSaveEdits');
  if (btnSaveEdits) {
    btnSaveEdits.addEventListener('click', () => {
      if (!paperEl) return;
      const ok = confirm('Save your manual edits to this resume preview?');
      if (!ok) return;
      lastSavedHtmlOverride = draft.htmlOverride || null;
      const toSave = pendingHtmlOverride != null ? pendingHtmlOverride : (paperEl.innerHTML || '');
      draft.htmlOverride = String(toSave || '');
      saveDraft(draft);
      updateEditBadge();
      // Clear unsaved indicator + pending buffer
      pendingHtmlOverride = null;
      btnSaveEdits.classList.remove('unsaved');
      // Suppress autosave briefly so blur/input triggered by the click doesn't re-mark unsaved
      ignoreAutosaveUntil = Date.now() + 800;
      showToast('Saved edits', 'success');
    });
  }

  const btnResetEdits = $('btnResetEdits');
  if (btnResetEdits) {
    btnResetEdits.addEventListener('click', () => {
      const ok = confirm('Reset edits? This will discard your manual changes to the preview.');
      if (!ok) return;
      draft.htmlOverride = '';
      saveDraft(draft);
      updateEditBadge();
      renderWithDraft();
      // Clear unsaved indicator + pending buffer
      pendingHtmlOverride = null;
      if (btnSaveEdits) btnSaveEdits.classList.remove('unsaved');
      ignoreAutosaveUntil = Date.now() + 800;
      showToast('Edits reset', 'warn');
    });
  }

  const btnUndoEdits = $('btnUndoEdits');
  if (btnUndoEdits) {
    btnUndoEdits.addEventListener('click', () => {
      if (lastSavedHtmlOverride == null) return;
      const ok = confirm('Undo last saved edits and restore previous preview?');
      if (!ok) return;
      draft.htmlOverride = lastSavedHtmlOverride;
      lastSavedHtmlOverride = null;
      saveDraft(draft);
      updateEditBadge();
      renderWithDraft();
      // Clear unsaved indicator + pending buffer
      pendingHtmlOverride = null;
      if (btnSaveEdits) btnSaveEdits.classList.remove('unsaved');
      ignoreAutosaveUntil = Date.now() + 800;
      showToast('Undo applied', 'success');
    });
  }
})();

(function wireToolbarButtons() {
  const btnPdf = $('btnPdf');
  const btnEdit = $('btnEdit');
  const btnClear = $('btnClear');
  const btnClearDraft = $('btnClearDraft');
  const btnLogout = $('btnLogout');

  withButtonFeedback(btnPdf, downloadAsPdf, { busyText: 'Preparing…' });
  withButtonFeedback(btnEdit, async () => { goEditProfile(); }, { busyText: 'Opening…' });
  withButtonFeedback(btnClear, async () => { clearJdField(); }, { busyText: 'Clearing…' });
  withButtonFeedback(btnClearDraft, async () => { clearDraftAll(); }, { busyText: 'Clearing…' });
  withButtonFeedback(btnLogout, async () => { lockSession(); }, { busyText: 'Locking…' });
})();

// history-manager wiring (recent resumes)
// (selector helper already defined at top)

function normalizeNickname(n) {
  return String(n || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '');
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso || '';
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return iso || ''; }
}

async function fetchHistory(nickname, limit = 20) {
  const n = normalizeNickname(nickname);
  if (!n) return [];
  const resp = await fetch(`/api/history?nickname=${encodeURIComponent(n)}&limit=${encodeURIComponent(String(limit))}`, { cache: 'no-store' });
  if (!resp.ok) return [];
  const j = await resp.json().catch(() => null);
  return Array.isArray(j && j.items) ? j.items : [];
}

function renderHistoryList(items) {
  const host = document.getElementById('history-list');
  if (!host) return;
  host.innerHTML = '';
  if (!items || !items.length) {
    const empty = document.createElement('div');
    empty.className = 'note small';
    empty.textContent = 'No history yet. Generate once to see recent resumes here.';
    host.appendChild(empty);
    return;
  }

  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const left = document.createElement('div');
    left.textContent = String(it.title || '(untitled)');
    const right = document.createElement('div');
    right.className = 'hist-date';
    right.textContent = formatDate(it.createdAt);
    row.appendChild(left);
    row.appendChild(right);
    row.addEventListener('click', () => {
      // Load HTML into preview
      const paper = document.getElementById('paper');
      const html = String(it.html || '');
      if (paper) {
        paper.innerHTML = html;
        enableInlineEditing(paper);
      }
      applyHistoryHtmlToDraft(html);
    });
    host.appendChild(row);
  }
}

// Save a history HTML item into draft.json format (prevents raw HTML breaking loadDraft)
function applyHistoryHtmlToDraft(html) {
  const d = ensureDraft();
  d.htmlOverride = String(html || '');
  saveDraft(d);
  updateEditBadge();
  try {
    if (paperEl) {
      try { paperEl.contentEditable = true; } catch (_) {}
      enableInlineEditing(paperEl);
    }
  } catch (_) {}
}

// Single Recent Resumes wire-up (server history API)
async function wireRecentResumes() {
  const btn = document.getElementById('btnToggleHistory');
  const container = document.getElementById('history-container');
  if (!btn || !container) return;

  if (btn.__wiredHistory) return;
  btn.__wiredHistory = true;

  btn.addEventListener('click', async () => {
    const isOpen = container.style.display !== 'none' && container.style.display !== '';
    if (isOpen) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    const status = document.getElementById('status');
    if (status) status.textContent = 'Loading recent resumes…';
    const nick = normalizeNickname(sessionStorage.getItem('unlockedNickname') || '');
    const items = await fetchHistory(nick, 10);
    renderHistoryList(items);
    if (status) status.textContent = '';
  });
}

// Wire after DOM
document.addEventListener('DOMContentLoaded', wireRecentResumes);

// NOTE: Do not declare $qs/$id helpers again below; they are defined at top.

function setWhoBadge() {
  const el = document.getElementById('who');
  if (!el) return;
  const nick = (sessionStorage.getItem('unlockedNickname') || '').trim();
  if (!nick) {
    el.textContent = '';
    return;
  }
  el.textContent = `Logged in as: ${nick}`;
}

async function ensureProfileAndInitialRender() {
  // If resume-main already loaded profile elsewhere, don't fight it
  const paper = document.getElementById('paper');
  if (!paper) return;

  const raw = sessionStorage.getItem('unlockedProfile');
  const profile = raw ? safeParseJSON(raw, null) : null;
  if (!profile || typeof profile !== 'object') {
    // No unlocked session -> send to lobby
    const status = document.getElementById('status');
    if (status) status.textContent = 'Session locked. Please unlock again.';
    setTimeout(() => { window.location.href = './index.html'; }, 600);
    return;
  }

  setWhoBadge();

  // Render profile to paper if it's currently empty
  const isEmptyPaper = !paper.innerHTML || paper.innerHTML.trim().length < 10;
  if (isEmptyPaper) {
    try {
      const mod = await import('./resume-render.js');
      const d = loadDraft();
      const htmlOverride = (d && typeof d.htmlOverride === 'string') ? d.htmlOverride : '';
      mod.renderPaper({
        paperEl: paper,
        profile,
        jd: '',
        mode: 'ats',
        template: 'classic',
        scope: [],
        htmlOverride,
      });
    } catch (e) {
      console.warn('Initial render failed', e);
    }
  }
}

function ensureAiScopeChecklistUI() {
  const host = document.getElementById('ai-scope-list');
  if (!host) return;
  // If already populated by existing logic, do nothing
  if (host.children && host.children.length) return;

  const defaults = [
    'Summary',
    'Technical Skills',
    'Work Experience',
    'Projects',
    'Education',
    'Certifications',
    'Achievements',
    'Character Traits',
  ];

  host.innerHTML = '';
  for (const label of defaults) {
    const row = document.createElement('label');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '10px';
    row.style.cursor = 'pointer';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.scope = label;
    cb.style.width = '16px';
    cb.style.height = '16px';

    const text = document.createElement('span');
    text.textContent = label;

    row.appendChild(cb);
    row.appendChild(text);
    host.appendChild(row);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setWhoBadge();
  ensureAiScopeChecklistUI();
  ensureProfileAndInitialRender();
});

// public/js/resume/resume-main.js
// ...existing code...

 function enableInlineEditing(rootEl) {
   try {
     if (!rootEl) return;

    // Make the preview container editable (covers dynamic/unknown markup).
    try { rootEl.contentEditable = true; } catch (_) {}

    // If server returned .generated-resume, allow editing within it as well.
    const editableRoot = rootEl.querySelector('.generated-resume') || rootEl;
    try { editableRoot.contentEditable = true; } catch (_) {}

    editableRoot.querySelectorAll('p, li, div, span, h1, h2, h3').forEach((el) => {
      try { el.contentEditable = true; } catch (_) {}
    });
   } catch (_) {}
 }

// Ensure editability whenever the preview HTML changes (covers history loads, generate, reset, etc.)
try {
  const paperNode = document.getElementById('paper');
  if (paperNode && !paperNode.__editableObserver) {
    paperNode.__editableObserver = new MutationObserver(() => enableInlineEditing(paperNode));
    paperNode.__editableObserver.observe(paperNode, { childList: true, subtree: true });
  }
} catch (_) {}

// public/js/resume/resume-main.js
// ...existing code...

(async function patchGenerateFlowToPreferProfileRender() {
  const btn = $('btnGen');
  if (!btn) return;
  if (btn.__eduFixPatched) return;
  btn.__eduFixPatched = true;

  // If another handler already exists, we can't easily remove it without refs.
  // Instead, after any click, force a re-render from latest profile unless the server returned explicit HTML.
  btn.addEventListener('click', async () => {
    // Give other click handlers time to run first.
    setTimeout(async () => {
      try {
        const paper = document.getElementById('paper');
        if (!paper) return;

        const raw = sessionStorage.getItem('unlockedProfile');
        const profile = safeParseJSON(raw, null);
        if (!profile) return;

        // Reload draft (it may have been updated by Generate handler)
        const d = loadDraft();
        const explicitHtml = d && typeof d.htmlOverride === 'string' ? d.htmlOverride.trim() : '';

        // If htmlOverride exists, keep it. Otherwise render from profile so Education fields show.
        if (!explicitHtml) {
          const mod = await import('./resume-render.js');
          mod.renderPaper({
            paperEl: paper,
            profile,
            jd: d?.jd || $('jd')?.value || '',
            mode: d?.mode || getActive('modes', 'data-mode') || 'ats',
            template: d?.template || getActive('templates', 'data-template') || 'classic',
            scope: d?.scope || (typeof getScopeFromUI === 'function' ? getScopeFromUI() : []),
            htmlOverride: '',
          });
          enableInlineEditing(paper);
        }
      } catch (e) {
        console.warn('post-generate profile rerender failed', e);
      }
    }, 0);
  }, true);
})();
//# sourceMappingURL=resume-main.js.map

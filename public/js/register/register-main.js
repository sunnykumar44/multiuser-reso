import { encryptJSON, decryptJSON } from "../crypto-core.js";
import { createSectionsBuilder } from "./register-sections.js";
import { createEntriesSectionUI, readEntriesSectionUI } from "./register-entries.js";

const $ = (id) => document.getElementById(id);

const form = $("registerForm");
const status = $("status");

// ✅ SAFETY GUARD: Ensure critical DOM elements exist
if (!form) throw new Error("Critical Error: 'registerForm' element not found in HTML.");
if (!status) throw new Error("Critical Error: 'status' element not found in HTML.");

// --- Constants & Helpers for Defaults ---
const DEFAULT_SECTIONS = [
  { type: "entries", title: "Work Experience", placement: "section", items: [], keepEmpty: true },
  { type: "entries", title: "Projects", placement: "section", items: [], keepEmpty: true },
  { type: "bullets", title: "Certifications", placement: "section", items: [], keepEmpty: true },
  { type: "bullets", title: "Achievements", placement: "section", items: [], keepEmpty: true },
  { type: "bullets", title: "Character Traits", placement: "section", items: [], keepEmpty: true },
];

const normTitle = (t) =>
  String(t || "").trim().toLowerCase().replace(/\s+/g, " ");

// Checks DOM for existing sections and appends defaults if missing
function ensureDefaultSectionsInUI(sectionsBuilder) {
  const container = $("customSections");
  if (!container) return;

  const existing = [...container.children].map((card) => {
    const type = card.querySelector(".cs-type")?.value || "bullets";
    const placement = card.querySelector(".cs-placement")?.value || "section";
    const title = normTitle(card.querySelector(".cs-title")?.value || "");
    return `${type}|${placement}|${title}`;
  });

  const existingSet = new Set(existing);

  for (const s of DEFAULT_SECTIONS) {
    const key = `${s.type}|${s.placement}|${normTitle(s.title)}`;
    if (!existingSet.has(key)) {
      sectionsBuilder.addSection(s);
    }
  }
}

const normalizeNickname = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");

function setStatus(msg, kind = "ok") {
  status.className = "note " + (kind === "ok" ? "ok" : "err");
  status.textContent = msg;
}

function getKey(nickname) {
  return `user:${nickname}:blob`;
}

function setValue(id, value) {
  const el = $(id);
  if (!el) return;
  el.value = value ?? "";
}

// --- Edit Mode ---
const params = new URLSearchParams(location.search);
const isEditMode = params.get("edit") === "1";

function getEditNicknameFallback() {
  try {
    return JSON.parse(sessionStorage.getItem("unlockedProfile") || "{}")?.nickname || "";
  } catch {
    return "";
  }
}

// --- Initialization (Builder + Prefill) ---
let sectionsBuilder;

window.addEventListener("DOMContentLoaded", () => {
  const container = $("customSections");
  const addBtn = $("btnAddSection");

  if (!container) throw new Error("customSections not found");
  if (!addBtn) throw new Error("btnAddSection not found");

  // 1. Initialize Builder
  sectionsBuilder = createSectionsBuilder({
    containerEl: container,
    addButtonEl: addBtn,
    entriesHelpers: { createEntriesSectionUI, readEntriesSectionUI }
  });

  // ----- Preset buttons (Work/Projects) -----
  const btnAddWork = $("btnAddWork");
  const btnAddProjects = $("btnAddProjects");

  btnAddWork?.addEventListener("click", () => {
    sectionsBuilder.addSection({
      type: "entries",
      title: "Work Experience",
      placement: "section",
      items: [] 
    });
    setStatus("Added Work Experience section.", "ok");
  });

  btnAddProjects?.addEventListener("click", () => {
    sectionsBuilder.addSection({
      type: "entries",
      title: "Projects",
      placement: "section",
      items: []
    });
    setStatus("Added Projects section.", "ok");
  });

  // 2. New User: Auto-load defaults immediately
  if (!isEditMode) {
    sectionsBuilder.load(DEFAULT_SECTIONS);
  }

  // 3. Edit Mode Logic
  if (isEditMode) {
    try {
      const raw = sessionStorage.getItem("unlockedProfile");
      if (!raw) throw new Error("No unlocked profile in sessionStorage. Please unlock first.");
      const profile = JSON.parse(raw);

      setValue("nickname", profile.nickname || "");
      setValue("fullName", profile.fullName || "");
      setValue("college", profile.college || "");
      
      // --- Load Summary & Skills ---
      setValue("summary", profile.summary || "");
      setValue("skills", Array.isArray(profile.skills) ? profile.skills.join("\n") : "");

      setValue("phone", profile.phone || "");
      setValue("email", profile.email || "");
      setValue("linkedin", profile.linkedin || "");
      setValue("github", profile.github || "");

      // Load saved sections
      sectionsBuilder.load(profile.customSections || []);
      
      // ✅ Ensure defaults exist even if not in saved profile
      ensureDefaultSectionsInUI(sectionsBuilder);

      $("nickname").setAttribute("disabled", "disabled");
      $("btnSave").textContent = "Update Profile (Encrypt & Save)";
      setStatus(`Edit mode: updating "${profile.nickname}"`, "ok");
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Edit mode failed. Unlock first.", "err");
    }
  }

  // Populate existing nicknames list for convenience
  try {
    const existingContainer = document.getElementById('existing-nicknames');
    if (existingContainer) {
      existingContainer.innerHTML = '';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (!key.startsWith('user:') || !key.endsWith(':blob')) continue;
        const nick = key.slice(5, -5);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost magnetic';
        btn.style.padding = '6px 8px';
        btn.textContent = nick;
        btn.addEventListener('click', () => {
          // prefill nickname and switch to edit flow (without PIN)
          document.getElementById('nickname').value = nick;
        });

        // quick edit link (navigates to edit mode after setting sessionStorage)
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'ghost magnetic';
        editBtn.style.padding = '6px 8px';
        editBtn.style.marginLeft = '6px';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => {
          // set unlockedProfile from local blob (requires PIN to decrypt normally) — redirect to unlock flow instead
          // Instead, navigate to index (unlock) where user can unlock this nickname.
          window.location.href = './index.html';
        });

        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '6px';
        wrap.appendChild(btn);
        wrap.appendChild(editBtn);
        existingContainer.appendChild(wrap);
      }
    }
  } catch (e) { console.warn('Could not list existing nicknames', e); }
});

// --- Submit ---
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("Validating...");

  try {
    const nickname = normalizeNickname(
      isEditMode ? (getEditNicknameFallback() || $("nickname").value) : $("nickname").value
    );

    const pin = ($("pin").value || "").trim();

    if (!nickname) throw new Error("Nickname is required");
    // Enforce unique nickname for new registrations
    if (!isEditMode) {
      const existing = localStorage.getItem(getKey(nickname));
      if (existing) throw new Error('Nickname already exists. Choose a different nickname or unlock/edit the existing profile.');
    }
    if (!/^\d{6}$/.test(pin)) throw new Error("PIN must be exactly 6 digits");

    // Optional validations
    const phoneRaw = ($("phone").value || "").trim();
    const emailRaw = ($("email").value || "").trim();

    if (phoneRaw && !/^\d{10}$/.test(phoneRaw)) {
      throw new Error("Phone number must be exactly 10 digits");
    }
    if (emailRaw && !emailRaw.includes("@")) {
      throw new Error("Email must contain @");
    }

    // ✅ GUARD: Ensure builder is ready before collecting
    if (!sectionsBuilder) {
      throw new Error("Sections builder not initialized. Page might not be fully loaded.");
    }

    // --- Process Summary & Skills ---
    const summary = ($("summary")?.value || "").trim();
    const skills = ($("skills")?.value || "")
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);

    // Collect sections (collect() now respects keepEmpty flag from UI)
    const customSections = sectionsBuilder.collect();
  // customSections being saved

    const profile = {
      nickname,
      fullName: ($("fullName").value || "").trim(),
      summary,
      skills,
      college: ($("college").value || "").trim(),
      
      phone: phoneRaw,
      email: emailRaw,
      linkedin: ($("linkedin").value || "").trim(),
      github: ($("github").value || "").trim(),
      customSections,
      schema: "permanent_profile_v1",
    };

    // Confirmation
    const ok = window.confirm(
      isEditMode
        ? "Update your profile? This will overwrite your previous saved profile."
        : "Save this profile locally?"
    );
    if (!ok) {
      setStatus("Cancelled. Nothing was saved.", "err");
      return;
    }

    setStatus("Encrypting...");

    const blob = await encryptJSON({ pin, data: profile });
    localStorage.setItem(getKey(nickname), JSON.stringify(blob));

    // Cloud sync (encrypted blob only)
    try {
      await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, blob, createdAt: new Date().toISOString() }),
      });
    } catch (e) {
      // Non-fatal: local save still succeeded
      console.warn('Cloud sync failed (still saved locally)', e);
    }

    // Keep session in sync so resume page can immediately reflect changes
    try {
      const effectiveNickname = nickname || profile.fullName || 'anon';
      sessionStorage.setItem("unlockedProfile", JSON.stringify(profile));
      sessionStorage.setItem("unlockedNickname", effectiveNickname);
    } catch (e) {
      console.warn('could not set unlocked profile in sessionStorage', e);
    }

    // Remove any stale resume draft for this user so resume renders the updated profile
    try {
      const draftKey = `resumeDraft:${nickname || profile.fullName || 'anon'}`;
      sessionStorage.removeItem(draftKey);
    } catch (e) {
      console.warn('Could not remove resume draft key', e);
    }

    // encrypted blob created
    setStatus("Success! Saved locally.", "ok");

    // Redirect to resume so user sees the updated profile and sections immediately
    setTimeout(() => {
      window.location.href = "./resume.html";
    }, 350);
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Encryption failed", "err");
  }
});

// --- Test decrypt ---
$("btnTestDecrypt").addEventListener("click", async () => {
  try {
    const nickname = normalizeNickname(
      isEditMode ? (getEditNicknameFallback() || $("nickname").value) : $("nickname").value
    );
    const pin = ($("pin").value || "").trim();

    if (!nickname) throw new Error("Enter nickname first");
    if (!/^\d{6}$/.test(pin)) throw new Error("PIN must be exactly 6 digits");

    const raw = localStorage.getItem(getKey(nickname));
    if (!raw) throw new Error("No local blob found for this nickname");

    const blob = JSON.parse(raw);
    const data = await decryptJSON({ pin, blob });

  // decrypted profile loaded
    setStatus("Decryption OK. Check console for DECRYPTED_PROFILE.", "ok");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Decryption failed", "err");
  }
});

// --- Clear ---
$("btnClear").addEventListener("click", () => {
  const nick = isEditMode ? getEditNicknameFallback() : normalizeNickname($("nickname").value);
  if (!nick) {
    setStatus("Enter nickname (or unlock in edit mode) to clear its local blob.", "err");
    return;
  }
  localStorage.removeItem(getKey(nick));
  setStatus(`Cleared local blob for ${nick}.`, "ok");
});

// --- Back ---
$("btnBack").addEventListener("click", () => {
  window.location.href = isEditMode ? "./resume.html" : "./index.html";
});
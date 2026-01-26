// public/js/register/register-sections.js
// Custom Sections Builder with:
// - type: "bullets" | "links" | "entries"
// - placement: "section" | "header"

const DEFAULT_PLACEMENT = "section";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function normalizeLegacyCustomSections(customSections) {
  // Backward compatibility:
  // - Old format: { title, items: string[] } -> bullets section placement=section
  // - New format: { type, title, placement, items }
  if (!Array.isArray(customSections)) return [];

  return customSections.map((s) => {
    if (!s || typeof s !== "object") return null;

    // already new format
    if (s.type === "bullets" || s.type === "links" || s.type === "entries") {
      return {
        type: s.type,
        title: String(s.title || "").trim(),
        placement: (s.placement === "header" ? "header" : "section"),
        items: s.items ?? [],
      };
    }

    // legacy
    return {
      type: "bullets",
      title: String(s.title || "").trim(),
      placement: "section",
      items: Array.isArray(s.items) ? s.items : [],
    };
  }).filter(Boolean);
}

function sectionCardStyles(card) {
  card.style.border = "1px solid #2b3c69";
  card.style.borderRadius = "12px";
  card.style.padding = "10px";
  card.style.marginBottom = "10px";
  card.style.background = "rgba(255,255,255,.02)";
}

function smallGhostButton(btn) {
  btn.className = "ghost";
  btn.type = "button";
  btn.style.marginTop = "8px";
  btn.style.fontSize = "12px";
  btn.style.padding = "6px 10px";
}

function inputLike(node) {
  // your CSS targets input, textarea globally, so just ensure width/margins
  node.style.width = "100%";
  return node;
}

function buildLinksList(items = []) {
  const wrap = el("div");

  const list = el("div", {}, []);
  wrap.appendChild(list);

  const addRowBtn = el("button", {}, []);
  addRowBtn.textContent = "+ Add link";
  smallGhostButton(addRowBtn);

  function addRow(label = "", url = "") {
    const row = el("div", {}, []);
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr 1fr auto";
    row.style.gap = "8px";
    row.style.marginTop = "8px";

    const labelInput = inputLike(el("input", { placeholder: "Label (e.g. Portfolio)", value: label, class: "cs-link-label" }));
    const urlInput = inputLike(el("input", { placeholder: "URL (https://...)", value: url, class: "cs-link-url" }));

    const del = el("button", { class: "ghost", type: "button" });
    del.textContent = "✕";
    del.style.padding = "6px 10px";
    del.style.borderRadius = "10px";
    del.style.alignSelf = "center";
    del.addEventListener("click", () => row.remove());

    row.appendChild(labelInput);
    row.appendChild(urlInput);
    row.appendChild(del);
    list.appendChild(row);
  }

  addRowBtn.addEventListener("click", () => addRow("", ""));

  // seed initial
  if (items.length) {
    for (const it of items) addRow(it?.label || "", it?.url || "");
  } else {
    addRow("", "");
  }

  wrap.appendChild(addRowBtn);

  return { wrap, getItems: () => {
    const rows = [...list.querySelectorAll("div")];
    const out = [];
    for (const r of rows) {
      const label = (r.querySelector(".cs-link-label")?.value || "").trim();
      const url = (r.querySelector(".cs-link-url")?.value || "").trim();
      if (!label || !url) continue;
      out.push({ label, url });
    }
    return out;
  }};
}

function buildBulletsEditor(items = []) {
  const ta = el("textarea", { class: "cs-bullets", placeholder: "One bullet per line" });
  ta.style.minHeight = "90px";
  ta.value = (items || []).join("\n");
  return { node: ta, getItems: () =>
    ta.value.split("\n").map(s => s.trim()).filter(Boolean)
  };
}

// ✅ UPDATED: Accepts keepEmpty and stores it in dataset
function createSectionCard(
  { type = "bullets", title = "", placement = DEFAULT_PLACEMENT, items = [], keepEmpty = false } = {},
  entriesHelpers
) {
  const card = el("div");
  sectionCardStyles(card);

  // Keep section visible in UI even if empty (used for default sections)
  if (keepEmpty) card.dataset.keepEmpty = "1";

  // Header row: Title + Placement + Type
  const top = el("div");
  top.style.display = "grid";
  top.style.gridTemplateColumns = "1fr 160px 160px";
  top.style.gap = "8px";
  top.style.alignItems = "center";

  const titleInput = inputLike(el("input", {
    placeholder: "Section title (e.g. Work Experience)",
    value: title,
    class: "cs-title section-title"
  }));
  titleInput.style.fontWeight = "700";
  titleInput.style.background = "#162035";

  const placementSelect = el("select", { class: "cs-placement" });
  placementSelect.innerHTML = `
    <option value="section">Resume section</option>
    <option value="header">Header links</option>
  `;
  placementSelect.value = (placement === "header") ? "header" : "section";

  // Add Entries to dropdown
  const typeSelect = el("select", { class: "cs-type" });
  typeSelect.innerHTML = `
    <option value="bullets">Bullets</option>
    <option value="links">Links</option>
    <option value="entries">Entries (Role/Date)</option>
  `;
  typeSelect.value = (type === "links" || type === "entries") ? type : "bullets";

  top.appendChild(titleInput);
  top.appendChild(placementSelect);
  top.appendChild(typeSelect);

  const editorArea = el("div", { class: "cs-editor" });
  editorArea.style.marginTop = "8px";

  const footer = el("div");
  footer.style.display = "flex";
  footer.style.justifyContent = "space-between";
  footer.style.alignItems = "center";
  footer.style.gap = "10px";
  footer.style.marginTop = "8px";

  const hint = el("div");
  hint.style.fontSize = "12px";
  hint.style.color = "#94a3b8";
  hint.textContent = "";

  const removeBtn = el("button", { type: "button", class: "ghost" });
  removeBtn.textContent = "Remove Section";
  removeBtn.style.fontSize = "12px";
  removeBtn.style.padding = "6px 10px";

  footer.appendChild(hint);
  footer.appendChild(removeBtn);

  card.appendChild(top);
  card.appendChild(editorArea);
  card.appendChild(footer);

  // editors
  let bulletsEditor = null;
  let linksEditor = null;
  let entriesWrapper = null;

  function renderEditor() {
    editorArea.innerHTML = "";
    const t = typeSelect.value;
    hint.textContent = "";

    if (t === "links") {
      linksEditor = buildLinksList(Array.isArray(items) ? items : []);
      editorArea.appendChild(linksEditor.wrap);
      
      // Auto-switch to header placement
      if (placementSelect.value === "section") placementSelect.value = "header";
      hint.textContent = "Tip: Header links appear under your name.";
    } 
    else if (t === "entries") {
      // Render Entries UI
      if (entriesHelpers && entriesHelpers.createEntriesSectionUI) {
        entriesWrapper = el("div", { class: "cs-entries-wrapper" });
        const ui = entriesHelpers.createEntriesSectionUI({ entries: Array.isArray(items) ? items : [] });
        entriesWrapper.appendChild(ui);
        editorArea.appendChild(entriesWrapper);
      } else {
        editorArea.textContent = "Error: Entries helper not loaded.";
      }
      
      // Auto-switch to section placement
      if (placementSelect.value === "header") placementSelect.value = "section";
    }
    else {
      // Bullets
      bulletsEditor = buildBulletsEditor(Array.isArray(items) ? items : []);
      editorArea.appendChild(bulletsEditor.node);

      // Auto-switch to section placement
      if (placementSelect.value === "header") placementSelect.value = "section";
    }
  }

  // initial
  renderEditor();

  // on type change, reset items
  typeSelect.addEventListener("change", () => {
    items = [];
    renderEditor();
  });

  removeBtn.addEventListener("click", () => card.remove());

  return { card };
}

export function createSectionsBuilder({ containerEl, addButtonEl, entriesHelpers }) {
  if (!containerEl) throw new Error("containerEl is required");
  if (!addButtonEl) throw new Error("addButtonEl is required");

  // Exposed so other scripts can add sections
  function addSection(initial) {
    const cardAPI = createSectionCard(initial, entriesHelpers);
    containerEl.appendChild(cardAPI.card);
  }

  // Default button behavior (Custom Section)
  addButtonEl.addEventListener("click", () => addSection({ type: "bullets", title: "", placement: "section", items: [] }));

  function load(customSections) {
    containerEl.innerHTML = "";
    // Pass logic down
    const normalized = (customSections || []).map(s => {
      if(!s) return null;
      return { 
        type: s.type || "bullets", 
        title: s.title || "", 
        placement: s.placement || "section", 
        items: s.items || s.entries || [] // handle legacy alias
      };
    }).filter(Boolean);

    normalized.forEach(s => addSection(s));
  }

  // ✅ UPDATED collect to respect keepEmpty flag
  function collect() {
    const cards = [...containerEl.children];
    const out = [];
    
    for (const c of cards) {
      let title = (c.querySelector(".cs-title")?.value || "").trim();
      const type = (c.querySelector(".cs-type")?.value || "bullets");
      const placement = (c.querySelector(".cs-placement")?.value === "header") ? "header" : "section";
      const keepEmpty = c.dataset.keepEmpty === "1";

      // Auto-title defaults
      if (!title) {
        if (type === "links") title = "Links";
        else if (type === "entries") title = "Experience";
        else title = "Custom Section";
      }

      if (type === "links") {
        const rows = [...c.querySelectorAll(".cs-link-label")].map((labelInput) => {
          const row = labelInput.closest("div");
          const label = (labelInput.value || "").trim();
          const url = (row?.querySelector(".cs-link-url")?.value || "").trim();
          return { label, url };
        }).filter(x => x.label && x.url);

        if (rows.length) out.push({ type: "links", title, placement, items: rows });
      } 
      else if (type === "entries") {
        const wrapper = c.querySelector(".cs-entries-wrapper");
        let entries = [];

        if (wrapper && entriesHelpers && entriesHelpers.readEntriesSectionUI) {
          // Pass the specific container child to the reader
          entries = entriesHelpers.readEntriesSectionUI(wrapper.firstElementChild) || [];
        }

        if ((entries && entries.length) || keepEmpty) {
          out.push({ type: "entries", title, placement, items: entries });
        }
      } 
      else {
        // Bullets
        const ta = c.querySelector(".cs-bullets");
        const items = (ta?.value || "").split("\n").map(s => s.trim()).filter(Boolean);

        if (items.length || keepEmpty) {
          out.push({ type: "bullets", title, placement, items });
        }
      }
    }
    return out;
  }

  // RETURN with addSection exposed
  return { load, collect, addSection };
}

// Helper to extract header links for resume rendering
export function getHeaderLinks(customSections) {
  const normalized = normalizeLegacyCustomSections(customSections);
  const links = [];
  for (const sec of normalized) {
    if (sec.type !== "links") continue;
    if (sec.placement !== "header") continue;
    for (const it of (sec.items || [])) {
      const label = String(it?.label || "").trim();
      const url = String(it?.url || "").trim();
      if (!label || !url) continue;
      links.push({ label, url });
    }
  }
  return links;
}
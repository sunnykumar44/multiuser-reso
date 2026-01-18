function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "value") node.value = v;
    else if (k === "placeholder") node.placeholder = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }

  if (Array.isArray(children)) {
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === "string") {
        node.appendChild(document.createTextNode(c)); // ✅ safe
      } else {
        node.appendChild(c);
      }
    }
  }

  return node;
}


// -------------------------------------------------------------
// UI CREATOR: Renders ONLY the list of entries (not the section title)
// -------------------------------------------------------------
export function createEntriesSectionUI({ entries = [] }) {
  const container = el("div", { class: "cs-entries-container" });

  const list = el("div", { class: "cs-entries" });
  container.appendChild(list);

  const addBtn = el("button", { type: "button", class: "ghost cs-add-entry" }, ["+ Add Entry (Role/Project)"]);
  
  // Logic to add a single entry row
  function addEntryUI(initialData = { key: "", bullets: [] }) {
    const row = el("div", { class: "cs-entry" });

    // Key Input (Role, Date, Project Name)
    const keyInput = el("input", { 
      class: "cs-entry-key", 
      placeholder: "Role & Date (e.g. 'Senior Dev | 2023-Present')", 
      value: initialData.key || "" 
    });
    keyInput.style.width = "100%";
    keyInput.style.marginBottom = "6px";
    keyInput.style.fontWeight = "700";

    // Bullets Textarea
    const bulletsInput = el("textarea", { 
      class: "cs-entry-bullets", 
      placeholder: "• Built X using Y\n• Reduced latency by 50%" 
    });
    bulletsInput.style.width = "100%";
    bulletsInput.style.minHeight = "80px";
    bulletsInput.value = Array.isArray(initialData.bullets) ? initialData.bullets.join("\n") : "";

    // Remove Entry Button
    const delBtn = el("button", { type: "button", class: "ghost cs-entry-remove" }, ["Remove Entry"]);
    delBtn.onclick = () => row.remove();

    row.appendChild(keyInput);
    row.appendChild(bulletsInput);
    row.appendChild(delBtn);
    list.appendChild(row);
  }

  // Pre-fill existing entries
  if (entries.length > 0) {
    entries.forEach(ent => addEntryUI(ent));
  } else {
    // Add one empty by default if nothing exists
    addEntryUI();
  }

  addBtn.onclick = () => addEntryUI();
  container.appendChild(addBtn);

  return container;
}

// -------------------------------------------------------------
// DATA READER: Returns ONLY the array of items
// -------------------------------------------------------------
export function readEntriesSectionUI(container) {
  // Scrape the DOM to build the array
  if (!container) return [];
  const rows = [...container.querySelectorAll(".cs-entry")];
  
  const entries = rows.map(row => {
    const key = (row.querySelector(".cs-entry-key")?.value || "").trim();
    const bulletsRaw = (row.querySelector(".cs-entry-bullets")?.value || "");
    const bullets = bulletsRaw.split("\n").map(s => s.trim()).filter(Boolean);

    if (!key && bullets.length === 0) return null;
    return { key, bullets };
  }).filter(Boolean);

  return entries;
}
// public/js/lobby/lobby-menu.js
// Portal 3-dot menu helpers (fixed-position menu appended to body)

export function closeAllMenus() {
  document.querySelectorAll(".menu").forEach((m) => (m.style.display = "none"));
}

export function attachGlobalMenuClosers() {
  // Robust cleanup
  document.addEventListener("click", closeAllMenus);
  window.addEventListener("resize", closeAllMenus);
  window.addEventListener("scroll", closeAllMenus, true);
}

export function createPortalMenu({ nickname }) {
  const menu = document.createElement("div");
  menu.className = "menu";

  // Stop early interaction (prevents card click)
  menu.addEventListener("pointerdown", (e) => e.stopPropagation());
  menu.addEventListener("click", (e) => e.stopPropagation());

  const btnUnlock = document.createElement("button");
  btnUnlock.textContent = "Unlock";
  btnUnlock.onclick = () => {
    window.location.href = `./unlock.html?u=${encodeURIComponent(nickname)}&next=resume`;
  };

  const btnEdit = document.createElement("button");
  btnEdit.textContent = "Edit";
  btnEdit.onclick = () => {
    window.location.href = `./unlock.html?u=${encodeURIComponent(nickname)}&next=edit`;
  };

  const btnDelete = document.createElement("button");
  btnDelete.className = "danger";
  btnDelete.textContent = "Delete";
  btnDelete.onclick = () => {
    window.location.href = `./unlock.html?u=${encodeURIComponent(nickname)}&next=delete`;
  };

  menu.appendChild(btnUnlock);
  menu.appendChild(btnEdit);
  menu.appendChild(btnDelete);

  // Portal
  document.body.appendChild(menu);

  return menu;
}

export function toggleMenuAtButton({ menu, btnEl }) {
  // Close other menus
  document.querySelectorAll(".menu").forEach((m) => {
    if (m !== menu) m.style.display = "none";
  });

  const isHidden = menu.style.display === "none" || menu.style.display === "";
  if (!isHidden) {
    menu.style.display = "none";
    return;
  }

  // Show + position
  menu.style.display = "block";

  const r = btnEl.getBoundingClientRect();
  const menuW = 170;
  const menuH = 140; // approximate

  let x = Math.min(r.right - menuW, window.innerWidth - menuW - 10);
  let y = r.bottom + 8;

  // Flip up if going off-screen
  if (y + menuH > window.innerHeight - 10) {
    y = r.top - menuH - 8;
  }

  // Keep on screen
  x = Math.max(10, x);
  y = Math.max(10, y);

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

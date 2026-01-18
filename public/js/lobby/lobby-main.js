// public/js/lobby/lobby-main.js
import {
  attachGlobalMenuClosers,
  closeAllMenus,
  createPortalMenu,
  toggleMenuAtButton,
} from "./lobby-menu.js";

// Magnetic button effect + navigation
const btn = document.getElementById("createBtn");
const wrap = btn.parentElement;

wrap.addEventListener("mousemove", (e) => {
  const rect = wrap.getBoundingClientRect();
  const x = e.clientX - rect.left - rect.width / 2;
  const y = e.clientY - rect.top - rect.height / 2;
  btn.style.transform = `translate(${x * 0.15}px, ${y * 0.15}px)`;
});

wrap.addEventListener("mouseleave", () => {
  btn.style.transform = "translate(0,0)";
});

btn.addEventListener("click", () => {
  window.location.href = "./register.html";
});

// ===== Recent Users: auto-load from localStorage =====
const userList = document.getElementById("userList");
const countHint = document.getElementById("countHint");

function listUserNicknamesFromLocalStorage() {
  const keys = Object.keys(localStorage);
  const nicknames = [];

  for (const k of keys) {
    if (k.startsWith("user:") && k.endsWith(":blob")) {
      const nickname = k.slice(5, -5); // remove "user:" and ":blob"
      if (nickname) nicknames.push(nickname);
    }
  }

  // Sort newest-ish by createdAt if available
  nicknames.sort((a, b) => {
    try {
      const A = JSON.parse(localStorage.getItem(`user:${a}:blob`))?.createdAt || "";
      const B = JSON.parse(localStorage.getItem(`user:${b}:blob`))?.createdAt || "";
      return String(B).localeCompare(String(A));
    } catch {
      return 0;
    }
  });

  return nicknames;
}

function fmtWhen(nickname) {
  try {
    const blob = JSON.parse(localStorage.getItem(`user:${nickname}:blob`));
    const t = blob?.createdAt;
    if (!t) return "saved locally";
    return "saved: " + t.replace("T", " ").replace("Z", "");
  } catch {
    return "saved locally";
  }
}

attachGlobalMenuClosers();

function makeUserCard(nickname) {
  const li = document.createElement("li");
  li.className = "user-card";

  const left = document.createElement("div");
  left.className = "user-left";

  const name = document.createElement("div");
  name.className = "user-name";
  name.textContent = nickname;

  const meta = document.createElement("div");
  meta.className = "user-meta";
  meta.textContent = fmtWhen(nickname);

  left.appendChild(name);
  left.appendChild(meta);

  const dots = document.createElement("button");
  dots.className = "dots";
  dots.type = "button";
  dots.textContent = "⋯";

  // Stop early interaction
  dots.addEventListener("pointerdown", (e) => e.stopPropagation());

  const menu = createPortalMenu({ nickname });

  dots.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenuAtButton({ menu, btnEl: dots });
  });

  li.addEventListener("click", () => {
    closeAllMenus();
    window.location.href = `./unlock.html?u=${encodeURIComponent(nickname)}&next=resume`;
  });

  li.appendChild(left);
  li.appendChild(dots);

  return li;
}

function renderUsers() {
  userList.innerHTML = "";
  const nicknames = listUserNicknamesFromLocalStorage();

  countHint.textContent = nicknames.length ? `${nicknames.length} user(s)` : "No users yet";

  if (!nicknames.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.style.marginTop = "8px";
    empty.textContent = "No saved profiles yet. Click “Create your resume →”.";
    userList.appendChild(empty);
    return;
  }

  nicknames.forEach((n) => userList.appendChild(makeUserCard(n)));
}

renderUsers();

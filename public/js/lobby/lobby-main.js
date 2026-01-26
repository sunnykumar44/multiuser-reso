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

let __usersFetchController = null;
let __usersFetchPromise = null;
let __usersFetchCache = { at: 0, users: [] };
async function fetchUsersFromServer() {
  // Short cache to avoid multiple calls during quick re-renders
  const now = Date.now();
  if (__usersFetchCache.users && (now - __usersFetchCache.at) < 5000) {
    return __usersFetchCache.users;
  }

  // If a request is already in-flight, reuse it (prevents duplicate calls)
  if (__usersFetchPromise) return __usersFetchPromise;

  // Abort any previous request
  try { if (__usersFetchController) __usersFetchController.abort(); } catch (_) {}
  __usersFetchController = new AbortController();

  __usersFetchPromise = (async () => {
    try {
      const resp = await fetch('/api/users?limit=50', {
        cache: 'no-store',
        signal: __usersFetchController.signal,
      });
      if (!resp.ok) return [];
      const j = await resp.json();
      const users = Array.isArray(j && j.users) ? j.users : [];
      const out = users
        .map(u => ({
          nickname: String(u && u.nickname ? u.nickname : '').trim().toLowerCase(),
          updatedAt: String(u && u.updatedAt ? u.updatedAt : ''),
          lastTitle: String(u && u.lastTitle ? u.lastTitle : ''),
        }))
        .filter(u => u.nickname);
      __usersFetchCache = { at: Date.now(), users: out };
      return out;
    } catch (e) {
      // Abort is expected when navigating quickly
      return [];
    } finally {
      __usersFetchPromise = null;
    }
  })();

  return __usersFetchPromise;
}

function fmtWhenFromServer(u) {
  const t = u?.updatedAt;
  if (!t) return 'saved (cloud)';
  return 'saved: ' + String(t).replace('T', ' ').replace('Z', '');
}

function makeUserCardFromServer(user) {
  const nickname = user.nickname;
  const li = document.createElement('li');
  li.className = 'user-card';

  const left = document.createElement('div');
  left.className = 'user-left';

  const name = document.createElement('div');
  name.className = 'user-name';
  name.textContent = nickname;

  const meta = document.createElement('div');
  meta.className = 'user-meta';
  meta.textContent = fmtWhenFromServer(user);

  left.appendChild(name);
  left.appendChild(meta);

  const dots = document.createElement('button');
  dots.className = 'dots';
  dots.type = 'button';
  dots.textContent = '⋯';
  dots.addEventListener('pointerdown', (e) => e.stopPropagation());

  const menu = createPortalMenu({ nickname });
  dots.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenuAtButton({ menu, btnEl: dots });
  });

  li.addEventListener('click', () => {
    closeAllMenus();
    window.location.href = `./unlock.html?u=${encodeURIComponent(nickname)}&next=resume`;
  });

  li.appendChild(left);
  li.appendChild(dots);
  return li;
}

function renderUsers() {
  userList.innerHTML = "";
  const localNicknames = listUserNicknamesFromLocalStorage().map(n => String(n).trim().toLowerCase());
  // Render local first for instant UI
  localNicknames.forEach((n) => userList.appendChild(makeUserCard(n)));

  // Then merge cloud users
  (async () => {
    const cloud = await fetchUsersFromServer();
    const seen = new Set(localNicknames);
    const mergedCount = localNicknames.length + cloud.filter(u => !seen.has(u.nickname)).length;
    countHint.textContent = mergedCount ? `${mergedCount} user(s)` : 'No users yet';

    // Append cloud users not already shown
    for (const u of cloud) {
      if (seen.has(u.nickname)) continue;
      seen.add(u.nickname);
      userList.appendChild(makeUserCardFromServer(u));
    }

    if (!mergedCount) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.style.marginTop = '8px';
      empty.textContent = 'No saved profiles yet. Click “Create your resume →”.';
      userList.appendChild(empty);
    }
  })();

  // optimistic count for local-only while cloud loads
  countHint.textContent = localNicknames.length ? `${localNicknames.length} user(s)` : 'Loading…';
}

// Ensure we only render once per page load
if (!window.__LOBBY_RENDERED__) {
  window.__LOBBY_RENDERED__ = true;
  renderUsers();
}

// History manager for recent resume generations/downloads
// Stores recent items in localStorage under 'resumeHistory' and renders into
// elements with IDs 'history-container' and 'history-list'.

const HIST_KEY = 'resumeHistory';
let currentNickname = null;
let onSelectCallback = null;

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function readAll() {
  return safeParse(localStorage.getItem(HIST_KEY) || '[]', []);
}

function writeAll(arr) {
  localStorage.setItem(HIST_KEY, JSON.stringify(arr || []));
}

export function initHistoryManager(nickname, onSelect) {
  currentNickname = nickname;
  onSelectCallback = onSelect;
  render();
}

export function addHistoryItem({ jd = '', mode = '', template = '', name = '' } = {}) {
  if (!currentNickname) return;
  try {
    const all = readAll();
    const others = all.filter(x => x.nickname !== currentNickname);
    const own = all.filter(x => x.nickname === currentNickname) || [];

    const item = {
      id: Date.now(),
      date: new Date().toLocaleString(),
      jd: (jd || '').substring(0, 40) + (jd && jd.length > 40 ? '...' : ''),
      fullJd: jd || '',
      mode: mode || '',
      template: template || '',
      nickname: currentNickname,
      name: name || currentNickname
    };

    const newOwn = [item, ...own].slice(0, 8); // keep up to 8 per user
    const combined = [...newOwn, ...others];
    writeAll(combined);
    render();
  } catch (e) {
    // swallow
    console.warn('history add failed', e);
  }
}

export function getHistory() {
  if (!currentNickname) return [];
  const all = readAll();
  return all.filter(x => x.nickname === currentNickname);
}

export function clearHistoryForCurrent() {
  if (!currentNickname) return;
  const all = readAll();
  const others = all.filter(x => x.nickname !== currentNickname);
  writeAll(others);
  render();
}

export function render() {
  const container = document.getElementById('history-container');
  const list = document.getElementById('history-list');
  if (!container || !list) return;

  const items = getHistory();
  if (!items || items.length === 0) {
    container.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = '';

  // Add a small Clear All button at top for convenience
  const topRow = document.createElement('div');
  topRow.style.display = 'flex';
  topRow.style.justifyContent = 'flex-end';
  topRow.style.marginBottom = '6px';
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear All';
  clearBtn.className = 'ghost';
  clearBtn.style.padding = '6px 8px';
  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all recent generations for your account?')) return;
    clearHistoryForCurrent();
  });
  topRow.appendChild(clearBtn);
  list.appendChild(topRow);

  items.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'hist-item';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.gap = '8px';
    left.style.alignItems = 'center';

    const dspan = document.createElement('span');
    dspan.innerHTML = `<b>${item.name || item.nickname || ''}</b>: ${item.jd || ''}`;
    left.appendChild(dspan);

    const rspan = document.createElement('span');
    rspan.className = 'hist-date';
    rspan.textContent = item.date.split(',')[0];

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.title = 'Delete this recent resume';
    delBtn.innerHTML = '🗑';
    delBtn.style.marginLeft = '8px';
    delBtn.style.padding = '6px';
    delBtn.style.borderRadius = '6px';
    delBtn.className = 'ghost';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!confirm('Delete this recent resume?')) return;
      removeHistoryItem(item.id);
    });

    div.appendChild(left);
    div.appendChild(rspan);
    div.appendChild(delBtn);

    // Click (not on delete) loads the item
    div.addEventListener('click', () => {
      if (typeof onSelectCallback === 'function') onSelectCallback(item);
    });
    list.appendChild(div);
  });
}

export function removeHistoryItem(id) {
  if (!currentNickname) return;
  const all = readAll();
  const filtered = all.filter(x => x.id !== id);
  writeAll(filtered);
  render();
}

function downloadPdfFromPreview() {
  // ...existing code...
}

// Provide a safe selector helper if this file expects `$`.
// Do NOT redeclare if another `$` already exists.
if (typeof window !== 'undefined' && typeof window.$ !== 'function') {
  window.$ = (sel) => document.querySelector(sel);
}
// Global print CSS: only print the resume, hide full app UI
(function ensurePrintOnlyResumeCss() {
  const id = 'print-only-resume-css';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    @media print {
      body * { visibility: hidden !important; }
      .generated-resume, .generated-resume * { visibility: visible !important; }
      .generated-resume { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; }
    }
  `;
  document.head.appendChild(style);
})();

// Print only the resume content (prevents navbar/title/URL from appearing in the PDF)
function printResumeOnly() {
  const resumeEl = document.querySelector('.generated-resume') || document.querySelector('#resumePreview') || document.querySelector('#resume');
  if (!resumeEl) {
    window.print();
    return;
  }

  const html = resumeEl.outerHTML;
  const w = window.open('', '_blank', 'noopener,noreferrer');
  if (!w) {
    // Popup blocked; fallback to normal print
    window.print();
    return;
  }

  w.document.open();
  w.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Resume</title>
    <style>
      @page { margin: 12mm; }
      html, body { background: #fff; }
      /* Avoid printing browser-added page headers/footers where supported */
      /* Users must still disable 'Headers and Footers' in print dialog if their browser shows it */
    </style>
  </head>
  <body>${html}</body>
</html>`);
  w.document.close();

  // Give the new window a moment to render styles
  w.focus();
  setTimeout(() => {
    w.print();
    // Close after print (some browsers ignore this)
    setTimeout(() => { try { w.close(); } catch (_) {} }, 250);
  }, 250);
}

function showPrintHeadersFootersHint() {
  // Keep it minimal: only show once per session
  try {
    if (sessionStorage.getItem('print_hint_shown') === '1') return;
    sessionStorage.setItem('print_hint_shown', '1');
  } catch (_) {}
  // If your app already has a toast system, this is harmless; fallback to alert.
  const msg = 'Tip: If your PDF shows date/URL/title, open print settings and disable “Headers and footers”. This is a browser option.';
  if (typeof window.showToast === 'function') window.showToast(msg);
  else if (typeof window.toast === 'function') window.toast(msg);
  else setTimeout(() => alert(msg), 50);
}

// Force Download PDF button to print only resume
function wireDownloadPdfButtonToPrintOnly() {
  const btn = document.querySelector('#downloadPdfBtn, [data-action="download-pdf"], .btn-download-pdf');
  if (!btn) return;
  if (btn.__printOnlyWired) return;
  btn.__printOnlyWired = true;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showPrintHeadersFootersHint();
    printResumeOnly();
  }, true);
}

// Try wiring now and after DOM is ready
wireDownloadPdfButtonToPrintOnly();
document.addEventListener('DOMContentLoaded', wireDownloadPdfButtonToPrintOnly);

// ===== Recent Generations: prevent duplicates/blank titles =====
function normalizeHistoryTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function isBlankHistoryTitle(t) {
  const s = normalizeHistoryTitle(t);
  // blocks "sunnyz:" and other empty name-only titles
  if (!s) return true;
  if (/^[^:]{1,40}:\s*$/.test(s)) return true;
  return false;
}

function dedupeHistoryItems(items) {
  const out = [];
  const seen = new Set();
  for (const it of (items || [])) {
    const title = normalizeHistoryTitle(it?.title);
    if (isBlankHistoryTitle(title)) continue;
    const created = it?.createdAt ? String(it.createdAt) : '';
    const key = `${title.toLowerCase()}|${created}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.assign({}, it, { title }));
  }
  return out;
}

// Patch common history save/render hooks if present
try {
  const _origSave = window.saveToHistory;
  if (typeof _origSave === 'function') {
    window.saveToHistory = function patchedSaveToHistory(item) {
      if (isBlankHistoryTitle(item?.title)) return;
      return _origSave.call(this, item);
    };
  }
} catch (_) {}

try {
  const _origRender = window.renderHistory;
  if (typeof _origRender === 'function') {
    window.renderHistory = function patchedRenderHistory(list) {
      return _origRender.call(this, dedupeHistoryItems(list));
    };
  }
} catch (_) {}

// If history is stored in localStorage, de-dupe on load once
try {
  const keys = ['resume_history', 'history', 'recent_generations'];
  for (const k of keys) {
    const raw = localStorage.getItem(k);
    if (!raw) continue;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) continue;
    const cleaned = dedupeHistoryItems(arr);
    if (cleaned.length !== arr.length) localStorage.setItem(k, JSON.stringify(cleaned));
  }
} catch (_) {}
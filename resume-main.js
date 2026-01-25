function downloadPdfFromPreview() {
  // ...existing code...
}

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

// If there is an existing Download PDF handler, route it through printResumeOnly
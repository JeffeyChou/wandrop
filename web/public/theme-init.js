// Applied before first paint to avoid a theme flash (external file: CSP forbids inline scripts).
try {
  var t = localStorage.getItem('wd-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) { /* storage unavailable */ }

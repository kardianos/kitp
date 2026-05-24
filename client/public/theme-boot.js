// Theme bootstrap. Runs synchronously before the SPA bundle so a
// reload doesn't flash the light palette on dark-mode users. Lives
// in client/public/ so Vite copies it verbatim to dist/; index.html
// references it via <script src="/theme-boot.js"></script>. Kept
// inline-equivalent (no module imports) so the file stays a single
// tiny payload.
//
// Mirrors the logic in src/shell/theme.svelte.ts — keep the two in
// sync. Pulled out of an inline <script> in index.html so the strict
// CSP can ship `script-src 'self'` without an `'unsafe-inline'` hole
// or per-build SHA hash.
(function () {
  try {
    var m = localStorage.getItem('kitp.theme');
    if (m !== 'light' && m !== 'dark') {
      m = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
        ? 'dark'
        : 'light';
    }
    if (m === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch (_) {
    // localStorage / matchMedia unavailable; default light.
  }
})();

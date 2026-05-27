// Build script — esbuild ONLY. No Vite, no other toolchain.
//
//   node build.mjs            self-contained production bundle -> dist/
//                             (index.html + app.js + styles.css, all assets
//                             inlined). Servable as-is via kitpd WEB_DIR=web/dist.
//   node build.mjs --serve    esbuild watch + esbuild's built-in static
//                             server (the "tiny static serve"); open the
//                             printed URL.
//
// esbuild strips TS types and bundles src/main.ts to one ESM file, and bundles
// styles.css (inlining its @import of web/design/tokens.css) to one CSS file.
// Type CHECKING is the job of `tsgo --noEmit` — the intentional emit/typecheck
// split documented in ARCHITECTURE.md §2.

import * as esbuild from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const serve = process.argv.includes('--serve');

/** @type {import('esbuild').BuildOptions} */
const common = {
  // Two entries: the TS app and the CSS. esbuild bundles the CSS @import
  // (./design/tokens.css) inline, so dist/styles.css is self-contained and
  // carries no runtime dependency on web/design/.
  entryPoints: { app: 'src/main.ts', styles: 'styles.css' },
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  sourcemap: true,
  outdir: 'dist',
  logLevel: 'info',
  // Vendored runtime deps (dompurify/marked) live as ESM under web/vendor/ and
  // are imported by relative path from src/util/markdown.ts
  // (../../vendor/dompurify.js, ../../vendor/marked.js). esbuild resolves and
  // bundles them out of the box — no import map or alias is required.
};

// Emit a self-contained dist/index.html. The source index.html references
// ./dist/app.js + ./styles.css (so `npm run dev` serving web/ works). In the
// shipped dist/ the bundle is served at GET / by kitpd with an SPA fallback:
// any deep route (e.g. /project/1/screen/kanban) is served the SAME index.html.
// RELATIVE asset paths would then resolve against the deep URL
// (→ /project/1/screen/app.js → the fallback returns index.html as "JS" → the
// module fails to parse → BLANK PAGE). So rewrite the asset refs to ABSOLUTE
// (`/app.js`, `/styles.css`), which resolve to the bundle root regardless of
// the current route depth.
async function writeDistIndex() {
  const src = await readFile('index.html', 'utf8');
  const out = src.replace('./dist/app.js', '/app.js').replace('./styles.css', '/styles.css');
  if (out === src) {
    throw new Error('build: index.html no longer references ./dist/app.js — update the rewrite');
  }
  await writeFile('dist/index.html', out);
}

if (serve) {
  const ctx = await esbuild.context(common);
  await ctx.watch();
  // esbuild's own static file server — serves web/ (so index.html + dist/).
  const { host, port } = await ctx.serve({ servedir: '.', host: '127.0.0.1' });
  console.log(`\nkitp web dev server: http://${host}:${port}/  (Ctrl-C to stop)`);
} else {
  await esbuild.build(common);
  await writeDistIndex();
  console.log('built self-contained dist/ (index.html, app.js, styles.css)');
}

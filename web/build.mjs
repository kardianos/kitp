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
import { readFile, writeFile, cp } from 'node:fs/promises';

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
  //
  // Absolute /assets/* url()s (the @font-face srcs in styles.css) are served
  // from the bundle root at runtime — copyAssets() ships the files — so
  // esbuild must leave them as-is rather than try to resolve them at build
  // time.
  external: ['/assets/*'],
};

// Emit a self-contained dist/index.html. The source index.html references
// ./dist/app.js + ./styles.css (so `npm run dev` serving web/ works). In the
// shipped dist/ the bundle is served by kitpd with an SPA fallback: any deep
// route (e.g. /project/1/screen/kanban) is served the SAME index.html. RELATIVE
// asset paths would then resolve against the deep URL (→ /project/1/screen/app.js
// → the fallback returns index.html as "JS" → the module fails to parse → BLANK
// PAGE). So rewrite the asset refs to the ABSOLUTE, content-hashed paths under
// /assets/ (`/assets/app-<hash>.js`, `/assets/styles-<hash>.css`) resolved from
// the build metafile — they resolve from the bundle root regardless of route
// depth, AND kitpd serves anything under /assets/ with a year-long `immutable`
// Cache-Control, so a redeploy (new hash) busts the cache without ever
// re-downloading unchanged bytes. See bundleHrefs.
async function writeDistIndex(appHref, cssHref) {
  const src = await readFile('index.html', 'utf8');
  if (!src.includes('./dist/app.js') || !src.includes('./styles.css')) {
    throw new Error('build: index.html no longer references ./dist/app.js + ./styles.css — update the rewrite');
  }
  const out = src.replace('./dist/app.js', appHref).replace('./styles.css', cssHref);
  await writeFile('dist/index.html', out);
}

// bundleHrefs reads the esbuild metafile and returns the absolute, root-relative
// URLs of the hashed JS + CSS entry outputs (e.g. `/assets/app-A1B2C3D4.js`).
// Each output records the `entryPoint` it came from, so we map back to the two
// entry names rather than pattern-matching filenames; sourcemaps (.map) are
// skipped. Throws if either entry can't be resolved (a build-shape change we'd
// want to fail loudly on rather than ship an index.html with dangling refs).
function bundleHrefs(metafile) {
  let appHref, cssHref;
  for (const [outPath, meta] of Object.entries(metafile.outputs)) {
    if (outPath.endsWith('.map')) continue;
    const href = '/' + outPath.replace(/^dist\//, ''); // dist/assets/app-HASH.js → /assets/app-HASH.js
    if (meta.entryPoint === 'src/main.ts') appHref = href;
    else if (meta.entryPoint === 'styles.css') cssHref = href;
  }
  if (!appHref || !cssHref) {
    throw new Error(`build: could not resolve hashed bundle outputs from metafile (app=${appHref}, css=${cssHref})`);
  }
  return { appHref, cssHref };
}

// Copy static icon assets (favicons, apple-touch, general-use PNGs) into the
// bundle so /assets/* resolves in the shipped dist/ exactly as it does under
// the dev server (which serves web/ directly). Referenced by absolute path in
// index.html's <head>.
async function copyAssets() {
  await cp('assets', 'dist/assets', { recursive: true });
}

if (serve) {
  // Dev: stable, UN-hashed names (dist/app.js, dist/styles.css) so the source
  // index.html's ./dist/app.js ref keeps resolving across watch rebuilds. No
  // content hashing here — that's a production-only cache-busting concern.
  const ctx = await esbuild.context(common);
  await ctx.watch();
  // esbuild's own static file server — serves web/ (so index.html + dist/).
  const { host, port } = await ctx.serve({ servedir: '.', host: '127.0.0.1' });
  console.log(`\nkitp web dev server: http://${host}:${port}/  (Ctrl-C to stop)`);
} else {
  // Production: content-hash the entry outputs under dist/assets/ so kitpd's
  // immutable /assets/ caching (see server/internal/api/api.go) applies and a
  // redeploy busts the cache via a new hash. metafile drives the index rewrite.
  const result = await esbuild.build({
    ...common,
    entryNames: 'assets/[name]-[hash]',
    metafile: true,
  });
  const { appHref, cssHref } = bundleHrefs(result.metafile);
  await writeDistIndex(appHref, cssHref);
  await copyAssets();
  console.log(`built self-contained dist/ (index.html, assets/, ${appHref}, ${cssHref})`);
}

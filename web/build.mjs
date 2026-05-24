// Build script — esbuild ONLY. No Vite, no other toolchain.
//
//   node build.mjs            production bundle -> dist/app.js (+ sourcemap)
//   node build.mjs --serve    esbuild watch + esbuild's built-in static
//                             server (the "tiny static serve"); open the
//                             printed URL.
//
// esbuild strips TS types and bundles src/main.ts to one ESM file. Type
// CHECKING is the job of `npm run typecheck` (tsc --noEmit) — the intentional
// emit/typecheck split documented in ARCHITECTURE.md §2.

import * as esbuild from 'esbuild';

const serve = process.argv.includes('--serve');

/** @type {import('esbuild').BuildOptions} */
const common = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  sourcemap: true,
  outfile: 'dist/app.js',
  logLevel: 'info',
  // Vendored runtime deps (dompurify/marked) will resolve from web/vendor/
  // via an import map / explicit alias when the Markdown control lands. None
  // are imported yet, so nothing extra is needed for the proof.
};

if (serve) {
  const ctx = await esbuild.context(common);
  await ctx.watch();
  // esbuild's own static file server — serves web/ (so index.html + dist/).
  const { host, port } = await ctx.serve({ servedir: '.', host: '127.0.0.1' });
  console.log(`\nkitp web dev server: http://${host}:${port}/  (Ctrl-C to stop)`);
} else {
  await esbuild.build(common);
  console.log('built dist/app.js');
}

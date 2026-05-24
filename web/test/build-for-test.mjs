// Compile the TS modules-under-test to ESM .mjs so `node --test` can import
// them without a TS loader. esbuild only — no ts-node, no loader hooks.
//
// We bundle each test entry so its relative `./foo.js` imports resolve. A
// jsdom-free DOM shim is injected for modules that touch `document` (the
// signal + dispatch + api cores don't; control/not-found do, but the tests
// here exercise the registry/factory which we drive with a minimal stub).

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Process-unique outdir: node --test runs each test FILE in a SEPARATE
// process, and they otherwise race writing the same .build/ dir (a test can
// import a half-written bundle -> "Dispatcher is not a constructor"). Keying
// the outdir on the pid removes any inter-process collision; the in-process
// memoization below handles multiple imports within one file.
const outdir = join(here, '.build', `p${process.pid}`);

let buildPromise = null;

export async function buildTestBundles() {
  if (buildPromise) return buildPromise;
  buildPromise = doBuild();
  return buildPromise;
}

async function doBuild() {
  // ONE bundle per barrel so the Control singleton + NotFound wiring are
  // shared. Separate per-module bundles would each get their own Control copy.
  //   core.js  — the framework core (signal/tree/dispatch/api/data/control/…).
  //   app.js   — core + the real screen controls (kanban/shell) for the
  //              vertical-slice tests. Tests that need both import app.js so
  //              they share the same Control singleton as the registered
  //              controls.
  await esbuild.build({
    entryPoints: {
      core: join(here, '..', 'src', 'core', 'index.ts'),
      app: join(here, '..', 'src', 'test-barrel.ts'),
    },
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    logLevel: 'warning',
  });
  return outdir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildTestBundles();
  console.log('test bundles built ->', outdir);
}

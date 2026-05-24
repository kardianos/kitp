/**
 * Core barrel — single import surface for the framework's core modules.
 *
 * Importing through one bundle guarantees a SINGLE shared `Control` class
 * (and thus one registry + one installed NotFound factory path). Importing
 * `control.ts` and `not-found.ts` as separate bundles would give each its own
 * copy of the class statics, and `Control._setNotFound` would never reach the
 * copy `Control.New` consults. The app's `main.ts` imports the modules
 * directly (esbuild dedupes within one bundle); tests import this barrel so
 * the same singleton guarantee holds in the test build.
 */

export * from './signal.js';
export * from './tree.js';
export * from './dispatch.js';
export * from './api.js';
export * from './data.js';
export * from './control.js';
export * from './hotkeys.js';
export * from './keyed-list.js';
export * from './virtual-list.js';
// Side-effecting last: installs the NotFound factory path onto the shared
// Control class exported above.
export { NotFound } from './not-found.js';

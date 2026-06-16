// Shared jsdom + esbuild setup for the anchored-UI primitive tests
// (popover / combobox / datepicker). These touch a REAL DOM and the vendored
// @floating-ui/dom bundle, which Node's built-ins don't satisfy, so — like the
// markdown test — we stand up jsdom (a TEST-ONLY devDependency, never bundled
// into dist).
//
// jsdom does not implement ResizeObserver / IntersectionObserver / layout, so:
//   - ResizeObserver is stubbed (tracks observe/disconnect so a test can assert
//     autoUpdate tore it down). It never auto-fires — irrelevant here, since
//     autoUpdate calls `update()` once synchronously regardless.
//   - IntersectionObserver is left undefined so floating-ui's autoUpdate skips
//     its layoutShift observer (one fewer thing to stub).
//   - getBoundingClientRect returns zeros (no layout); computePosition still
//     resolves — to (0,0) — which is all the lifecycle assertions need.
//   - scrollIntoView is stubbed to a no-op (Combobox calls it on the active row).

import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Tracks the live ResizeObserver stubs so a test can assert teardown. */
export const resizeObservers = [];

export function installUiDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;

  resizeObservers.length = 0;
  class StubResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = new Set();
      this.disconnected = false;
      resizeObservers.push(this);
    }
    observe(t) {
      this.observed.add(t);
    }
    unobserve(t) {
      this.observed.delete(t);
    }
    disconnect() {
      this.disconnected = true;
      this.observed.clear();
    }
  }
  window.ResizeObserver = StubResizeObserver;
  // Leave IntersectionObserver undefined -> autoUpdate skips layoutShift.
  delete window.IntersectionObserver;
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.ResizeObserver = window.ResizeObserver;
  // floating-ui's DOM utils reference these globals directly (isElement /
  // getWindow / getComputedStyle); expose jsdom's so the bundle resolves them.
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.ShadowRoot = window.ShadowRoot;
  globalThis.Window = window.Window;
  // Node ≥21 exposes globalThis.navigator as getter-only; plain assignment
  // throws. defineProperty replaces it on any Node version.
  Object.defineProperty(globalThis, 'navigator', {
    value: window.navigator,
    writable: true,
    configurable: true,
  });
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  return { window, StubResizeObserver };
}

let buildPromise = null;

/**
 * Bundle the UI primitives (popover/combobox/datepicker) + their core deps to
 * one ESM file for `node --test`. Process-unique outdir (node --test forks per
 * file) so parallel test files don't race the same .build dir.
 */
export function buildUiBundle() {
  if (buildPromise) return buildPromise;
  const outdir = join(here, '.build', `ui-p${process.pid}`);
  buildPromise = esbuild
    .build({
      entryPoints: { ui: join(here, '..', 'src', 'ui', 'ui-test-barrel.ts') },
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: ['node20'],
      logLevel: 'warning',
    })
    .then(() => outdir);
  return buildPromise;
}

/**
 * Drain the async work floating-ui schedules so its computePosition().then()
 * continuation (which reveals + positions the panel) has run. computePosition
 * is promise-based and chains several awaits internally; a macrotask turn after
 * a microtask flush settles the whole chain.
 */
export async function flushMicrotasks() {
  // A few macrotask turns: jsdom's getComputedStyle + floating-ui's chained
  // awaits settle within a handful of turns (empirically 2-3).
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Synthesize + dispatch a keydown on an element (or document). */
export function keydown(target, key) {
  const ev = new globalThis.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
}

/** Synthesize + dispatch a pointerdown on an element. */
export function pointerdown(target) {
  // jsdom lacks PointerEvent; a MouseEvent of type 'pointerdown' fires the same
  // listeners (capture-phase, by type string).
  const ev = new globalThis.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

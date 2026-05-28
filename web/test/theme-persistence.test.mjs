// Theme persistence: the chosen dark/light mode is remembered in localStorage
// and re-applied to <html data-theme> on the next load (applyStoredTheme runs
// at boot, ahead of mounting). CSP forbids a pre-paint inline script, so this
// deferred restore is the mechanism.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
const store = new Map();
before(async () => {
  installDomShim();
  // The shim has no localStorage; provide a minimal one over a Map.
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});
beforeEach(() => {
  store.clear();
  // Reset the document to the index.html default before each case.
  document.documentElement.setAttribute('data-theme', 'light');
});

const themeAttr = () => document.documentElement.getAttribute('data-theme');

test('a saved "dark" choice is re-applied to <html> on boot', () => {
  store.set('kitp.theme', 'dark');
  M.applyStoredTheme();
  assert.equal(themeAttr(), 'dark', 'dark restored from localStorage');
  // setTheme re-persists, so the choice survives the restore round-trip too.
  assert.equal(store.get('kitp.theme'), 'dark', 'choice stays persisted');
});

test('a saved "light" choice is re-applied to <html> on boot', () => {
  document.documentElement.setAttribute('data-theme', 'dark'); // pretend a stale dark
  store.set('kitp.theme', 'light');
  M.applyStoredTheme();
  assert.equal(themeAttr(), 'light', 'light restored from localStorage');
});

test('no saved choice leaves the document default untouched', () => {
  M.applyStoredTheme();
  assert.equal(themeAttr(), 'light', 'default (light) preserved when nothing stored');
  assert.equal(store.has('kitp.theme'), false, 'no write when there was no stored choice');
});

test('an invalid stored value is ignored (falls back to the default)', () => {
  store.set('kitp.theme', 'neon');
  M.applyStoredTheme();
  assert.equal(themeAttr(), 'light', 'garbage value ignored');
});

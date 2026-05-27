// focus-trap (#29): trap Tab within a container + restore focus on close.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom } from './ui-dom-setup.mjs';

let M;
before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});
beforeEach(() => document.body.replaceChildren());

function tab(el, shift = false) {
  el.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));
}

test('trapFocus wraps Tab / Shift+Tab at the boundary', () => {
  const c = document.createElement('div');
  const a = document.createElement('button');
  const b = document.createElement('button');
  c.append(a, b);
  document.body.append(c);
  const dispose = M.trapFocus(c);

  b.focus();
  tab(c); // Tab at last → first
  assert.equal(document.activeElement, a, 'Tab at last wraps to first');

  a.focus();
  tab(c, true); // Shift+Tab at first → last
  assert.equal(document.activeElement, b, 'Shift+Tab at first wraps to last');

  dispose();
});

test('trapFocus skips hidden focusables', () => {
  const c = document.createElement('div');
  const a = document.createElement('button');
  const hidden = document.createElement('button');
  hidden.style.display = 'none';
  const b = document.createElement('button');
  c.append(a, hidden, b);
  document.body.append(c);
  M.trapFocus(c);
  b.focus();
  tab(c); // last visible is b → wraps to a (hidden is skipped)
  assert.equal(document.activeElement, a, 'wrap skips the display:none button');
});

test('captureFocus restores focus to the prior element', () => {
  const outside = document.createElement('button');
  const inside = document.createElement('button');
  document.body.append(outside, inside);
  outside.focus();
  const restore = M.captureFocus();
  inside.focus();
  assert.equal(document.activeElement, inside);
  restore();
  assert.equal(document.activeElement, outside, 'restored to the captured opener');
});

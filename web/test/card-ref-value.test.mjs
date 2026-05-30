/**
 * CardRefValue — single-id ref-label render driven by a LoadState<string>
 * thunk (STRUCTURAL_PLAN items 2 + the refactor in the (2)/(3) retro).
 *
 * Tests pin the lifecycle contract:
 *   - Unset id → unset placeholder, classes reflect "unset".
 *   - Unset label state → '#id' fallback + pending class.
 *   - Pending label state → renders the value, still pending class.
 *   - Value label state → renders the value, resolved class.
 *   - Late transition → bindings repaint without re-mount.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerCardRefValue();
});

function ctx() {
  return { api: {}, tree: new M.TreeNode({}, []) };
}

function mountCRV(cfg) {
  const c = M.Control.New('CardRefValue', { type: 'CardRefValue', ...cfg }, ctx());
  c.mount(new FakeElement('div'));
  return c;
}

/* -------------------------------------------------------------------------- */

test('CardRefValue: null id renders the unset placeholder + the unset class', () => {
  const { Unset } = M;
  const c = mountCRV({ id: null, label: () => Unset });
  assert.equal(c.el.textContent, '—', 'default unset glyph');
  assert.equal(c.el.classList.contains('card-ref-value--unset'), true);
});

test('CardRefValue: Unset label state → "#id" + pending class', () => {
  const { Unset } = M;
  const c = mountCRV({ id: 99n, label: () => Unset });
  assert.equal(c.el.textContent, '#99', 'fallback when state is Unset');
  assert.equal(c.el.classList.contains('card-ref-value--pending'), true);
  assert.equal(c.el.classList.contains('card-ref-value--resolved'), false);
  assert.equal(c.el.dataset.cardRefState, 'unset');
});

test('CardRefValue: Value label state → label + resolved class + data-card-ref-resolved', () => {
  const { loaded } = M;
  const c = mountCRV({ id: 42n, label: () => loaded('Alice') });
  assert.equal(c.el.textContent, 'Alice');
  assert.equal(c.el.classList.contains('card-ref-value--resolved'), true);
  assert.equal(c.el.classList.contains('card-ref-value--pending'), false);
  assert.equal(c.el.dataset.cardRefId, '42');
  assert.equal(c.el.dataset.cardRefState, 'value');
  assert.equal(c.el.hasAttribute('data-card-ref-resolved'), true);
});

test('CardRefValue: late-arriving label REPAINTS reactively + flips the class', () => {
  const { signal, Unset, loaded, flushSync } = M;
  // The label store IS a signal — the thunk reads it and bindText
  // resubscribes; mirrors the panel-model.refLabel() pattern.
  const state = signal(Unset);
  const c = mountCRV({ id: 7n, label: () => state.get() });

  // Pending state → '#7'.
  assert.equal(c.el.textContent, '#7');
  assert.equal(c.el.dataset.cardRefState, 'unset');

  state.set(loaded('Frontend'));
  flushSync();
  assert.equal(c.el.textContent, 'Frontend', 'late-arriving label repaints');
  assert.equal(c.el.classList.contains('card-ref-value--resolved'), true);
  assert.equal(c.el.dataset.cardRefState, 'value');

  // id-tracking data attribute is stable across paints.
  assert.equal(c.el.dataset.cardRefId, '7');
});

test('CardRefValue: targetCardType + extraClass surface on the root', () => {
  const { loaded } = M;
  const c = mountCRV({
    id: 1n,
    label: () => loaded('X'),
    targetCardType: 'person',
    extraClass: 'grid__ref grid__ref--inline',
  });
  assert.equal(c.el.dataset.targetCardType, 'person');
  assert.equal(c.el.classList.contains('grid__ref'), true);
  assert.equal(c.el.classList.contains('grid__ref--inline'), true);
});

test('CardRefValue: destroy disposes the bindings', () => {
  const { signal, loaded, flushSync } = M;
  const state = signal(loaded('first'));
  const c = mountCRV({ id: 5n, label: () => state.get() });
  assert.equal(c.el.textContent, 'first');
  c.destroy();
  state.set(loaded('second'));
  flushSync();
  assert.equal(c.el.textContent, 'first', 'binding stopped on destroy');
});

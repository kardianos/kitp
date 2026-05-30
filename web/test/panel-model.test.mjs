/**
 * PanelModel — the typed signal store backing the TaskDetail attribute panel.
 *
 * These tests pin the lifecycle every attribute moves through (Unset →
 * Pending → Value, Pending → Error → Value) AND the ref-label lookup
 * surface.  Consumers (AttributeRow, CardRefValue) read through these
 * signals, so the lifecycle is the framework contract.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;

before(async () => {
  // The app bundle pulls in DOM-touching modules (markdown sanitizer, etc.).
  // Install the minimal shim so the import side-effects don't crash before
  // we get to the (pure) PanelModel under test.
  installDomShim();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

function makeModel() {
  return new M.PanelModel();
}

/* -------------------------------------------------------------------------- */
/* attr lifecycle.                                                              */
/* -------------------------------------------------------------------------- */

test('PanelModel.attr: never-seeded attribute reads as Unset', () => {
  const model = makeModel();
  assert.deepEqual(model.attr('title').peek(), { kind: 'unset' });
});

test('PanelModel.attr: same name returns the same signal across calls', () => {
  const model = makeModel();
  assert.equal(model.attr('title'), model.attr('title'));
});

test('PanelModel.seedAttr: meaningful → Value; null/empty → Unset', () => {
  const model = makeModel();
  model.seedAttr('title', 'Wire pickers');
  assert.deepEqual(model.attr('title').peek(), { kind: 'value', value: 'Wire pickers' });
  model.seedAttr('title', null);
  assert.deepEqual(model.attr('title').peek(), { kind: 'unset' });
  model.seedAttr('title', '');
  assert.deepEqual(model.attr('title').peek(), { kind: 'unset' });
  model.seedAttr('title', []);
  assert.deepEqual(model.attr('title').peek(), { kind: 'unset' });
});

test('PanelModel.beginCommit → confirmCommit moves Pending → Value', () => {
  const model = makeModel();
  model.seedAttr('title', 'old');
  model.beginCommit('title', 'new');
  assert.deepEqual(model.attr('title').peek(), { kind: 'pending', value: 'new' });
  model.confirmCommit('title');
  assert.deepEqual(model.attr('title').peek(), { kind: 'value', value: 'new' });
});

test('PanelModel.confirmCommit collapses to Unset when the pending value is empty', () => {
  const model = makeModel();
  model.seedAttr('title', 'x');
  model.beginCommit('title', null);
  model.confirmCommit('title');
  assert.deepEqual(
    model.attr('title').peek(),
    { kind: 'unset' },
    'a committed null/empty value lands as Unset (one consistent rule)',
  );
});

test('PanelModel.rejectCommit: state goes Error and carries the previous value + message', () => {
  const model = makeModel();
  model.seedAttr('title', 'prev');
  model.beginCommit('title', 'attempt');
  model.rejectCommit('title', 'prev', 'Failed to save.');
  const s = model.attr('title').peek();
  assert.equal(s.kind, 'error');
  assert.equal(s.value, 'prev', 'remembers the value to revert to');
  assert.equal(s.message, 'Failed to save.');
});

test('PanelModel.clearError: Error → Value (or Unset when there is no fallback)', () => {
  const model = makeModel();
  model.seedAttr('title', 'p');
  model.beginCommit('title', 'q');
  model.rejectCommit('title', 'p', 'no');
  model.clearError('title');
  assert.deepEqual(model.attr('title').peek(), { kind: 'value', value: 'p' });

  // No fallback (initial commit failed when there was no prior value).
  const model2 = makeModel();
  model2.beginCommit('title', 'first');
  model2.rejectCommit('title', undefined, 'no');
  model2.clearError('title');
  assert.deepEqual(model2.attr('title').peek(), { kind: 'unset' });
});

test('PanelModel.seedFromAttributes: bulk-seed an attributes record', () => {
  const model = makeModel();
  model.seedFromAttributes({ title: 'A', status: 42n, missing: null });
  assert.equal(model.attr('title').peek().kind, 'value');
  assert.equal(model.attr('status').peek().kind, 'value');
  assert.equal(model.attr('missing').peek().kind, 'unset');
});

/* -------------------------------------------------------------------------- */
/* ref labels.                                                                  */
/* -------------------------------------------------------------------------- */

test('PanelModel.refLabel: never-set is Unset, set → Value', () => {
  const model = makeModel();
  const sig = model.refLabel('person', 10n);
  assert.deepEqual(sig.peek(), { kind: 'unset' });
  model.setRefLabel('person', 10n, 'Alice');
  assert.deepEqual(sig.peek(), { kind: 'value', value: 'Alice' });
});

test('PanelModel.refLabel: same (target, id) returns the same signal across calls', () => {
  const model = makeModel();
  assert.equal(model.refLabel('person', 10n), model.refLabel('person', 10n));
  assert.notEqual(model.refLabel('person', 10n), model.refLabel('person', 11n));
  assert.notEqual(model.refLabel('person', 10n), model.refLabel('milestone', 10n));
});

test('PanelModel.setRefLabel: undefined/empty stays Unset (no collapse to Value("")) ', () => {
  const model = makeModel();
  model.setRefLabel('tag', 1n, undefined);
  assert.equal(model.refLabel('tag', 1n).peek().kind, 'unset');
  model.setRefLabel('tag', 1n, '');
  assert.equal(model.refLabel('tag', 1n).peek().kind, 'unset');
});

/* -------------------------------------------------------------------------- */
/* isMeaningful — the shared "empty?" predicate the panel uses everywhere.    */
/* -------------------------------------------------------------------------- */

test('isMeaningful: null/undefined/""/[] → false; everything else → true', () => {
  const { isMeaningful } = M;
  assert.equal(isMeaningful(null), false);
  assert.equal(isMeaningful(undefined), false);
  assert.equal(isMeaningful(''), false);
  assert.equal(isMeaningful([]), false);
  assert.equal(isMeaningful('x'), true);
  assert.equal(isMeaningful(0), true, '0 is a meaningful number');
  assert.equal(isMeaningful(false), true, 'false is a meaningful bool');
  assert.equal(isMeaningful([1n]), true);
});

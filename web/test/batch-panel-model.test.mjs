/**
 * BatchPanelModel — the typed signal store for multi-card attribute edits.
 *
 * Pins the fold (Unset / Value / Mixed) when seeding from a selection,
 * and the fan-out lifecycle (Pending → Value | Error with partial counts).
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;

before(async () => {
  installDomShim();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

function makeModel() {
  return new M.BatchPanelModel();
}

/* -------------------------------------------------------------------------- */
/* Selection bookkeeping.                                                     */
/* -------------------------------------------------------------------------- */

test('BatchPanelModel.setSelection: stores the selection + returns its size', () => {
  const model = makeModel();
  assert.equal(model.setSelection([1n, 2n, 3n]), 3);
  assert.deepEqual(model.selectedCards(), [1n, 2n, 3n]);
});

test('BatchPanelModel.attr: same name returns the same signal across calls', () => {
  const model = makeModel();
  assert.equal(model.attr('milestone_ref'), model.attr('milestone_ref'));
  assert.notEqual(model.attr('milestone_ref'), model.attr('status'));
});

/* -------------------------------------------------------------------------- */
/* Seeding fold.                                                              */
/* -------------------------------------------------------------------------- */

test('BatchPanelModel.seedAttrAcross: all empty → Unset', () => {
  const model = makeModel();
  model.seedAttrAcross('status', [null, '', undefined, []]);
  assert.deepEqual(model.attr('status').peek(), { kind: 'unset' });
});

test('BatchPanelModel.seedAttrAcross: all homogeneous → Value', () => {
  const model = makeModel();
  model.seedAttrAcross('milestone_ref', [42n, 42n, 42n]);
  assert.deepEqual(model.attr('milestone_ref').peek(), { kind: 'value', value: 42n });
});

test('BatchPanelModel.seedAttrAcross: bigint / digit-string / number collapse to the same canonical key', () => {
  const model = makeModel();
  // Mixed-encoding from the wire should still be recognised as homogeneous.
  model.seedAttrAcross('milestone_ref', [42n, '42', 42]);
  assert.equal(
    model.attr('milestone_ref').peek().kind,
    'value',
    '42n / "42" / 42 collapse — selection is NOT Mixed',
  );
});

test('BatchPanelModel.seedAttrAcross: disagreement → Mixed', () => {
  const model = makeModel();
  model.seedAttrAcross('status', [40n, 41n, 40n]);
  assert.deepEqual(model.attr('status').peek(), { kind: 'mixed' });
});

test('BatchPanelModel.seedAttrAcross: some empty + some set → Value (empties skipped)', () => {
  const model = makeModel();
  model.seedAttrAcross('milestone_ref', [null, 42n, undefined, 42n]);
  assert.deepEqual(model.attr('milestone_ref').peek(), { kind: 'value', value: 42n });
});

test('BatchPanelModel.seedFromTasks: bulk-seeds every named attribute', () => {
  const model = makeModel();
  const tasks = [
    { attributes: { title: 'A', milestone_ref: 10n, status: 1n } },
    { attributes: { title: 'B', milestone_ref: 10n, status: 2n } },
    { attributes: { title: 'C', milestone_ref: null, status: 1n } },
  ];
  model.seedFromTasks(['title', 'milestone_ref', 'status'], tasks);
  assert.equal(model.attr('title').peek().kind, 'mixed', 'titles disagree');
  assert.deepEqual(
    model.attr('milestone_ref').peek(),
    { kind: 'value', value: 10n },
    'milestone agrees (the null is folded out)',
  );
  assert.equal(model.attr('status').peek().kind, 'mixed', 'status disagrees');
});

/* -------------------------------------------------------------------------- */
/* Commit lifecycle.                                                          */
/* -------------------------------------------------------------------------- */

test('BatchPanelModel.beginCommit → Pending(v)', () => {
  const model = makeModel();
  model.seedAttrAcross('milestone_ref', [10n, 11n]);
  model.beginCommit('milestone_ref', 99n);
  assert.deepEqual(model.attr('milestone_ref').peek(), { kind: 'pending', value: 99n });
});

test('BatchPanelModel.settleCommit: every row OK → Value(applied)', () => {
  const model = makeModel();
  model.seedAttrAcross('milestone_ref', [10n, 11n]);
  model.beginCommit('milestone_ref', 99n);
  model.settleCommit('milestone_ref', 99n, null, { ok: 2, failed: [] });
  assert.deepEqual(model.attr('milestone_ref').peek(), { kind: 'value', value: 99n });
});

test('BatchPanelModel.settleCommit: all failed → Error with the previous fallback', () => {
  const model = makeModel();
  model.seedAttrAcross('milestone_ref', [10n, 10n]);
  model.beginCommit('milestone_ref', 99n);
  model.settleCommit(
    'milestone_ref',
    99n,
    10n,
    { ok: 0, failed: [
      { cardId: 1n, message: 'forbidden' },
      { cardId: 2n, message: 'forbidden' },
    ] },
  );
  const s = model.attr('milestone_ref').peek();
  assert.equal(s.kind, 'error');
  assert.ok(s.message.includes('No rows saved'));
  assert.equal(s.value, 10n, 'remembers the previous shared value');
});

test('BatchPanelModel.settleCommit: partial → Error with N of M summary', () => {
  const model = makeModel();
  model.beginCommit('milestone_ref', 99n);
  model.settleCommit(
    'milestone_ref',
    99n,
    10n,
    { ok: 5, failed: [
      { cardId: 6n, message: 'no auth' },
      { cardId: 7n, message: 'no auth' },
    ] },
  );
  const s = model.attr('milestone_ref').peek();
  assert.equal(s.kind, 'error');
  assert.ok(s.message.includes('5 of 7'));
  assert.ok(s.message.includes('2 failed'));
});

test('BatchPanelModel.settleCommit: appliedValue is empty → state lands as Unset (not Value(""))', () => {
  const model = makeModel();
  model.seedAttrAcross('milestone_ref', [10n, 10n]);
  model.beginCommit('milestone_ref', null);
  model.settleCommit('milestone_ref', null, 10n, { ok: 2, failed: [] });
  assert.deepEqual(model.attr('milestone_ref').peek(), { kind: 'unset' });
});

test('BatchPanelModel.clearError: Error → Value when there is a fallback', () => {
  const model = makeModel();
  model.beginCommit('milestone_ref', 99n);
  model.settleCommit('milestone_ref', 99n, 10n, { ok: 0, failed: [{ cardId: 1n, message: 'x' }] });
  assert.equal(model.attr('milestone_ref').peek().kind, 'error');
  model.clearError('milestone_ref');
  assert.deepEqual(model.attr('milestone_ref').peek(), { kind: 'value', value: 10n });
});

test('BatchPanelModel.clear: every attribute signal goes Unset', () => {
  const model = makeModel();
  model.seedAttrAcross('a', [1n, 1n]);
  model.seedAttrAcross('b', [1n, 2n]);
  model.clear();
  assert.equal(model.attr('a').peek().kind, 'unset');
  assert.equal(model.attr('b').peek().kind, 'unset');
});

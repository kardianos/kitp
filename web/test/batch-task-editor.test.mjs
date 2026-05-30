/**
 * BatchTaskEditor — the high-level intent control for "render the schema as
 * rows against a SELECTION of tasks; fan out each commit."
 *
 * Pins: the selection-size header text, the row-per-attr spawn, the
 * Mixed-aware row state, and the fan-out commit forwarding.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerCombobox();
  M.registerDatePicker();
  M.registerRefPicker();
  M.registerFieldEditor();
  M.registerCardRefValue();
  M.registerAttributeRow();
  M.registerBatchTaskEditor();
});

beforeEach(() => {
  document.body.replaceChildren();
});

function mountBatch(schema, model, selectionSize, onApply) {
  const tree = new M.TreeNode({}, []);
  const api = { callByName: () => {} };
  const ctx = { api, tree };
  const cfg = {
    type: 'BatchTaskEditor',
    schema,
    model,
    selectionSize,
    onApply,
  };
  const editor = M.Control.New('BatchTaskEditor', cfg, ctx);
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  return editor;
}

/* -------------------------------------------------------------------------- */

test('BatchTaskEditor: header text reactively follows selectionSize', async () => {
  const { signal, flushSync } = M;
  const size = signal(0);
  const model = new M.BatchPanelModel();
  const editor = mountBatch([], model, () => size.get(), () => {});
  await flushMicrotasks();
  const head = editor.el.querySelector('[data-batch-head]');
  assert.equal(head.textContent, 'No tasks selected.');

  size.set(1);
  flushSync();
  assert.equal(head.textContent, '1 task selected — changes apply to it.');

  size.set(7);
  flushSync();
  assert.equal(head.textContent, '7 tasks selected — changes apply to all of them.');
});

test('BatchTaskEditor: spawns one AttributeRow per schema entry', async () => {
  const model = new M.BatchPanelModel();
  const schema = [
    { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
    { name: 'assignee', label: 'Assignee', valueType: 'card_ref', targetCardType: 'person' },
  ];
  const editor = mountBatch(schema, model, () => 3, () => {});
  await flushMicrotasks();
  const rows = [...editor.el.querySelectorAll('[data-attr-row]')];
  assert.deepEqual(rows.map((r) => r.dataset.attrRow), ['milestone_ref', 'assignee']);
});

test('BatchTaskEditor: row state reflects Mixed when the selection disagrees', async () => {
  const model = new M.BatchPanelModel();
  const schema = [
    { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
  ];
  // Seed from a 3-task selection where milestones disagree.
  model.seedFromTasks(['milestone_ref'], [
    { attributes: { milestone_ref: 10n } },
    { attributes: { milestone_ref: 11n } },
    { attributes: { milestone_ref: 10n } },
  ]);
  const editor = mountBatch(schema, model, () => 3, () => {});
  await flushMicrotasks();
  const row = editor.el.querySelector('[data-attr-row="milestone_ref"]');
  assert.equal(row.getAttribute('data-attr-state'), 'mixed');
  const valueEl = row.querySelector('[data-attr-value]');
  assert.equal(valueEl.textContent, '[mixed]');
});

test('BatchTaskEditor: row commits forward to onApply(name, value) — including Unassign', async () => {
  const model = new M.BatchPanelModel();
  model.seedFromTasks(['milestone_ref'], [
    { attributes: { milestone_ref: 10n } },
    { attributes: { milestone_ref: 10n } },
  ]);
  const schema = [
    { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
  ];
  const applies = [];
  const editor = mountBatch(schema, model, () => 2, (name, value) => applies.push({ name, value }));
  await flushMicrotasks();
  // Clicking Unassign fires the fan-out — the parent dispatches; this test
  // just confirms the forwarding contract.
  const unassign = editor.el.querySelector('[data-attr-unassign]');
  unassign.click();
  assert.deepEqual(applies, [{ name: 'milestone_ref', value: null }]);
});

test('BatchTaskEditor: row reflects Pending then Value across a fan-out lifecycle', async () => {
  const { flushSync } = M;
  const model = new M.BatchPanelModel();
  model.seedFromTasks(['milestone_ref'], [
    { attributes: { milestone_ref: 10n } },
    { attributes: { milestone_ref: 10n } },
  ]);
  const schema = [
    { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
  ];
  const editor = mountBatch(schema, model, () => 2, () => {});
  await flushMicrotasks();
  const row = editor.el.querySelector('[data-attr-row="milestone_ref"]');
  assert.equal(row.getAttribute('data-attr-state'), 'value', 'starts homogeneous');

  // Simulate the parent driving the fan-out lifecycle through the model.
  model.beginCommit('milestone_ref', 99n);
  flushSync();
  assert.equal(row.getAttribute('data-attr-state'), 'pending', 'Pending during fan-out');

  model.settleCommit('milestone_ref', 99n, 10n, { ok: 2, failed: [] });
  flushSync();
  assert.equal(row.getAttribute('data-attr-state'), 'value', 'lands on Value when every row OK');
});

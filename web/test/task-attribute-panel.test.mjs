/**
 * TaskAttributePanel — the high-level intent control for "panel of attribute
 * rows for a single task, live-commit each change."
 *
 * Pinned: it spawns ONE AttributeRow per schema entry, wires their state /
 * labelFor / onCommit to the panel store + the dispatcher, and shows the
 * empty placeholder when there is no schema.  No commit policy knob; this
 * control IS the live-commit policy.  Sibling controls (NewTaskForm,
 * BatchTaskEditor) live next to it for the other policies.
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
  M.registerTaskAttributePanel();
});

beforeEach(() => {
  document.body.replaceChildren();
});

function mountTap(schema, panel, onCommit, forAttr) {
  const tree = new M.TreeNode({}, []);
  const api = { callByName: () => {} };
  const ctx = { api, tree };
  const cfg = { type: 'TaskAttributePanel', schema, panel, onCommit };
  if (forAttr) cfg.forAttr = forAttr;
  const tap = M.Control.New('TaskAttributePanel', cfg, ctx);
  const host = document.createElement('div');
  document.body.appendChild(host);
  tap.mount(host);
  return tap;
}

/* -------------------------------------------------------------------------- */

test('TaskAttributePanel: empty schema → empty-state placeholder', async () => {
  const panel = new M.PanelModel();
  const tap = mountTap([], panel, () => {});
  await flushMicrotasks();
  const empty = tap.el.querySelector('[data-attribute-panel-empty]');
  assert.ok(empty, 'empty placeholder rendered');
  assert.equal(empty.textContent, 'No attributes available.');
  assert.equal(tap.el.querySelector('[data-attr-row]'), null, 'no AttributeRows when schema is empty');
});

test('TaskAttributePanel: spawns one AttributeRow per schema entry', async () => {
  const panel = new M.PanelModel();
  panel.seedAttr('title', 'A');
  panel.seedAttr('status', 42n);
  const schema = [
    { name: 'title', label: 'Title', valueType: 'text' },
    { name: 'status', label: 'Status', valueType: 'card_ref', targetCardType: 'status' },
  ];
  const tap = mountTap(schema, panel, () => {});
  await flushMicrotasks();
  const rows = [...tap.el.querySelectorAll('[data-attr-row]')];
  assert.equal(rows.length, 2, 'one AttributeRow per schema entry');
  assert.deepEqual(rows.map((r) => r.dataset.attrRow), ['title', 'status']);
});

test('TaskAttributePanel: row state follows the panel model REACTIVELY', async () => {
  const { flushSync } = M;
  const panel = new M.PanelModel();
  panel.seedAttr('title', 'first');
  const schema = [{ name: 'title', label: 'Title', valueType: 'text' }];
  const tap = mountTap(schema, panel, () => {});
  await flushMicrotasks();

  const valueEl = tap.el.querySelector('[data-attr-value]');
  assert.equal(valueEl.textContent, 'first');

  // A panel-store update repaints the row — no panel-level rebuild needed.
  panel.seedAttr('title', 'second');
  flushSync();
  assert.equal(valueEl.textContent, 'second');

  // A pending state flips the row's data-attr-state hook.
  panel.beginCommit('title', 'third');
  flushSync();
  const row = tap.el.querySelector('[data-attr-row]');
  assert.equal(row.getAttribute('data-attr-state'), 'pending');
});

test('TaskAttributePanel: row commits forward to onCommit(name, value)', async () => {
  const panel = new M.PanelModel();
  panel.seedAttr('milestone_ref', 5n);
  const schema = [
    { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
  ];
  const commits = [];
  const tap = mountTap(schema, panel, (name, value) => commits.push({ name, value }));
  await flushMicrotasks();

  // Click Unassign — should fire onCommit('milestone_ref', null).
  const unassign = tap.el.querySelector('[data-attr-unassign]');
  unassign.click();
  assert.deepEqual(commits, [{ name: 'milestone_ref', value: null }]);
});

test('TaskAttributePanel: forAttr threads parentScopePath + pinnedOptions to the row', async () => {
  const panel = new M.PanelModel();
  panel.seedAttr('assignee', null);
  const schema = [
    { name: 'assignee', label: 'Assignee', valueType: 'card_ref', targetCardType: 'person' },
  ];
  const tap = mountTap(
    schema,
    panel,
    () => {},
    (attr) => ({
      parentScopePath: 'scope.projectId',
      pinnedOptions: attr.targetCardType === 'person' ? [{ value: 99n, label: 'Self' }] : [],
    }),
  );
  await flushMicrotasks();
  // The row IS spawned; we just verify the panel composed cleanly.  The
  // RefPicker self-pin behaviour is covered by the RefPicker's own tests.
  assert.ok(tap.el.querySelector('[data-attr-row="assignee"]'));
});

test('TaskAttributePanel: labelFor reads from PanelModel.refLabel for late-arriving names', async () => {
  const { flushSync } = M;
  const panel = new M.PanelModel();
  panel.seedAttr('milestone_ref', 10n);
  const schema = [
    { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
  ];
  const tap = mountTap(schema, panel, () => {});
  await flushMicrotasks();
  const valueEl = tap.el.querySelector('[data-attr-value]');
  // Before the label arrives, summary uses #id fallback.
  assert.equal(valueEl.textContent, '#10');

  panel.setRefLabel('milestone', 10n, 'M1');
  flushSync();
  assert.equal(valueEl.textContent, 'M1', 'late-arriving label repaints the row');
});

/**
 * NewTaskForm — the high-level intent control for "draft form against a
 * PanelModel, Save buttons commit the snapshot via onSubmit."
 *
 * Pins the deferred-commit semantic, the required-attr gate, the busy
 * thunk, and the multi-intent button row.  Uses the SAME AttributeRow /
 * FieldEditor primitives TaskAttributePanel uses — the difference is
 * the commit semantic, declared by being a different high-level control.
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
  M.registerNewTaskForm();
});

beforeEach(() => {
  document.body.replaceChildren();
});

function mountForm(schema, draft, onSubmit, extra = {}) {
  const tree = new M.TreeNode({}, []);
  const api = { callByName: () => {} };
  const ctx = { api, tree };
  const cfg = { type: 'NewTaskForm', schema, draft, onSubmit, ...extra };
  const form = M.Control.New('NewTaskForm', cfg, ctx);
  const host = document.createElement('div');
  document.body.appendChild(host);
  form.mount(host);
  return form;
}

/* -------------------------------------------------------------------------- */

test('NewTaskForm: spawns one AttributeRow per schema entry + a Save button', async () => {
  const draft = new M.PanelModel();
  const schema = [
    { name: 'title', label: 'Title', valueType: 'text' },
    { name: 'description', label: 'Description', valueType: 'text' },
  ];
  const form = mountForm(schema, draft, () => {});
  await flushMicrotasks();
  const rows = [...form.el.querySelectorAll('[data-attr-row]')];
  assert.equal(rows.length, 2);
  const save = form.el.querySelector('[data-new-task-form-submit="save"]');
  assert.ok(save, 'default intent is "save"');
});

test('NewTaskForm: Save button is DISABLED while the required attr ("title") is empty', async () => {
  const { flushSync } = M;
  const draft = new M.PanelModel();
  const schema = [{ name: 'title', label: 'Title', valueType: 'text' }];
  const form = mountForm(schema, draft, () => {});
  await flushMicrotasks();
  const save = form.el.querySelector('[data-new-task-form-submit="save"]');
  assert.equal(save.disabled, true, 'no title → disabled');

  draft.seedAttr('title', 'A new task');
  flushSync();
  assert.equal(save.disabled, false, 'title set → enabled');

  draft.seedAttr('title', null);
  flushSync();
  assert.equal(save.disabled, true, 'cleared → disabled again');
});

test('NewTaskForm: clicking Save dispatches the draft snapshot as a plain record', async () => {
  const draft = new M.PanelModel();
  draft.seedAttr('title', 'Hello');
  draft.seedAttr('milestone_ref', 42n);
  const schema = [
    { name: 'title', label: 'Title', valueType: 'text' },
    { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
  ];
  const submits = [];
  const form = mountForm(schema, draft, (attrs, intent) => submits.push({ attrs, intent }));
  await flushMicrotasks();
  form.el.querySelector('[data-new-task-form-submit="save"]').click();
  assert.equal(submits.length, 1);
  assert.equal(submits[0].intent, 'save');
  assert.deepEqual(submits[0].attrs, { title: 'Hello', milestone_ref: 42n });
});

test('NewTaskForm: Unset / null attrs are OMITTED from the submitted record', async () => {
  const draft = new M.PanelModel();
  draft.seedAttr('title', 'Hello');
  // description never seeded → state is Unset
  const schema = [
    { name: 'title', label: 'Title', valueType: 'text' },
    { name: 'description', label: 'Description', valueType: 'text' },
  ];
  const submits = [];
  const form = mountForm(schema, draft, (attrs, intent) => submits.push({ attrs, intent }));
  await flushMicrotasks();
  form.el.querySelector('[data-new-task-form-submit="save"]').click();
  assert.deepEqual(submits[0].attrs, { title: 'Hello' });
});

test('NewTaskForm: multi-intent button row renders Save + Save & Another + Save & Open', async () => {
  const draft = new M.PanelModel();
  draft.seedAttr('title', 'x');
  const schema = [{ name: 'title', label: 'Title', valueType: 'text' }];
  const intents = [];
  const form = mountForm(schema, draft, (_a, intent) => intents.push(intent), {
    intents: ['save', 'saveAnother', 'saveOpen'],
  });
  await flushMicrotasks();
  const btns = [...form.el.querySelectorAll('[data-new-task-form-submit]')];
  assert.deepEqual(btns.map((b) => b.dataset.newTaskFormSubmit), ['save', 'saveAnother', 'saveOpen']);
  for (const b of btns) b.click();
  assert.deepEqual(intents, ['save', 'saveAnother', 'saveOpen']);
});

test('NewTaskForm: busy thunk disables every submit button reactively', async () => {
  const { signal, flushSync } = M;
  const draft = new M.PanelModel();
  draft.seedAttr('title', 'x');
  const schema = [{ name: 'title', label: 'Title', valueType: 'text' }];
  const busy = signal(false);
  const form = mountForm(schema, draft, () => {}, {
    intents: ['save', 'saveAnother'],
    busy: () => busy.get(),
  });
  await flushMicrotasks();
  const save = form.el.querySelector('[data-new-task-form-submit="save"]');
  const another = form.el.querySelector('[data-new-task-form-submit="saveAnother"]');
  assert.equal(save.disabled, false);
  assert.equal(another.disabled, false);

  busy.set(true);
  flushSync();
  assert.equal(save.disabled, true, 'busy disables Save');
  assert.equal(another.disabled, true, 'busy disables Save & Another');
});

test('NewTaskForm: required="" disables the gate (e.g. for free-form drafts)', async () => {
  const draft = new M.PanelModel();
  const schema = [{ name: 'title', label: 'Title', valueType: 'text' }];
  const form = mountForm(schema, draft, () => {}, { required: '' });
  await flushMicrotasks();
  const save = form.el.querySelector('[data-new-task-form-submit="save"]');
  assert.equal(save.disabled, false, 'no gate → always enabled');
});

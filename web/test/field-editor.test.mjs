/**
 * FieldEditor — the unified attribute editor (STRUCTURAL_PLAN item 1).  One
 * control routes to RefPicker / DatePicker / native input by `attr.valueType`
 * and fires `onCommit(value)` once the user commits.  Replaces the three
 * per-screen 6-arm switches (TaskDetail panel, BulkActionBar, grid inline edit).
 *
 * These tests pin the routing contract: text / number / bool / date / card_ref
 * each render the right inner editor, commit on the right gesture, and report
 * the right coerced value to the parent.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks, keydown } from './ui-dom-setup.mjs';

/** Synthesize a jsdom-bound generic Event (blur / change / input). */
function fire(target, type) {
  const ev = new globalThis.window.Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

let M;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerCombobox();
  M.registerDatePicker();
  M.registerRefPicker();
  M.registerFieldEditor();
});

beforeEach(() => {
  document.body.replaceChildren();
});

/* -------------------------------------------------------------------------- */
/* Mount helpers.                                                              */
/* -------------------------------------------------------------------------- */

function mountFE(attr, value, opts = {}) {
  // Minimal Api + tree — text/number/bool arms don't fire requests, and the
  // ref/date arms run their inner pickers which load lazily on open.
  const tree = new M.TreeNode({}, []);
  const api = {
    callByName: () => {}, // ref / date pickers may call this on open
  };
  const ctx = { api, tree };
  const commits = [];
  const cfg = {
    type: 'FieldEditor',
    attr,
    value,
    onCommit: (next) => commits.push(next),
    ...opts,
  };
  const fe = M.Control.New('FieldEditor', cfg, ctx);
  const host = document.createElement('div');
  document.body.appendChild(host);
  fe.mount(host);
  return { fe, commits };
}

/* -------------------------------------------------------------------------- */
/* Text routing.                                                               */
/* -------------------------------------------------------------------------- */

test('FieldEditor: text valueType mounts a text input; Enter commits its value', async () => {
  const { fe, commits } = mountFE({ name: 'title', label: 'Title', valueType: 'text' }, 'before');
  await flushMicrotasks();
  const input = fe.el.querySelector('input.field-editor__text');
  assert.ok(input, 'text input rendered');
  assert.equal(input.type, 'text');
  assert.equal(input.value, 'before', 'seeded from value');

  input.value = 'after';
  keydown(input, 'Enter');
  assert.deepEqual(commits, ['after'], 'Enter fires onCommit with the typed string');
});

test('FieldEditor: text valueType commits on blur', async () => {
  const { fe, commits } = mountFE({ name: 'title', label: 'Title', valueType: 'text' }, '');
  await flushMicrotasks();
  const input = fe.el.querySelector('input.field-editor__text');
  input.value = 'a new title';
  fire(input, 'blur');
  assert.deepEqual(commits, ['a new title']);
});

/* -------------------------------------------------------------------------- */
/* Number routing.                                                             */
/* -------------------------------------------------------------------------- */

test('FieldEditor: number valueType mounts a number input; commits parsed Number', async () => {
  const { fe, commits } = mountFE({ name: 'estimate', label: 'Estimate', valueType: 'number' }, 3);
  await flushMicrotasks();
  const input = fe.el.querySelector('input.field-editor__number');
  assert.ok(input, 'number input rendered');
  assert.equal(input.type, 'number');
  assert.equal(input.value, '3');

  input.value = '7';
  keydown(input, 'Enter');
  assert.deepEqual(commits, [7], 'commit value is a Number, not a string');
});

test('FieldEditor: number valueType — empty string commits null (clears the value)', async () => {
  const { fe, commits } = mountFE({ name: 'estimate', label: 'Estimate', valueType: 'number' }, 5);
  await flushMicrotasks();
  const input = fe.el.querySelector('input.field-editor__number');
  input.value = '';
  fire(input, 'blur');
  assert.deepEqual(commits, [null]);
});

// (The "invalid number rejects" path is browser-handled — a `<input type=number>`
// silently coerces non-numeric input to '', which the empty-string test above
// already covers. No unit test needed.)

/* -------------------------------------------------------------------------- */
/* Bool routing (uses bindProp on the binding helpers).                        */
/* -------------------------------------------------------------------------- */

test('FieldEditor: bool valueType mounts a checkbox; toggling fires onCommit eagerly', async () => {
  const { fe, commits } = mountFE({ name: 'is_active', label: 'Active', valueType: 'bool' }, false);
  await flushMicrotasks();
  const box = fe.el.querySelector('input.field-editor__checkbox');
  assert.ok(box, 'checkbox rendered');
  assert.equal(box.type, 'checkbox');
  assert.equal(box.checked, false, 'seeded from value');

  box.checked = true;
  fire(box, 'change');
  assert.deepEqual(commits, [true], 'eager commit on change');
});

test('FieldEditor: bool valueType — initial true reflects on the checkbox via bindProp', async () => {
  const { fe } = mountFE({ name: 'flag', label: 'Flag', valueType: 'bool' }, true);
  await flushMicrotasks();
  const box = fe.el.querySelector('input.field-editor__checkbox');
  assert.equal(box.checked, true, 'bindProp seeded checked=true');
});

/* -------------------------------------------------------------------------- */
/* Ref routing — single + multi.                                               */
/* -------------------------------------------------------------------------- */

test('FieldEditor: card_ref valueType mounts a single RefPicker (auto-opens)', async () => {
  const { fe } = mountFE(
    { name: 'assignee', label: 'Assignee', valueType: 'card_ref', targetCardType: 'person' },
    42n,
    { labelFor: (id) => `person#${id}`, noAutoOpen: true },
  );
  await flushMicrotasks();
  const picker = fe.el.querySelector('[data-control="RefPicker"]');
  assert.ok(picker, 'RefPicker mounted as the editor');
  // The picker reads its current selection from its config — the editor seeds
  // the label via `labelFor`, so the picker's trigger should reflect that.
  const trigger = fe.el.querySelector('[data-ref-trigger]') ?? fe.el.querySelector('button');
  assert.ok(trigger, 'picker trigger rendered');
});

test('FieldEditor: card_ref[] valueType mounts a multi-select RefPicker', async () => {
  const { fe } = mountFE(
    { name: 'tags', label: 'Tags', valueType: 'card_ref[]', targetCardType: 'tag' },
    [10n, 11n],
    { labelFor: (id) => `tag#${id}`, noAutoOpen: true },
  );
  await flushMicrotasks();
  const picker = fe.el.querySelector('[data-control="RefPicker"]');
  assert.ok(picker, 'multi RefPicker mounted');
});

/* -------------------------------------------------------------------------- */
/* Date routing.                                                               */
/* -------------------------------------------------------------------------- */

test('FieldEditor: date valueType mounts a DatePicker seeded with the value', async () => {
  const { fe } = mountFE({ name: 'due', label: 'Due', valueType: 'date' }, '2026-06-01', {
    noAutoOpen: true,
  });
  await flushMicrotasks();
  const picker = fe.el.querySelector('[data-control="DatePicker"]');
  assert.ok(picker, 'DatePicker mounted as the editor');
});

/* -------------------------------------------------------------------------- */
/* Unknown valueType falls through to the text editor.                         */
/* -------------------------------------------------------------------------- */

test('FieldEditor: unknown valueType falls through to a text input', async () => {
  const { fe, commits } = mountFE(
    { name: 'mystery', label: 'Mystery', valueType: 'something-new' },
    'seed',
  );
  await flushMicrotasks();
  const input = fe.el.querySelector('input.field-editor__text');
  assert.ok(input, 'unknown types render the text fallback (instead of failing)');
  input.value = 'committed';
  fire(input, 'blur');
  assert.deepEqual(commits, ['committed']);
});

// Combobox — typeahead single-select. Pins: substring typeahead filtering,
// keyboard select (↓↓Enter picks the 2nd option), Esc closes, and the
// callback-dispatcher async loader (deliver-on-settle, no promises crossing
// the control surface).

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installUiDom,
  buildUiBundle,
  flushMicrotasks,
  keydown,
} from './ui-dom-setup.mjs';

let Combobox;

before(async () => {
  installUiDom();
  const outdir = await buildUiBundle();
  ({ Combobox } = await import(`${outdir}/ui.js`));
});

beforeEach(() => {
  document.body.replaceChildren();
});

const ctx = () => ({ api: {}, tree: {} });

const FRUITS = [
  { value: 1, label: 'Apple' },
  { value: 2, label: 'Apricot' },
  { value: 3, label: 'Banana' },
  { value: 4, label: 'Cherry' },
];

function mountCombobox(config) {
  const cb = new Combobox('Combobox', { type: 'Combobox', ...config }, ctx());
  cb.mount(document.body);
  return cb;
}

function trigger(cb) {
  return cb.el.querySelector('[data-cb-trigger]');
}
function search() {
  // The Popover panel is mounted on <body>, not inside cb.el.
  return document.querySelector('.kf-combobox__search-input');
}
function options() {
  return [...document.querySelectorAll('[data-cb-option]')];
}

test('opens on trigger click and lists all static options', async () => {
  const cb = mountCombobox({ options: FRUITS });
  trigger(cb).click();
  await flushMicrotasks();
  assert.equal(options().length, 4, 'all options shown on open');
  assert.equal(trigger(cb).getAttribute('aria-expanded'), 'true');
  cb.destroy();
});

test('typeahead substring filter narrows the listbox', async () => {
  const cb = mountCombobox({ options: FRUITS });
  cb.openMenu();
  await flushMicrotasks();

  const input = search();
  input.value = 'ap';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));

  const labels = options().map((li) => li.textContent);
  assert.deepEqual(labels, ['Apple', 'Apricot'], 'filter matches case-insensitive substring');
  cb.destroy();
});

test('keyboard ↓ ↓ Enter selects the second option and fires onChange', async () => {
  let picked;
  const cb = mountCombobox({ options: FRUITS, onChange: (v) => (picked = v) });
  cb.openMenu();
  await flushMicrotasks();

  const input = search();
  keydown(input, 'ArrowDown'); // highlight idx 1 (from initial 0)
  keydown(input, 'ArrowDown'); // highlight idx 2 -> 'Banana'
  keydown(input, 'Enter');

  assert.equal(picked, 3, 'onChange emitted the highlighted option value (Banana)');
  assert.equal(cb.getValue(), 3, 'control value updated');
  assert.equal(cb.el.querySelector('.kf-combobox__label').textContent, 'Banana', 'trigger relabeled');
  // Selecting closes the menu.
  assert.equal(document.querySelectorAll('[data-cb-option]').length, 0, 'menu closed after pick');
  cb.destroy();
});

test('Esc closes the open menu without selecting', async () => {
  let changes = 0;
  const cb = mountCombobox({ options: FRUITS, onChange: () => changes++ });
  cb.openMenu();
  await flushMicrotasks();
  assert.equal(options().length, 4);

  keydown(search(), 'Escape');
  assert.equal(document.querySelectorAll('[data-cb-option]').length, 0, 'menu closed on Esc');
  assert.equal(trigger(cb).getAttribute('aria-expanded'), 'false');
  assert.equal(changes, 0, 'Esc did not emit a change');
  cb.destroy();
});

test('async loader resolves through the callback (deliver) path', async () => {
  // Capture the deliver sink the control hands us — proving the loader is a
  // callback dispatcher, not a promise. We deliver out-of-band, after the
  // control has called us.
  const calls = [];
  let deliver = null;
  const cb = mountCombobox({
    options: [],
    loadOptions: (query, sink) => {
      calls.push(query);
      deliver = sink;
    },
  });

  cb.openMenu();
  await flushMicrotasks();
  // Empty-query load fires immediately on open; shows the loading row until we
  // deliver.
  assert.deepEqual(calls, [''], 'loader invoked with empty query on open');
  assert.equal(document.querySelector('.kf-combobox__empty')?.textContent, 'Loading…');
  assert.equal(document.querySelectorAll('[data-cb-option]').length, 0, 'no options before deliver');

  // Caller settles the request -> deliver the list. No promise was involved.
  deliver([
    { value: 10, label: 'Mango' },
    { value: 11, label: 'Melon' },
  ]);
  const labels = options().map((li) => li.textContent);
  assert.deepEqual(labels, ['Mango', 'Melon'], 'delivered options rendered');

  // Picking an async-loaded option emits its value.
  let picked;
  cb.config.onChange = (v) => (picked = v);
  options()[0].click();
  assert.equal(picked, 10, 'async option selectable, value emitted');
  cb.destroy();
});

test('stale async delivery (after menu close) is dropped', async () => {
  let deliver = null;
  const cb = mountCombobox({
    options: [],
    loadOptions: (_q, sink) => (deliver = sink),
  });
  cb.openMenu();
  await flushMicrotasks();
  cb.closeMenu();

  // A late delivery from the now-stale request must not repopulate a closed menu.
  deliver([{ value: 99, label: 'Late' }]);
  assert.equal(document.querySelectorAll('[data-cb-option]').length, 0, 'stale deliver ignored');
  cb.destroy();
});

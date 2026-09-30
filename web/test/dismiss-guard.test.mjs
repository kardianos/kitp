/**
 * Dismiss guard (ui/dismiss-guard.ts) + the shared Modal that composes it.
 *
 * The policy under test: a backdrop click never dismisses; × / Cancel / Esc
 * close straight away when nothing was entered, and otherwise show an inline
 * "Discard …?" prompt (Keep editing / Discard). An Esc a child control already
 * consumed (defaultPrevented) never dismisses the dialog.
 */

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

function click(el) {
  el.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function keydown(target, key) {
  const ev = new globalThis.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

/** A host (footer) with one ordinary child, plus a guard over a mutable dirty flag. */
function guardHarness() {
  const host = document.createElement('div');
  const submit = document.createElement('button');
  host.append(submit);
  const input = document.createElement('input');
  document.body.append(input, host);
  const state = { dirty: false, discarded: 0 };
  const guard = M.createDismissGuard({
    host,
    isDirty: () => state.dirty,
    onDiscard: () => state.discarded++,
    message: 'Discard this thing?',
  });
  return { host, input, state, guard };
}

const prompt = (host) => host.querySelector('[data-dismiss-guard]');

test('guard: a clean dialog dismisses immediately on request and escape', () => {
  for (const gesture of ['request', 'escape']) {
    const { host, state, guard } = guardHarness();
    guard[gesture]();
    assert.equal(state.discarded, 1, `${gesture}: discarded at once`);
    assert.equal(prompt(host), null, `${gesture}: no prompt`);
  }
});

test('guard: a dirty dialog prompts; Keep editing restores focus, Discard dismisses', () => {
  const { host, input, state, guard } = guardHarness();
  state.dirty = true;
  input.focus();

  guard.request();
  assert.equal(state.discarded, 0, 'not dismissed yet');
  assert.ok(prompt(host), 'prompt mounted in the host');
  assert.ok('dismissPrompt' in host.dataset, 'host flagged so CSS hides its other children');
  assert.equal(prompt(host).textContent.includes('Discard this thing?'), true, 'custom message');
  assert.equal(document.activeElement, host.querySelector('[data-dismiss-keep]'), 'focus on the safe choice');
  assert.equal(guard.prompting, true);

  click(host.querySelector('[data-dismiss-keep]'));
  assert.equal(prompt(host), null, 'Keep editing hid the prompt');
  assert.equal('dismissPrompt' in host.dataset, false);
  assert.equal(document.activeElement, input, 'focus returned to where the user was typing');
  assert.equal(state.discarded, 0);

  guard.request();
  click(host.querySelector('[data-dismiss-discard]'));
  assert.equal(state.discarded, 1, 'Discard dismissed');
  assert.equal(prompt(host), null);
});

test('guard: escape toggles — first shows the prompt, second backs out of it', () => {
  const { host, state, guard } = guardHarness();
  state.dirty = true;
  guard.escape();
  assert.ok(prompt(host), 'first Esc prompts');
  guard.escape();
  assert.equal(prompt(host), null, 'second Esc keeps editing');
  assert.equal(state.discarded, 0, 'Esc alone never discards dirty work');
});

test('guard: a repeated request while prompting keeps the prompt (no double dismiss)', () => {
  const { host, state, guard } = guardHarness();
  state.dirty = true;
  guard.request();
  guard.request();
  assert.ok(prompt(host));
  assert.equal(state.discarded, 0);
});

test('snapshotFields changes when any native field changes', () => {
  const root = document.createElement('div');
  const text = document.createElement('input');
  const check = document.createElement('input');
  check.type = 'checkbox';
  const sel = document.createElement('select');
  for (const v of ['a', 'b']) {
    const o = document.createElement('option');
    o.value = v;
    sel.append(o);
  }
  const area = document.createElement('textarea');
  root.append(text, check, sel, area);

  const cases = [
    ['text input', () => (text.value = 'x')],
    ['checkbox', () => (check.checked = true)],
    ['select', () => (sel.value = 'b')],
    ['textarea', () => (area.value = 'y')],
  ];
  for (const [name, mutate] of cases) {
    const before = M.snapshotFields(root);
    mutate();
    assert.notEqual(M.snapshotFields(root), before, `${name} change detected`);
  }
});

/* -------------------------------------------------------------------------- */
/* Modal composes the guard.                                                   */
/* -------------------------------------------------------------------------- */

function openModal() {
  const closes = { n: 0 };
  const modal = new M.Modal({ title: 'Edit', onClose: () => closes.n++ });
  const input = document.createElement('input');
  input.value = 'orig';
  modal.element.append(input);
  modal.open();
  const backdrop = document.querySelector('[data-modal-backdrop]');
  const panel = document.querySelector('[data-modal]');
  return { modal, input, closes, backdrop, panel };
}

test('Modal: a backdrop click never dismisses, even when clean', () => {
  const { modal, closes, backdrop } = openModal();
  click(backdrop);
  assert.equal(modal.isOpen, true, 'still open');
  assert.equal(closes.n, 0);
  modal.destroy();
});

test('Modal: × / Esc close a clean form at once, but prompt once a field changed', () => {
  for (const gesture of ['close', 'escape']) {
    const dismiss = (panel) =>
      gesture === 'close' ? click(panel.querySelector('[data-modal-close]')) : keydown(panel.querySelector('input'), 'Escape');

    const clean = openModal();
    dismiss(clean.panel);
    assert.equal(clean.modal.isOpen, false, `${gesture}: clean form closed`);
    assert.equal(clean.closes.n, 1, `${gesture}: onClose fired`);
    clean.modal.destroy();

    const dirty = openModal();
    dirty.input.value = 'edited';
    dismiss(dirty.panel);
    assert.equal(dirty.modal.isOpen, true, `${gesture}: dirty form stays open`);
    assert.ok(dirty.panel.querySelector('[data-dismiss-guard]'), `${gesture}: discard prompt shown`);
    click(dirty.panel.querySelector('[data-dismiss-discard]'));
    assert.equal(dirty.modal.isOpen, false, `${gesture}: Discard closed it`);
    assert.equal(dirty.closes.n, 1);
    dirty.modal.destroy();
  }
});

test('Modal: an Esc a child control consumed does not dismiss', () => {
  const { modal, input } = openModal();
  // Stand-in for a combobox / popover closing its own menu on Esc.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') e.preventDefault();
  });
  keydown(input, 'Escape');
  assert.equal(modal.isOpen, true, 'modal stayed open');
  modal.destroy();
});

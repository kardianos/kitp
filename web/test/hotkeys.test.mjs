/**
 * HotkeyController — the editable-element guard (#11) and fireInInputs.
 *
 * The invariant the task-detail edit chords (`e t` / `e d` / `e c`) rely on:
 * while focus is in a TEXTAREA / INPUT, a chord PREFIX (e.g. `e`, `g`) is NOT
 * captured and a bare single-key binding does NOT fire — the keystroke stays
 * literal so the user can type. Bindings flagged `fireInInputs` still fire.
 *
 * Runs on jsdom so we can dispatch real KeyboardEvents at a real <textarea> and
 * read `defaultPrevented` (the controller calls preventDefault only when it
 * acts on the key).
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

let fired;
/** A fake root control (duck-typed: the controller only walks `.parent` and
 *  reads `.hotkeys()` / `.type`). */
function fakeRoot() {
  return {
    type: 'Fake',
    parent: null,
    hotkeys: () => [
      { binding: 'g p', label: 'Go', run: () => fired.push('gp') },
      { binding: 'n', label: 'New', run: () => fired.push('n') },
      { binding: 'Mod+Enter', label: 'Save', fireInInputs: true, run: () => fired.push('save') },
    ],
  };
}

function mountController() {
  const root = M.signal(fakeRoot(), 'root');
  const active = M.signal(null, 'active');
  const hk = new M.HotkeyController({ root, active, target: document });
  const dispose = hk.start();
  return { dispose };
}

/** Dispatch a keydown at `target`; return whether the controller prevented it. */
function press(target, key, opts = {}) {
  const ev = new globalThis.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  target.dispatchEvent(ev);
  return ev.defaultPrevented;
}

beforeEach(() => {
  document.body.replaceChildren();
  fired = [];
});

test('chord prefix + single key fire OUTSIDE an editable element', () => {
  const { dispose } = mountController();
  // `g` is a chord prefix → captured (prevented); `p` completes `g p`.
  assert.equal(press(document.body, 'g'), true, 'g prefix captured on body');
  press(document.body, 'p');
  assert.deepEqual(fired, ['gp'], 'g p fired outside an input');

  // A bare single-key binding fires too.
  fired.length = 0;
  assert.equal(press(document.body, 'n'), true, 'n captured on body');
  assert.deepEqual(fired, ['n']);
  dispose();
});

test('chord prefix is NOT captured inside a textarea (stays literal)', () => {
  const { dispose } = mountController();
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  ta.focus();

  // `g` must NOT be captured (not prevented) so it types into the textarea…
  assert.equal(press(ta, 'g'), false, 'g not captured inside a textarea');
  // …and the follow-up key does not complete a chord.
  press(ta, 'p');
  assert.deepEqual(fired, [], 'no chord fired from inside the textarea');
  dispose();
});

test('bare single-key binding does NOT fire inside a textarea', () => {
  const { dispose } = mountController();
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  ta.focus();

  assert.equal(press(ta, 'n'), false, 'n not captured inside a textarea');
  assert.deepEqual(fired, [], 'single-key binding suppressed while typing');
  dispose();
});

test('snapshotFor lists a SPECIFIC scope regardless of the live active control', () => {
  // The help overlay snapshots the screen's scope even when the live active
  // control is the shell chrome (the topbar button the user clicked to open it).
  const root = { type: 'Root', parent: null, hotkeys: () => [{ binding: 'g p', label: 'Go', run() {} }] };
  const screen = { type: 'TaskDetail', parent: root, hotkeys: () => [{ binding: 'q', label: 'Back', run() {} }] };
  const rootSig = M.signal(root, 'root');
  const activeSig = M.signal(root, 'active'); // live active = root (e.g. topbar click)
  const hk = new M.HotkeyController({ root: rootSig, active: activeSig });

  // The LIVE snapshot (active = root) carries only the global key.
  assert.equal(hk.snapshot().has('q'), false, 'q absent from the live root-active snapshot');

  // snapshotFor(screen) lists the screen's keys + global, regardless of `active`.
  const snap = hk.snapshotFor(screen);
  assert.equal(snap.has('q'), true, 'snapshotFor includes the screen-scoped key');
  assert.equal(snap.has('g p'), true, 'and still includes the global key');

  // snapshotFor(null) degrades to the global tier only.
  assert.equal(hk.snapshotFor(null).has('q'), false, 'snapshotFor(null) is global-only');
});

test("the ACTIVE control's scoped chords go live (the active-tracking fix)", () => {
  // A leaf control (e.g. TaskDetail) whose parent chain reaches the root.
  const root = { type: 'Root', parent: null, hotkeys: () => [{ binding: 'g p', run: () => fired.push('gp') }] };
  const leaf = { type: 'Leaf', parent: root, hotkeys: () => [{ binding: 'e t', run: () => fired.push('et') }] };
  const rootSig = M.signal(root, 'root');
  const activeSig = M.signal(root, 'active'); // start with only the root active
  const hk = new M.HotkeyController({ root: rootSig, active: activeSig, target: document });
  const dispose = hk.start();

  // While only the root is active, the leaf's `e t` chord is NOT collected.
  press(document.body, 'e');
  press(document.body, 't');
  assert.deepEqual(fired, [], 'leaf chord inert when the leaf is not active');

  // Activate the leaf (what focus/route now does) → its `e t` chord fires.
  activeSig.set(leaf);
  press(document.body, 'e');
  press(document.body, 't');
  assert.deepEqual(fired, ['et'], 'leaf chord live once the control is active');
  dispose();
});

test('a fireInInputs binding STILL fires inside a textarea (Mod+Enter)', () => {
  const { dispose } = mountController();
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  ta.focus();

  assert.equal(press(ta, 'Enter', { metaKey: true }), true, 'Mod+Enter acts even in a textarea');
  assert.deepEqual(fired, ['save'], 'fireInInputs binding fired');
  dispose();
});

test('screen-subtree hotkeys stay live while focus is on chrome (global-scope fix)', () => {
  fired = [];
  // Tree: root → [chrome, screen]. The focused (active) control is the chrome
  // sidebar; the screen body is its SIBLING — not in the active chain — yet its
  // hotkeys must still be live because it is mounted (the `screen` tier).
  const root = { type: 'Root', parent: null, hotkeys: () => [], childControls: () => [] };
  const chrome = {
    type: 'Navbar',
    parent: root,
    hotkeys: () => [{ binding: 'c', run: () => fired.push('chrome') }],
    childControls: () => [],
  };
  const screen = {
    type: 'Inbox',
    parent: root,
    hotkeys: () => [{ binding: 'j', run: () => fired.push('j') }],
    childControls: () => [],
  };
  root.childControls = () => [chrome, screen];

  const rootSig = M.signal(root, 'root');
  const activeSig = M.signal(chrome, 'active'); // focus is on the navbar
  const screenSig = M.signal(screen, 'screen'); // current screen body
  const hk = new M.HotkeyController({ root: rootSig, active: activeSig, screen: screenSig, target: document });
  const dispose = hk.start();

  // `j` belongs to the screen body, which is NOT in the focused chain — it fires
  // anyway (this is the "clicking the navbar drops the screen keys" fix).
  assert.equal(press(document.body, 'j'), true, "screen's j fired though focus is on chrome");
  assert.deepEqual(fired, ['j']);

  // The focused chrome control's own key still works.
  fired = [];
  assert.equal(press(document.body, 'c'), true);
  assert.deepEqual(fired, ['chrome']);
  dispose();
});

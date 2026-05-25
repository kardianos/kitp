// Popover — the single floating-ui implementation. These tests pin the two
// load-bearing behaviors: (1) it positions + reveals the anchored panel only
// AFTER floating-ui's first computePosition resolves (no (0,0) flash), and
// (2) close()/destroy() fully tear down — the autoUpdate ResizeObserver is
// disconnected AND both document listeners (pointerdown + keydown) are removed.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installUiDom,
  buildUiBundle,
  flushMicrotasks,
  resizeObservers,
  keydown,
  pointerdown,
} from './ui-dom-setup.mjs';

let Popover;

before(async () => {
  installUiDom();
  const outdir = await buildUiBundle();
  ({ Popover } = await import(`${outdir}/ui.js`));
});

beforeEach(() => {
  document.body.replaceChildren();
});

function makeAnchor() {
  const btn = document.createElement('button');
  btn.textContent = 'trigger';
  document.body.appendChild(btn);
  return btn;
}

test('open() appends the panel and reveals it only after first position resolves', async () => {
  const anchor = makeAnchor();
  const pop = new Popover(anchor);
  pop.element.textContent = 'panel body';

  pop.open();
  // Synchronously after open(), the panel is in the DOM but still inert: the
  // reveal waits on computePosition's async resolution.
  assert.ok(document.body.contains(pop.element), 'panel attached to <body>');
  assert.equal(pop.element.style.opacity, '0', 'panel hidden pre-position (no (0,0) flash)');
  assert.equal(pop.element.style.pointerEvents, 'none', 'panel inert pre-position');
  assert.equal(pop.isOpen, true);

  await flushMicrotasks();
  // computePosition resolved -> revealed + positioned. jsdom has no layout
  // engine (all rects are zero), so the resolved point reflects only the
  // offset(4) + shift(padding:8) middleware; the assertion is that the inline
  // left/top WERE written (path ran) and the panel was revealed.
  assert.equal(pop.element.style.opacity, '1', 'panel revealed after first position');
  assert.equal(pop.element.style.pointerEvents, 'auto', 'panel interactive after position');
  assert.match(pop.element.style.left, /^\d+px$/, 'left written by computePosition continuation');
  assert.match(pop.element.style.top, /^\d+px$/, 'top written by computePosition continuation');

  pop.destroy();
});

test('open() starts an autoUpdate ResizeObserver; close() disconnects it', async () => {
  const anchor = makeAnchor();
  const pop = new Popover(anchor);

  pop.open();
  await flushMicrotasks();
  const ro = resizeObservers[resizeObservers.length - 1];
  assert.ok(ro, 'autoUpdate created a ResizeObserver');
  assert.equal(ro.disconnected, false, 'observer live while open');

  pop.close();
  assert.equal(ro.disconnected, true, 'close() disconnected the autoUpdate observer');
  assert.equal(document.body.contains(pop.element), false, 'panel detached on close');
  assert.equal(pop.isOpen, false);

  pop.destroy();
});

test('close() removes BOTH document listeners (pointerdown + keydown)', async () => {
  const anchor = makeAnchor();

  // Spy on document add/removeEventListener to count the capture-phase wires.
  const added = [];
  const removed = [];
  const origAdd = document.addEventListener.bind(document);
  const origRemove = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn, opts) => {
    if (type === 'pointerdown' || type === 'keydown') added.push(type);
    return origAdd(type, fn, opts);
  };
  document.removeEventListener = (type, fn, opts) => {
    if (type === 'pointerdown' || type === 'keydown') removed.push(type);
    return origRemove(type, fn, opts);
  };

  const pop = new Popover(anchor);
  pop.open();
  await flushMicrotasks();
  assert.deepEqual(added.sort(), ['keydown', 'pointerdown'], 'both dismiss listeners wired on open');

  pop.close();
  assert.deepEqual(removed.sort(), ['keydown', 'pointerdown'], 'both removed on close');

  document.addEventListener = origAdd;
  document.removeEventListener = origRemove;
  pop.destroy();
});

test('Escape (self-close) fires onClose; pointerdown outside closes; inside does not', async () => {
  const anchor = makeAnchor();
  let closed = 0;
  const pop = new Popover(anchor, { onClose: () => closed++ });
  pop.open();
  await flushMicrotasks();

  // Pointerdown INSIDE the panel must NOT close.
  pointerdown(pop.element);
  assert.equal(pop.isOpen, true, 'click inside keeps it open');

  // Pointerdown on the anchor must NOT close (the trigger owns its own toggle).
  pointerdown(anchor);
  assert.equal(pop.isOpen, true, 'click on anchor keeps it open');

  // Pointerdown OUTSIDE closes + fires onClose.
  const outside = document.createElement('div');
  document.body.appendChild(outside);
  pointerdown(outside);
  assert.equal(pop.isOpen, false, 'outside click closed it');
  assert.equal(closed, 1, 'onClose fired on self-close');

  // Re-open and close via Escape.
  pop.open();
  await flushMicrotasks();
  keydown(document, 'Escape');
  assert.equal(pop.isOpen, false, 'Escape closed it');
  assert.equal(closed, 2, 'onClose fired on Escape self-close');

  pop.destroy();
});

test('destroy() is idempotent and tears down while open', async () => {
  const anchor = makeAnchor();
  const pop = new Popover(anchor);
  pop.open();
  await flushMicrotasks();
  const ro = resizeObservers[resizeObservers.length - 1];

  pop.destroy();
  assert.equal(ro.disconnected, true, 'destroy disconnects autoUpdate observer');
  assert.equal(document.body.contains(pop.element), false, 'panel detached on destroy');

  // Second destroy + a stray open() after destroy are both no-ops.
  pop.destroy();
  pop.open();
  assert.equal(pop.isOpen, false, 'open() after destroy is a no-op');
});

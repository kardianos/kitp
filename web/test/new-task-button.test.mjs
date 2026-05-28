// NewTaskButton — the visible "+ New" task button on the Grid + List filter
// bars. It just raises the shared `quickCreateOpen` bus intent (the same action
// as the `n` hotkey) so the AppShell's single QuickEntry overlay opens.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerNewTaskButton();
});

beforeEach(() => {
  document.body?.replaceChildren?.();
});

function mount(config = {}) {
  const emitted = [];
  const ctx = {
    api: {},
    tree: new M.TreeNode({}, []),
    bus: { emit: (type, detail) => emitted.push({ type, detail }) },
  };
  const ctrl = M.Control.New('NewTaskButton', { type: 'NewTaskButton', ...config }, ctx);
  ctrl.mount(new FakeElement('div'));
  return { ctrl, emitted };
}

test('NewTaskButton: renders a primary button labelled "+ New"', () => {
  const { ctrl } = mount();
  assert.equal(ctrl.el.dataset.control, 'NewTaskButton');
  assert.ok(ctrl.el.className.includes('btn-primary'), 'primary-styled');
  assert.equal(ctrl.el.textContent, '+ New');
});

test('NewTaskButton: a custom label overrides the default', () => {
  const { ctrl } = mount({ label: '+ New task' });
  assert.equal(ctrl.el.textContent, '+ New task');
});

test('NewTaskButton: click raises the quickCreateOpen bus intent', () => {
  const { ctrl, emitted } = mount();
  ctrl.el.dispatchEvent({ type: 'click' });
  assert.equal(emitted.length, 1, 'one intent emitted');
  assert.equal(emitted[0].type, 'quickCreateOpen', 'opens QuickEntry');
  // No parent passed — QuickEntry resolves the active project from scope itself.
  assert.equal(emitted[0].detail, undefined);
});

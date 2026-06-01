// Editor formatting toolbar (src/editor/toolbar.ts). Basic coverage: it renders
// the expected buttons, a click runs the matching engine command, and refresh()
// reflects the engine's active / enabled state. Driven against a stub engine —
// no ProseMirror needed (the toolbar only speaks the EditorEngine command
// surface).

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installUiDom, buildUiBundle } from './ui-dom-setup.mjs';

let createToolbar;

before(async () => {
  installUiDom();
  const outdir = await buildUiBundle();
  ({ createToolbar } = await import(`${outdir}/ui.js`));
});

beforeEach(() => {
  document.body.replaceChildren();
});

/** A minimal command-capable engine that records exec calls and lets the test
 *  pin active / disabled sets. */
function stubEngine() {
  const calls = [];
  const active = new Set();
  const disabled = new Set();
  return {
    calls,
    active,
    disabled,
    getMarkdown: () => '',
    setMarkdown() {},
    setDisabled() {},
    focus() {},
    isFocused: () => false,
    destroy() {},
    supportsCommands: () => true,
    exec: (a) => calls.push(a),
    isActive: (a) => active.has(a),
    can: (a) => !disabled.has(a),
  };
}

const ALL_ACTIONS = [
  'bold', 'italic', 'strike', 'code',
  'h1', 'h2', 'h3',
  'bullet', 'ordered', 'quote', 'codeblock',
  'link', 'undo', 'redo',
];

test('renders a button per action and a click runs that command', () => {
  const eng = stubEngine();
  const tb = createToolbar(eng);
  document.body.append(tb.el);

  for (const a of ALL_ACTIONS) {
    assert.ok(tb.el.querySelector(`[data-action="${a}"]`), `button for ${a}`);
  }

  tb.el.querySelector('[data-action="bold"]').click();
  tb.el.querySelector('[data-action="h2"]').click();
  assert.deepEqual(eng.calls, ['bold', 'h2']);

  tb.destroy();
  assert.equal(tb.el.isConnected, false, 'destroy removes the toolbar DOM');
});

test('refresh() reflects active + disabled state', () => {
  const eng = stubEngine();
  eng.active.add('italic');
  eng.disabled.add('redo');
  const tb = createToolbar(eng);
  document.body.append(tb.el);
  tb.refresh();

  const italic = tb.el.querySelector('[data-action="italic"]');
  const bold = tb.el.querySelector('[data-action="bold"]');
  const redo = tb.el.querySelector('[data-action="redo"]');

  assert.equal(italic.getAttribute('aria-pressed'), 'true');
  assert.ok(italic.classList.contains('rich-editor__tool--active'));
  assert.equal(bold.getAttribute('aria-pressed'), 'false');
  assert.equal(redo.disabled, true, 'redo disabled when engine.can is false');
  assert.equal(bold.disabled, false);

  tb.destroy();
});

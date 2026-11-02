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
    insertBlock: (text) => calls.push(`insert:${text}`),
  };
}

const ALL_ACTIONS = [
  'bold', 'italic', 'strike', 'code',
  'h1', 'h2', 'h3',
  'bullet', 'ordered', 'quote', 'codeblock', 'hr',
  'link', 'undo', 'redo', 'raw',
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

const SNIPPETS = [
  { label: 'Child pages', text: '{{< children >}}', description: "A list of this page's child pages" },
  { label: 'Site map', text: '{{< nav >}}' },
];

test('no snippets → no Insert button', () => {
  const tb = createToolbar(stubEngine());
  assert.equal(tb.el.querySelector('[data-action="insert"]'), null);
  tb.destroy();
});

test('Insert menu: lists the snippets and inserts the one chosen', () => {
  const eng = stubEngine();
  const tb = createToolbar(eng, SNIPPETS);
  document.body.append(tb.el);
  const btn = tb.el.querySelector('[data-action="insert"]');
  assert.ok(btn, 'an Insert button');
  assert.equal(document.querySelector('[data-insert-menu]'), null, 'menu closed at first');

  btn.click();
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  const items = [...document.querySelectorAll('[data-insert-menu] [data-insert]')];
  assert.deepEqual(items.map((i) => i.dataset.insert), ['{{< children >}}', '{{< nav >}}']);
  assert.match(items[0].textContent, /Child pages/);
  assert.match(items[0].textContent, /A list of this page's child pages/);

  items[1].click();
  assert.deepEqual(eng.calls, ['insert:{{< nav >}}']);
  assert.equal(document.querySelector('[data-insert-menu]'), null, 'choosing closes the menu');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  tb.destroy();
});

test('Insert menu: Escape closes it without reaching the editor', () => {
  const tb = createToolbar(stubEngine(), SNIPPETS);
  document.body.append(tb.el);
  const btn = tb.el.querySelector('[data-action="insert"]');
  btn.click();
  let reached = 0;
  const editor = document.createElement('div');
  document.body.append(editor);
  editor.addEventListener('keydown', () => { reached++; });
  editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('[data-insert-menu]'), null);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(reached, 0, 'Escape stopped at the menu');
  tb.destroy();
});

test('destroy removes an open Insert menu', () => {
  const tb = createToolbar(stubEngine(), SNIPPETS);
  document.body.append(tb.el);
  tb.el.querySelector('[data-action="insert"]').click();
  tb.destroy();
  assert.equal(document.querySelector('[data-insert-menu]'), null);
});

test('Insert menu: snippets from a function are read on open, grouped under headings', () => {
  let pictures = [];
  const tb = createToolbar(stubEngine(), () => [
    { group: 'Placeholders', label: 'Child pages', text: '{{< children >}}' },
    ...pictures,
  ]);
  document.body.append(tb.el);
  const btn = tb.el.querySelector('[data-action="insert"]');
  assert.ok(btn, 'a function always gets an Insert button');
  pictures = [{ group: 'Pictures', label: 'chart.png', text: '![chart.png](/api/v1/attachment/12/view)', hint: '' }];
  btn.click();
  const menu = document.querySelector('[data-insert-menu]');
  assert.deepEqual([...menu.querySelectorAll('.rich-editor__insert-group')].map((g) => g.textContent), ['Placeholders', 'Pictures']);
  const pic = menu.querySelector('[data-insert^="![chart"]');
  assert.equal(pic.querySelector('code'), null, "hint '' shows no code");
  tb.destroy();
});

// Markdown round-trip tests for the ProseMirror editor (src/editor/).
//
// These pin the load-bearing contract of the WYSIWYG editor: that content
// round-trips through markdown losslessly and STABLY. The editor stores markdown
// (parse on load, serialize on every edit), so any drift in the schema, the
// table glue, or a vendored-bundle bump that changes round-trip output would
// silently corrupt stored content — these fail loudly instead.
//
// Strategy: idempotence (serialize(parse(x)) must be a fixed point) plus targeted
// structural/format assertions for the features that carry custom glue (tables,
// alignment, lists, strikethrough). A jsdom window is installed before import
// because the vendored bundle includes prosemirror-view (render.ts needs a DOM).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, '.build', `editor-p${process.pid}`);

let parseMarkdown, serializeMarkdown, renderMarkdownToFragment;

before(async () => {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  // Node ≥21 exposes globalThis.navigator as getter-only; plain assignment
  // throws. defineProperty replaces it on any Node version.
  Object.defineProperty(globalThis, 'navigator', {
    value: window.navigator,
    writable: true,
    configurable: true,
  });

  await esbuild.build({
    entryPoints: {
      markdown: join(here, '..', 'src', 'editor', 'markdown.ts'),
      render: join(here, '..', 'src', 'editor', 'render.ts'),
    },
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    logLevel: 'warning',
  });

  ({ parseMarkdown, serializeMarkdown } = await import(`${outdir}/markdown.js`));
  ({ renderMarkdownToFragment } = await import(`${outdir}/render.js`));
});

/** serialize(parse(x)) — the canonical markdown form. */
const roundtrip = (md) => serializeMarkdown(parseMarkdown(md));

/* -------------------------------------------------------------------------- */
/* Idempotence — the canonical form must be a fixed point.                     */
/* -------------------------------------------------------------------------- */

const IDEMPOTENT_CASES = [
  ['heading', '# Title\n\nbody text'],
  ['inline marks', 'a **bold** and *italic* and `code` and ~~struck~~ word'],
  ['link', 'see [the docs](https://example.com) here'],
  ['bullet list', '* one\n\n* two\n\n* three'],
  ['nested bullet list', '* outer\n\n  * inner a\n\n  * inner b'],
  ['ordered list', '1. first\n\n2. second'],
  ['blockquote', '> quoted line'],
  ['code block', '```\nconst x = 1;\n```'],
  ['horizontal rule', 'above\n\n---\n\nbelow'],
  ['table', '| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |'],
  ['table with alignment', '| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |'],
  ['table with inline marks', '| name | note |\n| --- | --- |\n| **bob** | a ~~old~~ value |'],
  ['task list', '* [ ] todo\n\n* [x] done'],
];

for (const [name, md] of IDEMPOTENT_CASES) {
  test(`round-trip is idempotent: ${name}`, () => {
    const once = roundtrip(md);
    const twice = roundtrip(once);
    assert.equal(twice, once, `expected a fixed point.\n--- once ---\n${once}\n--- twice ---\n${twice}`);
  });
}

test('a horizontal rule parses to a horizontal_rule node and serializes to ---', () => {
  const doc = parseMarkdown('above\n\n---\n\nbelow');
  let sawHr = false;
  doc.descendants((node) => {
    if (node.type.name === 'horizontal_rule') sawHr = true;
  });
  assert.ok(sawHr, 'expected a horizontal_rule node in the parsed doc');
  assert.match(serializeMarkdown(doc), /\n---\n/, 'expected --- in the serialized markdown');
});

/* -------------------------------------------------------------------------- */
/* Tables — the custom glue. Structure + alignment must survive.               */
/* -------------------------------------------------------------------------- */

test('table parses to a table node with the right shape', () => {
  const doc = parseMarkdown('| H1 | H2 |\n| --- | --- |\n| a | b |');
  const json = doc.toJSON();
  const table = json.content.find((n) => n.type === 'table');
  assert.ok(table, 'a table node exists');
  assert.equal(table.content.length, 2, 'header row + one body row');
  assert.equal(table.content[0].content[0].type, 'table_header', 'first row is header cells');
  assert.equal(table.content[1].content[0].type, 'table_cell', 'second row is body cells');
});

test('column alignment round-trips (left/center/right separators)', () => {
  const out = roundtrip('| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |');
  assert.match(out, /:---(?!:)/, 'left alignment marker present');
  assert.match(out, /:---:/, 'center alignment marker present');
  assert.match(out, /[^:]---:/, 'right alignment marker present');
});

test('inline formatting inside a cell survives', () => {
  const out = roundtrip('| name |\n| --- |\n| **bob** |');
  assert.match(out, /\*\*bob\*\*/, 'bold survives inside the cell');
});

test('a pipe inside cell text is escaped, not a column break', () => {
  const doc = parseMarkdown('| a |\n| --- |\n| x \\| y |');
  const table = doc.toJSON().content.find((n) => n.type === 'table');
  // header + one body row, each row a single cell (the escaped pipe did not split).
  assert.equal(table.content[1].content.length, 1, 'escaped pipe stays within one cell');
});

/* -------------------------------------------------------------------------- */
/* Render path (DOMSerializer) — safe DOM, no markup injection.                */
/* -------------------------------------------------------------------------- */

test('renderMarkdownToFragment builds real elements (not innerHTML)', () => {
  const frag = renderMarkdownToFragment('# Hi\n\n* a\n* b');
  const host = document.createElement('div');
  host.appendChild(frag);
  assert.equal(host.querySelector('h1')?.textContent, 'Hi');
  assert.equal(host.querySelectorAll('li').length, 2);
});

test('raw HTML in markdown does not become live markup', () => {
  const frag = renderMarkdownToFragment('hi <script>steal()</script> bye');
  const host = document.createElement('div');
  host.appendChild(frag);
  assert.equal(host.querySelector('script'), null, 'no <script> element is created');
  assert.match(host.textContent, /steal\(\)/, 'it survives as inert text');
});

test('renders a table to a real <table>', () => {
  const frag = renderMarkdownToFragment('| H |\n| --- |\n| v |');
  const host = document.createElement('div');
  host.appendChild(frag);
  assert.ok(host.querySelector('table'), 'a <table> element exists');
  assert.ok(host.querySelector('th'), 'a header cell exists');
});

/* -------------------------------------------------------------------------- */
/* XSS regression coverage (carried over from the retired marked+dompurify     */
/* sink). The render path is a whitelist-by-schema + createElement build, so    */
/* these pin that no dangerous scheme or markup survives.                       */
/* -------------------------------------------------------------------------- */

const renderHost = (md) => {
  const host = document.createElement('div');
  host.appendChild(renderMarkdownToFragment(md));
  return host;
};

test('javascript: link is dropped (no dangerous href)', () => {
  const host = renderHost('[click](javascript:alert(1))');
  const a = host.querySelector('a');
  assert.ok(a === null || !/javascript:/i.test(a.getAttribute('href') ?? ''), 'no javascript: href survives');
});

test('javascript: image src is dropped', () => {
  const host = renderHost('![x](javascript:alert(1))');
  const img = host.querySelector('img');
  assert.ok(img === null || !/javascript:/i.test(img.getAttribute('src') ?? ''), 'no javascript: src survives');
});

test('external links are hardened (target + rel=noopener)', () => {
  const a = renderHost('see [docs](https://example.com)').querySelector('a');
  assert.ok(a, 'the anchor exists');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.match(a.getAttribute('rel') ?? '', /noopener/);
});

/* -------------------------------------------------------------------------- */
/* GFM task lists.                                                             */
/* -------------------------------------------------------------------------- */

test('task list parses the marker into a checked attribute + strips the text', () => {
  const doc = parseMarkdown('* [x] done\n* [ ] todo');
  const json = doc.toJSON();
  const list = json.content.find((n) => n.type === 'bullet_list');
  const [first, second] = list.content;
  assert.equal(first.attrs.checked, true, 'first item is checked');
  assert.equal(second.attrs.checked, false, 'second item is unchecked');
  // Marker text is stripped from the rendered content.
  assert.equal(first.content[0].content[0].text, 'done');
});

test('task list renders disabled checkboxes in display', () => {
  const host = renderHost('* [x] done\n* [ ] todo');
  const boxes = host.querySelectorAll('li.task-item input[type="checkbox"]');
  assert.equal(boxes.length, 2, 'two task checkboxes');
  assert.ok([...boxes].every((b) => b.hasAttribute('disabled')), 'all read-only in display');
  assert.equal(boxes[0].hasAttribute('checked'), true, 'first is checked');
  assert.equal(boxes[1].hasAttribute('checked'), false, 'second is unchecked');
});

test('a normal bullet list is unaffected (checked stays null)', () => {
  const doc = parseMarkdown('* plain one\n* plain two');
  const list = doc.toJSON().content.find((n) => n.type === 'bullet_list');
  assert.ok(list.content.every((it) => it.attrs.checked === null), 'no task markers');
});

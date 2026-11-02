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

let parseMarkdown, serializeMarkdown, renderMarkdownToFragment, rich;

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
      rich: join(here, '..', 'src', 'editor', 'editor-test-barrel.ts'),
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
  rich = await import(`${outdir}/rich.js`);
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

/* -------------------------------------------------------------------------- */
/* Portal page bodies: ref: links and placeholders survive an edit verbatim.   */
/* -------------------------------------------------------------------------- */

const VERBATIM_CASES = [
  ['ref: link by path', 'See [Getting started](ref:getting-started) for more.'],
  ['ref: link by id', 'See [page 42](ref:42).'],
  ['ref: link to the root', '[this link](ref:) goes to the home page'],
  ['ref: link to a heading', 'Read [setup](ref:guide#setup) first.'],
  ['placeholder paragraph', '## In this site\n\n{{< children >}}'],
  ['placeholder in a code span', 'Write `{{< toc >}}` for the headings.'],
];

for (const [name, md] of VERBATIM_CASES) {
  test(`portal markup survives the editor unchanged: ${name}`, () => {
    assert.equal(roundtrip(md), md);
  });
}

// Why portal pages link with ref: instead of Hugo's {{< ref >}}: a
// placeholder isn't a valid link target, so the editor reads the link as
// text and escapes its brackets on save — the link is gone.
test('a placeholder inside a link does not survive the editor (pages use ref: links)', () => {
  assert.equal(roundtrip('See [x]({{< ref "y" >}}).'), 'See \\[x\\]({{< ref "y" >}}).');
});

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

/* -------------------------------------------------------------------------- */
/* Change notification — serializing is O(document), so it runs only for a     */
/* host that listens (a description reads its value once, on commit).          */
/* -------------------------------------------------------------------------- */

test('a change is reported without a payload; the host reads the markdown when it needs it', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const changes = [];
  const engine = rich.createProseMirrorEngine(host, { value: 'first' }, {
    onChange: (...args) => changes.push(args),
    onCommit: () => {},
    onCancel: () => {},
  });
  engine.exec('hr');
  assert.deepEqual(changes, [[]], 'one change, no markdown payload');
  engine.destroy();

  rich.setRichEditorEngine(rich.createProseMirrorEngine);
  let changed = 0;
  const ed = new rich.RichEditor({ value: 'first', onChange: () => changed++ });
  document.body.append(ed.el);
  ed.el.querySelector('[data-action="hr"]').click();
  assert.equal(changed, 1);
  assert.equal(ed.getValue(), '---\n\nfirst', 'rule inserted at the caret');
  ed.destroy();
});

const BLANK_CASES = [
  ['', true],
  ['   \n\n  ', true],
  ['hello', false],
  ['---', false, 'a rule is content'],
  ['![logo](https://example.com/a.png)', false, 'an image is content'],
  ['\n\n\n\nlate text', false],
];
for (const [md, want, why] of BLANK_CASES) {
  test(`isEmpty(${JSON.stringify(md)}) = ${want}${why ? ` (${why})` : ''}`, () => {
    rich.setRichEditorEngine(rich.createProseMirrorEngine);
    const ed = new rich.RichEditor({ value: md });
    assert.equal(ed.isEmpty(), want);
    ed.destroy();
  });
}

/* -------------------------------------------------------------------------- */
/* Link bar — the Link command's URL box + optional page picker.               */
/* -------------------------------------------------------------------------- */

const TARGETS = [
  { label: 'Home', href: 'ref:70', hint: 'ref:70' },
  { label: 'Home › Getting started', href: 'ref:71', hint: 'ref:71' },
];

// A tree where a word sits both in page titles and in parent paths.
const TREE = [
  { label: 'Home', href: 'ref:1', hint: 'ref:1' },
  { label: 'Home › Guide', href: 'ref:2', hint: 'ref:2' },
  { label: 'Home › Guide › Install', href: 'ref:3', hint: 'ref:3' },
  { label: 'Home › Guide › Setup', href: 'ref:4', hint: 'ref:4' },
  { label: 'Home › Reference › Setup guide', href: 'ref:5', hint: 'ref:5' },
];

for (const [targets, query, want] of [
  [TARGETS, '', ['ref:70', 'ref:71']],
  [TARGETS, 'getting', ['ref:71']],
  [TARGETS, 'HOME', ['ref:70', 'ref:71']],
  [TARGETS, 'ref:71', []], // looks like a URL → no page search
  [TARGETS, 'https://example.com', []],
  [TARGETS, '/docs', []],
  [TARGETS, 'nothing', []],
  [TARGETS, '71', ['ref:71']], // the hint (page number) is searchable
  // Every word must match, in any order, across the whole path.
  [TREE, 'guide install', ['ref:3']],
  [TREE, 'setup  home', ['ref:4', 'ref:5']],
  // Pages titled with the words come before pages under such a parent.
  [TREE, 'guide', ['ref:2', 'ref:5', 'ref:3', 'ref:4']],
  [TREE, 'setup', ['ref:4', 'ref:5']],
]) {
  test(`filterLinkTargets(${JSON.stringify(query)}) → ${JSON.stringify(want)}`, () => {
    assert.deepEqual(rich.filterLinkTargets(targets, query).map((t) => t.href), want);
  });
}

/** A ProseMirror engine over `value` with everything selected. */
function linkEngine(value, init = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const calls = { cancel: 0, commit: 0 };
  const engine = rich.createProseMirrorEngine(host, { value, ...init }, {
    onChange: () => {},
    onCommit: () => { calls.commit++; },
    onCancel: () => { calls.cancel++; },
  });
  const editable = host.querySelector('[contenteditable]');
  editable.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  return { host, engine, calls };
}

function type(input, text) {
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

test('link bar: a typed URL + Enter links the selection', () => {
  const { host, engine, calls } = linkEngine('hello');
  engine.exec('link');
  const input = host.querySelector('[data-link-input]');
  assert.ok(input, 'the bar opened');
  assert.equal(host.querySelector('[data-link-list]').style.display, 'none', 'no targets → no list');
  type(input, 'https://example.com');
  key(input, 'Enter');
  assert.equal(engine.getMarkdown(), '[hello](https://example.com)');
  assert.equal(host.querySelector('[data-link-bar]'), null, 'the bar closed');
  assert.equal(calls.commit, 0, 'Enter in the bar does not commit the description');
});

test('link bar: picking a page links it as ref:<id>', () => {
  const { host, engine } = linkEngine('the guide', { linkTargets: () => TARGETS });
  engine.exec('link');
  const input = host.querySelector('[data-link-input]');
  type(input, 'getting');
  const options = host.querySelectorAll('[data-link-option]');
  assert.deepEqual([...options].map((o) => o.dataset.linkOption), ['ref:71']);
  options[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(engine.getMarkdown(), '[the guide](ref:71)');
});

test('link bar: arrow keys + Enter pick a listed page', () => {
  const { host, engine } = linkEngine('home', { linkTargets: () => TARGETS });
  engine.exec('link');
  const input = host.querySelector('[data-link-input]');
  key(input, 'ArrowDown');
  key(input, 'Enter');
  assert.equal(engine.getMarkdown(), '[home](ref:70)');
});

test('link bar: Escape closes the bar without linking or cancelling the edit', () => {
  const { host, engine, calls } = linkEngine('hello', { linkTargets: () => TARGETS });
  engine.exec('link');
  key(host.querySelector('[data-link-input]'), 'Escape');
  assert.equal(host.querySelector('[data-link-bar]'), null);
  assert.equal(engine.getMarkdown(), 'hello');
  assert.equal(calls.cancel, 0, 'Escape in the bar does not cancel the description edit');
});

test('link bar: a long page list shows the first 50, scrolls, and says how many more match', () => {
  const many = Array.from({ length: 120 }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return { label: `Home › Page ${n}`, href: `ref:${n}`, hint: `ref:${n}` };
  });
  const { host, engine } = linkEngine('x', { linkTargets: () => many });
  engine.exec('link');
  const input = host.querySelector('[data-link-input]');
  const more = host.querySelector('[data-link-more]');
  assert.equal(host.querySelectorAll('[data-link-option]').length, 50);
  assert.equal(more.style.display, '');
  assert.equal(more.textContent, '70 more pages match. Keep typing to narrow the list.');

  type(input, 'page 11'); // Page 011, 110–119
  assert.deepEqual(
    [...host.querySelectorAll('[data-link-option]')].map((o) => o.dataset.linkOption),
    ['ref:011', 'ref:110', 'ref:111', 'ref:112', 'ref:113', 'ref:114', 'ref:115', 'ref:116', 'ref:117', 'ref:118', 'ref:119'],
  );
  assert.equal(more.style.display, 'none', 'everything fits → no footer');

  for (let i = 0; i < 10; i++) key(input, 'ArrowDown');
  assert.equal(host.querySelector('.rich-editor__link-option.is-active').dataset.linkOption, 'ref:118');
  key(input, 'Enter');
  assert.equal(engine.getMarkdown(), '[x](ref:118)');
});

/* -------------------------------------------------------------------------- */
/* insertBlock — the Insert menu's command (a paragraph of its own).           */
/* -------------------------------------------------------------------------- */

const PH = '{{< children >}}';

for (const [name, value, pos, want, caret] of [
  ['empty source', '', 0, `${PH}\n`, PH.length],
  ['mid-line: after the line, never splitting it', 'Hello world', 5, `Hello world\n\n${PH}\n`, 13 + PH.length],
  ['between paragraphs', 'One\n\nTwo', 1, `One\n\n${PH}\n\nTwo`, 5 + PH.length],
  ['on a blank line', 'One\n\n\n\nTwo', 5, `One\n\n${PH}\n\nTwo`, 5 + PH.length],
  ['at the very end', 'One\n', 4, `One\n\n${PH}\n`, 5 + PH.length],
]) {
  test(`insertBlockInSource: ${name}`, () => {
    assert.deepEqual(rich.insertBlockInSource(value, pos, PH), { value: want, caret });
  });
}

for (const [name, value, want] of [
  ['an empty doc becomes the block', '', PH],
  ['after the paragraph holding the cursor', 'Intro text', `Intro text\n\n${PH}`],
  ['after the whole list, not inside the item', '* item\n\nafter', `* item\n\n${PH}\n\nafter`],
  ['after the whole quote', '> quoted', `> quoted\n\n${PH}`],
]) {
  test(`insertBlock (rich): ${name}`, () => {
    const host = document.createElement('div');
    document.body.append(host);
    const engine = rich.createProseMirrorEngine(host, { value }, { onChange: () => {}, onCommit: () => {}, onCancel: () => {} });
    engine.insertBlock(PH);
    assert.equal(engine.getMarkdown(), want);
    engine.destroy();
  });
}

test('insertBlock (raw mode) inserts into the source after the cursor line', () => {
  const host = document.createElement('div');
  document.body.append(host);
  let changes = 0;
  const engine = rich.createProseMirrorEngine(host, { value: 'One\n\nTwo' }, { onChange: () => { changes++; }, onCommit: () => {}, onCancel: () => {} });
  engine.exec('raw');
  const ta = host.querySelector('textarea');
  ta.setSelectionRange(1, 1);
  engine.insertBlock(PH);
  assert.equal(ta.value, `One\n\n${PH}\n\nTwo`);
  assert.equal(ta.selectionStart, 5 + PH.length, 'cursor after the block');
  assert.ok(changes > 0, 'reports the change');
  engine.destroy();
});

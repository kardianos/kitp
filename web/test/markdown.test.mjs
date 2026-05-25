// Sanitization boundary tests for web/src/util/markdown.ts.
//
// This is the security-critical seam: untrusted Markdown (task descriptions,
// comments, help) becomes HTML only through `renderMarkdown`. These tests pin
// the hardened marked + DOMPurify config so a future dependency bump or config
// edit that re-opens an XSS hole fails loudly.
//
// DOMPurify needs a REAL DOM (DOMParser / template element / node iterator),
// which Node 20 does not provide. We give it one via jsdom — a TEST-ONLY
// devDependency (it is never bundled into dist and is not part of the
// build/dev toolchain). The window must be installed on globalThis BEFORE the
// markdown module is imported, because the vendored DOMPurify captures
// `getGlobal()` (= window) at module-evaluation time.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, '.build', `md-p${process.pid}`);

let renderMarkdown;

before(async () => {
  // 1) Install a real DOM as globals BEFORE importing the module under test.
  const { window } = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;

  // 2) Bundle the TS module (+ vendored marked/dompurify) to ESM for node.
  await esbuild.build({
    entryPoints: { markdown: join(here, '..', 'src', 'util', 'markdown.ts') },
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    logLevel: 'warning',
  });

  ({ renderMarkdown } = await import(`${outdir}/markdown.js`));
});

/* -------------------------------------------------------------------------- */
/* XSS / scheme stripping — the load-bearing assertions.                       */
/* -------------------------------------------------------------------------- */

test('javascript: href is stripped from links', () => {
  const out = renderMarkdown('[click](javascript:alert(1))');
  assert.doesNotMatch(out, /javascript:/i, 'no javascript: scheme survives');
  // The <a> stays but loses its dangerous href.
  assert.match(out, /<a/, 'the anchor element is kept');
  assert.doesNotMatch(out, /href="javascript/i);
});

test('javascript: src is stripped from images', () => {
  const out = renderMarkdown('![x](javascript:alert(1))');
  assert.doesNotMatch(out, /javascript:/i, 'no javascript: scheme survives on img');
});

test('data: URI is stripped from anchor href', () => {
  const out = renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
  assert.doesNotMatch(out, /data:text\/html/i, 'data:text/html href is dropped');
  assert.doesNotMatch(out, /<script/i, 'no script element ever appears');
});

test('raw <script> in source is dropped', () => {
  const out = renderMarkdown('hi\n\n<script>steal()</script>\n\nbye');
  assert.doesNotMatch(out, /<script/i, 'script element removed');
  assert.doesNotMatch(out, /steal\(\)/, 'script body removed');
  assert.match(out, /hi/);
  assert.match(out, /bye/);
});

test('inline event handler (onclick / onerror) is stripped', () => {
  const out = renderMarkdown('<p onclick="evil()">hello</p><img src="x" onerror="evil()">');
  assert.doesNotMatch(out, /onclick/i, 'onclick attribute removed');
  assert.doesNotMatch(out, /onerror/i, 'onerror attribute removed');
  assert.match(out, /hello/, 'the safe text content survives');
});

test('style attribute follows the verbatim config — same as Svelte', () => {
  // The config comment says "class is allowed; style is not", but
  // `USE_PROFILES: { html: true }` UNIONS the HTML profile's attribute set
  // (which includes `style`) on top of ALLOWED_ATTR, so `style` survives.
  // This matches client/src/util/markdown.ts byte-for-byte (verified against
  // its DOMPurify). `style` cannot execute script (no expression()/url(js:)
  // in modern engines), so this is a layout-only surface, not an XSS vector.
  // Pinned so the parity (and any future tightening) is explicit.
  const out = renderMarkdown('<p style="position:fixed">x</p>');
  assert.match(out, /style="position:fixed"/, 'style survives via USE_PROFILES html (Svelte parity)');
});

test('data-* attributes are stripped (ALLOW_DATA_ATTR: false)', () => {
  const out = renderMarkdown('<p data-evil="1">x</p>');
  assert.doesNotMatch(out, /data-evil/i, 'arbitrary data-* attribute removed');
});

/* -------------------------------------------------------------------------- */
/* Documented behavior of the VERBATIM config (matches the Svelte boundary).   */
/* DOMPurify's built-in DATA_URI_TAGS allowlist permits data: on <img>; the    */
/* config does not override it, identical to client/src/util/markdown.ts.      */
/* Pinned so a future change to the data-URI posture is caught here.           */
/* -------------------------------------------------------------------------- */

test('data: on <img> follows DOMPurify default (allowed) — same as Svelte', () => {
  const out = renderMarkdown('![pixel](data:image/png;base64,iVBORw0KGgo=)');
  // The verbatim config does NOT add data: to ALLOWED_URI_REGEXP, but DOMPurify
  // keeps it on <img> via its internal DATA_URI_TAGS list. This matches the
  // Svelte client byte-for-byte. (No script execution is possible from an
  // image data URI; the comment in markdown.ts about the "tracking pixel" is
  // aspirational — flagged here so the parity is explicit.)
  assert.match(out, /data:image\/png/i, 'data:image survives on img (DOMPurify default)');
});

/* -------------------------------------------------------------------------- */
/* Allowed-tag passthrough — the rich-but-safe surface renders.                */
/* -------------------------------------------------------------------------- */

test('common allowed tags pass through', () => {
  const out = renderMarkdown(
    '# Title\n\nA **bold** and *em* and `code` and ~~del~~.\n\n- one\n- two\n\n[link](https://example.com)',
  );
  assert.match(out, /<h1[^>]*>Title<\/h1>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>em<\/em>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /<del>del<\/del>/);
  assert.match(out, /<ul>/);
  assert.match(out, /<li>one<\/li>/);
  assert.match(out, /<a [^>]*href="https:\/\/example\.com"/);
});

test('fenced code block renders as <pre><code>', () => {
  const out = renderMarkdown('```\nlet x = 1;\n```');
  assert.match(out, /<pre><code/);
  assert.match(out, /let x = 1;/);
});

test('GFM table renders with table/thead/tbody/tr/th/td', () => {
  const md = '| A | B |\n| - | - |\n| 1 | 2 |';
  const out = renderMarkdown(md);
  assert.match(out, /<table>/);
  assert.match(out, /<th[^>]*>A<\/th>/);
  assert.match(out, /<td[^>]*>1<\/td>/);
});

/* -------------------------------------------------------------------------- */
/* Link-safety hook — external links get target + rel=noopener.                */
/* -------------------------------------------------------------------------- */

test('links get rel="noopener noreferrer" and target="_blank"', () => {
  const out = renderMarkdown('[ext](https://example.com)');
  assert.match(out, /rel="noopener noreferrer"/, 'rel set by afterSanitizeAttributes hook');
  assert.match(out, /target="_blank"/, 'target set by the hook');
  // The two must appear on the same <a>.
  assert.match(out, /<a [^>]*href="https:\/\/example\.com"[^>]*>/);
});

test('mailto and tel and fragment and relative links are allowed', () => {
  assert.match(renderMarkdown('[m](mailto:a@b.com)'), /href="mailto:a@b\.com"/);
  assert.match(renderMarkdown('[t](tel:+15551234)'), /href="tel:\+15551234"/);
  assert.match(renderMarkdown('[f](#anchor)'), /href="#anchor"/);
  assert.match(renderMarkdown('[r](/cards/42)'), /href="\/cards\/42"/);
});

/* -------------------------------------------------------------------------- */
/* GFM task-list checkbox is forced disabled by the hook.                      */
/* -------------------------------------------------------------------------- */

test('task-list checkbox is rendered disabled', () => {
  const out = renderMarkdown('- [ ] todo\n- [x] done');
  assert.match(out, /<input[^>]*disabled/, 'checkbox forced disabled by the hook');
  // DOMPurify drops `type` from <input> as DOM-clobbering protection (it is
  // guarded even when in ALLOWED_ATTR), so the rendered checkbox is
  // `<input checked disabled>` with no type — and crucially cannot be a
  // text/file/etc. input. The hook's job (force disabled) is the assertion.
  assert.doesNotMatch(out, /type="checkbox"/, 'type stripped by DOMPurify clobbering guard');
  // The checked state of the second item is preserved (informational).
  assert.match(out, /checked/, 'the [x] item keeps its checked marker');
});

/* -------------------------------------------------------------------------- */
/* Edge cases.                                                                 */
/* -------------------------------------------------------------------------- */

test('empty input returns empty string (no parse, no sink work)', () => {
  assert.equal(renderMarkdown(''), '');
});

test('plain text round-trips as a paragraph', () => {
  const out = renderMarkdown('just text');
  assert.match(out, /<p>just text<\/p>/);
});

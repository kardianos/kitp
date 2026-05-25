// Centralised Markdown → sanitized HTML pipeline for the web client.
//
// This is the SECURITY BOUNDARY: untrusted Markdown (task descriptions,
// comments, help) becomes HTML only here. Any consumer that wants rendered
// Markdown must call `renderMarkdown`. Bypassing it (calling DOMPurify or
// marked directly, or assigning raw Markdown to innerHTML) re-introduces XSS
// or weakens the link-safety hooks.
//
// The config is lifted VERBATIM from the Svelte client's hardened pipeline
// (client/src/util/markdown.ts): identical ALLOWED_TAGS/ALLOWED_ATTR
// allowlists, the same ALLOWED_URI_REGEXP blocking `javascript:`/`data:`, and
// the same `afterSanitizeAttributes` link-safety hook. marked + dompurify are
// VENDORED as ESM under web/vendor/ (esbuild bundles them; no npm runtime dep).
//
// One module owns the marked + DOMPurify config so it runs ONCE at first
// import rather than per render — re-applying `marked.setOptions` or
// re-registering the DOMPurify hook on every render would stack the hook and
// run its logic N times per sanitize call.

import DOMPurify, { type Config } from '../../vendor/dompurify.js';
import { marked } from '../../vendor/marked.js';

// gfm=true unlocks tables, fenced code, task lists, strikethrough.
// breaks=true treats a single newline as <br> (matches what users who type
// comments in a textarea expect). async=false forces the synchronous overload
// of marked.parse so the caller can render in the same tick.
marked.setOptions({ async: false, gfm: true, breaks: true });

// Explicit tag allowlist — pins the surface so a future DOMPurify release that
// widens defaults can't silently expose new elements. Anything outside this
// list is dropped (not just escaped). The set matches what marked emits for
// CommonMark + the GFM extensions (tables, task lists, strikethrough).
const ALLOWED_TAGS = [
  // Block
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'blockquote', 'pre', 'hr', 'br', 'div',
  'ul', 'ol', 'li',
  // Inline
  'a', 'code', 'em', 'strong', 'del', 's', 'sub', 'sup',
  'img', 'span',
  // GFM tables
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  // GFM task list — marked emits `<input type=checkbox disabled>`
  'input',
];

const ALLOWED_ATTR = [
  // Links + images
  'href', 'title', 'alt', 'src',
  // Tables
  'colspan', 'rowspan', 'align',
  // GFM task-list checkbox
  'type', 'checked', 'disabled',
  // Link-safety attrs (the afterSanitizeAttributes hook below sets both for
  // every external <a>)
  'target', 'rel',
  // Layout class hooks — `class` is allowed; `style` is not.
  'class',
];

// Link-safety hook: every <a href=...> is rewritten to open in a new tab AND
// carry rel="noopener noreferrer" so the opened page cannot navigate the kitp
// tab via window.opener (reverse-tabnabbing).
//
// Hook lives at module scope so it registers exactly once at first import —
// DOMPurify's addHook is global and stacking would otherwise run the same
// logic N times per sanitize call.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;
  if (el.tagName === 'A' && el.hasAttribute('href')) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
  // Disable any task-list checkbox so a viewer can't toggle it (the checkbox
  // is informational; the canonical state is the source Markdown, not the DOM).
  if (el.tagName === 'INPUT') {
    el.setAttribute('disabled', '');
  }
});

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // DOMPurify already enforces a URL scheme allowlist; this pins it explicitly
  // so a future maintainer can see what's permitted. `javascript:` and `data:`
  // are deliberately absent — `data:` URIs on <img> are how the old "tracking
  // pixel" trick survives a sanitizer that only blocks scheme-based exec.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#|\/)/i,
  // No event handlers, no foreign-namespace SVG/MathML.
  ALLOW_DATA_ATTR: false,
  USE_PROFILES: { html: true },
};

/**
 * Render a Markdown source string as sanitized HTML. The output is safe to
 * assign to `element.innerHTML` (do that ONLY through the `Markdown` helper in
 * markdown-control.ts, which is the single sink).
 *
 * Empty input short-circuits to empty output so callers don't have to guard.
 */
export function renderMarkdown(source: string): string {
  if (source === '') return '';
  const raw = marked.parse(source);
  const html = typeof raw === 'string' ? raw : '';
  // sanitize() may return TrustedHTML when DOMPurify's Trusted Types mode is
  // configured at the page level; we don't enable it, so the runtime result is
  // always a string. Coerce explicitly so callers get a plain string.
  return String(DOMPurify.sanitize(html, SANITIZE_CONFIG));
}

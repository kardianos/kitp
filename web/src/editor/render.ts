/**
 * Headless markdown -> DOM rendering, via prosemirror-model's DOMSerializer.
 *
 * This is the read-only display path: markdown is parsed to a document against
 * the editor schema (a whitelist), then rendered to real DOM nodes by walking
 * the schema's `toDOM` specs with `document.createElement` — never through an
 * HTML string / innerHTML. Embedded raw HTML is inert (the parser runs with
 * `html: false`), so there is no markup-injection surface to sanitize.
 *
 * Stage 4 points `util/markdown-control.ts`'s `setMarkdown` at this so the
 * editor and the renderer share ONE markdown definition (the schema) and the
 * `marked` + `dompurify` pair can retire.
 */

import { DOMSerializer } from '../../vendor/prosemirror.js';
import { editorSchema } from './schema.js';
import { parseMarkdown } from './markdown.js';

const domSerializer = DOMSerializer.fromSchema(editorSchema);

/** Render markdown source to a safe DOM fragment (no innerHTML, no sanitizer). */
export function renderMarkdownToFragment(markdown: string): DocumentFragment {
  const frag = domSerializer.serializeFragment(parseMarkdown(markdown).content);
  // Display hardening: external links open in a new tab WITHOUT leaking
  // window.opener (reverse-tabnabbing). markdown-it's validateLink already drops
  // javascript:/vbscript: schemes at parse, so no scheme rewrite is needed here.
  // The editor VIEW does not use this path — this is display-only.
  frag.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  // GFM task-list checkboxes are read-only in display (the source markdown is the
  // canonical state) — they are interactive only inside the editor.
  frag.querySelectorAll('.task-item input[type="checkbox"]').forEach((box) => {
    box.setAttribute('disabled', '');
  });
  return frag;
}

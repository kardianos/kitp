// Markdown rendering sink + control.
//
// `setMarkdown` is the ONE place in the web client that fills an element with
// rendered Markdown. It routes the source through the editor's render path
// (`renderMarkdownToFragment`, src/editor/render.ts), which parses Markdown
// against the editor schema (a whitelist) and builds real DOM nodes via
// prosemirror-model's DOMSerializer — `document.createElement`, never an HTML
// string / `innerHTML`. Embedded raw HTML is inert (the parser runs with
// `html: false`), so there is no markup-injection surface, and this sink does no
// string-HTML assignment at all.
//
// This replaced the former marked + DOMPurify pipeline: the editor and the
// renderer now share ONE Markdown definition (the ProseMirror schema). Known
// deltas from that pipeline (accepted): GFM task lists render as plain bullet
// items (no checkbox node), and `data:image/*` URLs are permitted by
// markdown-it's link validator. External links are still hardened (new tab +
// rel="noopener noreferrer") in render.ts.
//
// `Markdown` is an optional declarative control wrapping the sink. Task-detail
// and comments can either drop a `{ type: 'Markdown', source }` child into a
// screen config, or (more commonly) call `setMarkdown(el, text)` directly from
// their own render() to fill a description/comment-body element.

import { Control, type BaseControlConfig } from '../core/control.js';
import { renderMarkdownToFragment } from '../editor/render.js';

/**
 * Render `source` as DOM and inject it into `el`. This is the single sanctioned
 * Markdown sink; it replaces the element's children with a freshly-built,
 * createElement-based fragment (no `innerHTML`).
 *
 * Adds the `markdown md-body` classes (idempotent) so the typographic styling
 * in styles.css applies without each caller remembering to set them.
 */
export function setMarkdown(el: HTMLElement, source: string): void {
  el.classList.add('markdown', 'md-body');
  el.replaceChildren(renderMarkdownToFragment(source));
}

export interface MarkdownConfig extends BaseControlConfig {
  type: 'Markdown';
  /** Markdown source string. Static config value; for reactive sources, call
   *  `setMarkdown` from the owning control's effect instead. */
  source?: string;
  /** Extra class names appended to the wrapper element. */
  class?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    Markdown: MarkdownConfig;
  }
}

/**
 * Declarative Markdown control. Renders `config.source` once on mount through
 * the sink. The wrapper carries `markdown md-body` (+ any `config.class`) so
 * styles.css applies.
 */
export class Markdown extends Control<MarkdownConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.dataset.control = 'Markdown';
    return el;
  }

  protected render(): void {
    if (this.config.class) {
      for (const c of this.config.class.split(/\s+/).filter(Boolean)) {
        this.el.classList.add(c);
      }
    }
    setMarkdown(this.el, this.config.source ?? '');
  }
}

Control.register('Markdown', Markdown);

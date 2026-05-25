// Markdown rendering sink + control.
//
// `setMarkdown` is the ONE place in the web client that assigns rendered
// Markdown to `innerHTML`. It always routes the source through
// `renderMarkdown` (the marked + DOMPurify security boundary), so callers can
// never hand it raw, un-sanitized HTML. Isolating the single `innerHTML`
// assignment here keeps the XSS surface auditable: grep for `innerHTML` and
// this is the only hit for user content.
//
// `Markdown` is an optional declarative control wrapping the sink. Task-detail
// and comments can either drop a `{ type: 'Markdown', source }` child into a
// screen config, or (more commonly) call `setMarkdown(el, text)` directly from
// their own render() to fill a description/comment-body element.

import { Control, type BaseControlConfig } from '../core/control.js';
import { renderMarkdown } from './markdown.js';

/**
 * Render `source` as sanitized HTML and inject it into `el`. This is the
 * single sanctioned `innerHTML` sink for Markdown content; the assignment is
 * always fed `renderMarkdown(source)`, never a raw string.
 *
 * Adds the `markdown md-body` classes (idempotent) so the typographic styling
 * in styles.css applies without each caller remembering to set them.
 */
export function setMarkdown(el: HTMLElement, source: string): void {
  el.classList.add('markdown', 'md-body');
  // The ONLY innerHTML assignment of Markdown-derived content in the client.
  // renderMarkdown returns DOMPurify-sanitized HTML.
  el.innerHTML = renderMarkdown(source);
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
 * the sanitized sink. The wrapper carries `markdown md-body` (+ any
 * `config.class`) so styles.css applies.
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

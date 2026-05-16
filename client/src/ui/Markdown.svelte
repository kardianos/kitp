<script lang="ts">
  /**
   * Render a markdown string as sanitized HTML.
   *
   * Pipeline: marked → DOMPurify. Both are required:
   *   - marked converts CommonMark + GFM extensions to HTML.
   *   - DOMPurify strips anything that could execute or escape (script
   *     tags, javascript: hrefs, on* handlers, foreign-namespace
   *     elements). The card description is user-supplied — we trust no
   *     part of it.
   *
   * The {@html ...} below is what ships the sanitized HTML to the DOM.
   * Treat it like a security boundary: any future edit that bypasses
   * DOMPurify (e.g. swapping the sanitizer or rendering raw `marked`
   * output) re-introduces XSS.
   */
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';
  import { cx } from '../util/class_names';

  interface Props {
    /** Markdown source. */
    source: string;
    /** Extra Tailwind classes appended to the wrapper. */
    class?: string;
  }

  let { source, class: klass = '' }: Props = $props();

  // marked's parse() can return Promise<string> when async extensions are
  // installed; we don't install any, so the synchronous overload is what
  // we want. The `async: false` config also forces the sync return.
  marked.setOptions({ async: false, gfm: true, breaks: true });

  const rawHtml = $derived.by((): string => {
    if (source === '') return '';
    const out = marked.parse(source);
    return typeof out === 'string' ? out : '';
  });

  const safeHtml = $derived(DOMPurify.sanitize(rawHtml));
</script>

<!--
  `prose-like` lives in tailwind.config — it's our cut-down typographic
  ruleset (we don't pull in @tailwindcss/typography because the
  description box is small). The wrapping div centralises the styles
  rather than scattering them per-element.
-->
<div class={cx('markdown-body break-words text-sm leading-relaxed text-fg', klass)}>
  {@html safeHtml}
</div>

<style>
  /* Minimal markdown styling — kept inline because this is the only
     place we render markdown today. Promote to a global stylesheet if a
     second consumer appears. */
  .markdown-body :global(h1) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0.75rem 0 0.5rem;
  }
  .markdown-body :global(h2) {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0.6rem 0 0.4rem;
  }
  .markdown-body :global(h3) {
    font-size: 1rem;
    font-weight: 600;
    margin: 0.5rem 0 0.3rem;
  }
  .markdown-body :global(p) {
    margin: 0.4rem 0;
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: 0.4rem 0;
    padding-left: 1.4rem;
  }
  .markdown-body :global(ul) {
    list-style: disc;
  }
  .markdown-body :global(ol) {
    list-style: decimal;
  }
  .markdown-body :global(li) {
    margin: 0.15rem 0;
  }
  .markdown-body :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
    background: var(--color-surface);
    padding: 0.05em 0.3em;
    border-radius: 0.2em;
  }
  .markdown-body :global(pre) {
    background: var(--color-surface);
    padding: 0.6rem 0.8rem;
    border-radius: 0.3rem;
    overflow-x: auto;
    margin: 0.5rem 0;
  }
  .markdown-body :global(pre code) {
    background: transparent;
    padding: 0;
  }
  .markdown-body :global(blockquote) {
    border-left: 3px solid var(--color-border);
    padding-left: 0.75rem;
    margin: 0.5rem 0;
    color: var(--color-muted);
  }
  .markdown-body :global(a) {
    color: var(--color-accent);
    text-decoration: underline;
  }
  .markdown-body :global(a:hover) {
    text-decoration-thickness: 2px;
  }
  .markdown-body :global(table) {
    border-collapse: collapse;
    margin: 0.5rem 0;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--color-border);
    padding: 0.25rem 0.5rem;
  }
  /* Dark-mode tables: the default --color-border sits too close to the
     surface and the cell dividers nearly vanish. Bump to a derived
     value with more contrast. Same for hr below. */
  :global([data-theme='dark']) .markdown-body :global(th),
  :global([data-theme='dark']) .markdown-body :global(td) {
    border-color: color-mix(in srgb, var(--color-fg) 28%, transparent);
  }
  .markdown-body :global(hr) {
    border: 0;
    border-top: 1px solid var(--color-border);
    margin: 0.75rem 0;
  }
  :global([data-theme='dark']) .markdown-body :global(hr) {
    border-top-color: color-mix(in srgb, var(--color-fg) 28%, transparent);
  }
</style>

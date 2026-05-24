<script lang="ts">
  /**
   * Render a Markdown string as sanitized HTML.
   *
   * The marked + DOMPurify pipeline lives in `util/markdown.ts` so
   * its global configuration (link-safety hook, allowlist, marked
   * options) is installed exactly once at module load rather than
   * re-applied per component instance. Treat `renderMarkdown` as a
   * security boundary: any future caller that wants Markdown
   * rendering must go through it.
   */
  import { cx } from '../util/class_names';
  import { renderMarkdown } from '../util/markdown';

  interface Props {
    /** Markdown source. */
    source: string;
    /** Extra Tailwind classes appended to the wrapper. */
    class?: string;
  }

  let { source, class: klass = '' }: Props = $props();

  const safeHtml = $derived(renderMarkdown(source));
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

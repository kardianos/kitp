<!--
  PageShell — standard admin / list page layout.

  Replaces the 14 admin screens that hand-roll
    <div class="flex h-full flex-col">
      <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h1 class="text-lg font-semibold">Title</h1>
        <Button>+ New</Button>
      </header>
      ...main...
    </div>

  Slots:
    - title (string)            — H1 text
    - actions (Snippet, opt)    — right-aligned cluster in the header
    - children (Snippet)        — main content area
    - footer (Snippet, opt)     — sticky bottom bar (e.g. pagination)

  PageShell does NOT own modal/slideover state — open dialogs as
  siblings inside the screen. PageShell only owns the chrome.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cx } from '../util/class_names.js';

  interface Props {
    title: string;
    /** Optional sub-title rendered under the H1 (project context, etc.). */
    subtitle?: string;
    /** Padding on the main content area; default 'md'. */
    pad?: 'none' | 'sm' | 'md';
    /** data-testid for the outer wrapper, for e2e selectors. */
    testid?: string;
    actions?: Snippet;
    children: Snippet;
    footer?: Snippet;
  }

  let { title, subtitle, pad = 'md', testid, actions, children, footer }: Props = $props();

  const padClass = $derived(
    pad === 'none' ? '' : pad === 'sm' ? 'px-3 py-2' : 'px-4 py-4',
  );
</script>

<div class="flex h-full flex-col" data-testid={testid}>
  <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
    <div class="flex flex-col gap-0.5">
      <h1 class="text-lg font-semibold text-fg">{title}</h1>
      {#if subtitle}
        <p class="text-xs text-muted">{subtitle}</p>
      {/if}
    </div>
    {#if actions}
      <div class="flex items-center gap-2">
        {@render actions()}
      </div>
    {/if}
  </header>

  <main class={cx('flex-1 overflow-auto', padClass)}>
    {@render children()}
  </main>

  {#if footer}
    <footer class="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
      {@render footer()}
    </footer>
  {/if}
</div>

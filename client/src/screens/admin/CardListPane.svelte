<script lang="ts" generics="T extends { id: ID }">
  /**
   * Shared scaffolding for the three card-list panes in
   * AdminScreensScreen (projects / screens / filters). Each pane has the
   * same shape: a header strip, a scrollable list with an empty hint,
   * and an optional footer (for "+ Add …" controls). Per-row content is
   * the only thing that differs, so callers pass it as a snippet.
   *
   * Extracted from AdminScreensScreen specifically — keep it in the
   * admin folder until a second consumer surfaces and broader reuse
   * justifies promotion.
   */
  import type { Snippet } from 'svelte';

  import type { ID } from '../../reg/types';
  import { cx } from '../../util/class_names';

  interface Props<TItem> {
    /** ARIA label for the outer landmark. */
    ariaLabel: string;
    /** Which side has a border ("none" for the center pane). */
    border?: 'left' | 'right' | 'none';
    items: readonly TItem[];
    /** Sentence shown when `items` is empty. */
    emptyHint: string;
    /** Optional header bar above the list. */
    header?: Snippet;
    /** Per-item content. The component handles the `{#each}` key. */
    row: Snippet<[TItem, number]>;
    /** Optional footer below the list (e.g. "+ Add" controls). */
    footer?: Snippet;
  }

  let {
    ariaLabel,
    border = 'none',
    items,
    emptyHint,
    header,
    row,
    footer,
  }: Props<T> = $props();

  const borderClass = $derived.by((): string => {
    if (border === 'left') return 'border-l border-border';
    if (border === 'right') return 'border-r border-border';
    return '';
  });
</script>

<aside
  class={cx('flex min-h-0 flex-col overflow-y-auto', borderClass)}
  aria-label={ariaLabel}
>
  {#if header}{@render header()}{/if}
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if items.length === 0}
      <div class="p-3 text-center text-xs text-muted">{emptyHint}</div>
    {:else}
      <ul>
        {#each items as item, i (item.id)}
          <li>{@render row(item, i)}</li>
        {/each}
      </ul>
    {/if}
  </div>
  {#if footer}{@render footer()}{/if}
</aside>

<script lang="ts">
  /**
   * One row of the task-detail activity stream.
   *
   * Most kinds render as a single line ("alice changed status from todo to
   * done"); `comment` is the exception — its body is shown in a slightly
   * indented block with newlines preserved (`whitespace-pre-wrap`).
   *
   * Card links are rendered as buttons when `onOpenCard` is supplied so
   * keyboard users can activate them; otherwise they collapse to plain
   * text (read-only embed in a screen that has no router).
   */

  import type { ActivityRow, ID } from '../../reg/types.js';
  import { cx } from '../../util/class_names.js';
  import { formatActivityText, type IdMap } from './activity_text.js';
  import { formatRelativeTime } from './time.js';

  interface Props {
    row: ActivityRow;
    userNames?: IdMap;
    cardTitles?: IdMap;
    tagPaths?: IdMap;
    onOpenCard?: (cardId: ID) => void;
    class?: string;
  }

  let {
    row,
    userNames,
    cardTitles,
    tagPaths,
    onOpenCard,
    class: klass = '',
  }: Props = $props();

  const actor = $derived(userNames?.[row.actor_id.toString()] ?? `user#${row.actor_id}`);
  const relative = $derived(formatRelativeTime(row.created_at));
  const text = $derived(formatActivityText(row, userNames, cardTitles, tagPaths));

  function openCard(): void {
    onOpenCard?.(row.card_id);
  }

  function onLinkKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenCard?.(row.card_id);
    }
  }
</script>

<div class={cx('flex flex-col gap-1 py-1.5', klass)} data-activity-id={row.id}>
  <div class="text-[11px] text-muted">{relative}</div>
  {#if row.kind === 'comment'}
    <div class="rounded-md bg-surface p-2.5">
      <div class="text-xs font-semibold text-fg">{actor}</div>
      <div class="mt-1 whitespace-pre-wrap text-sm text-fg">
        {row.comment_body ?? ''}
      </div>
    </div>
  {:else if onOpenCard !== undefined &&
    (row.kind === 'card_create' || row.kind === 'card_delete' || row.kind === 'card_undelete' || row.kind === 'card_move')}
    <div class="text-sm text-fg">
      <span>{actor} </span>
      <button
        type="button"
        class="rounded text-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onclick={openCard}
        onkeydown={onLinkKeydown}
      >
        {row.kind === 'card_create'
          ? 'created the card'
          : row.kind === 'card_delete'
            ? 'deleted the card'
            : row.kind === 'card_undelete'
              ? 'restored the card'
              : 'moved the card'}
      </button>
      <span>.</span>
    </div>
  {:else}
    <div class="text-sm text-fg">{text}</div>
  {/if}
</div>

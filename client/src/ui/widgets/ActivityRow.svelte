<script lang="ts">
  /**
   * One row of the task-detail activity stream.
   *
   * Layout is intentionally tight: an inline line ("alice commented · 2h
   * ago") with the timestamp pushed to the right edge so the whole
   * stream reads as a single flowing list rather than a row of cards.
   * `comment` is the one kind that needs a second line — the body is
   * indented with a thin left-rule, no surface-coloured box.
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

  const isCardLink = $derived(
    onOpenCard !== undefined &&
      (row.kind === 'card_create' ||
        row.kind === 'card_delete' ||
        row.kind === 'card_undelete' ||
        row.kind === 'card_move'),
  );

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

{#if row.kind === 'comment'}
  <div class={cx('', klass)} data-activity-id={row.id}>
    <div class="flex items-baseline gap-1.5">
      <span class="font-medium text-fg">{actor}</span>
      <span class="text-muted">commented</span>
      <span class="ml-auto shrink-0 text-[11px] tabular-nums text-muted">{relative}</span>
    </div>
    <div class="ml-0.5 whitespace-pre-wrap border-l-2 border-fg/15 pl-2 text-fg">
      {row.comment_body ?? ''}
    </div>
  </div>
{:else if isCardLink}
  <div
    class={cx('flex items-baseline gap-1', klass)}
    data-activity-id={row.id}
  >
    <span class="text-fg">{actor}</span>
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
    <span class="text-fg">.</span>
    <span class="ml-auto shrink-0 text-[11px] tabular-nums text-muted">{relative}</span>
  </div>
{:else}
  <div
    class={cx('flex items-baseline gap-2', klass)}
    data-activity-id={row.id}
  >
    <span class="min-w-0 flex-1 text-fg">{text}</span>
    <span class="shrink-0 text-[11px] tabular-nums text-muted">{relative}</span>
  </div>
{/if}

<script lang="ts">
  /**
   * Reusable list-style row for one card. Used by the inbox, project list,
   * and search-results screens. Click anywhere → `onOpen()`; the row is
   * focusable and Enter / Space activate it.
   *
   * Renders, in order:
   *   `#id` · title · assignee chip · milestone ref · component ref ·
   *   tag chips · created date.
   *
   * Caller-provided lookup tables resolve numeric foreign keys to display
   * names; missing entries fall through to `#<id>` so we never blank-render.
   */

  import type { CardWithAttrs, ID } from '../../reg/types.js';
  import { cx } from '../../util/class_names.js';
  import Avatar from '../Avatar.svelte';
  import TagChip from './TagChip.svelte';
  import AttributeChip from './AttributeChip.svelte';
  import TerminalActionButton from './TerminalActionButton.svelte';

  interface Props {
    card: CardWithAttrs;
    selected?: boolean;
    onSelect?: () => void;
    onOpen?: () => void;
    /**
     * person card id -> display name. Keys are id.toString(). The
     * assignee attribute on `task` cards is now a card_ref to a `person`
     * card (post the user_account → person card refactor), so the chip
     * label resolves via this map.
     */
    personNames?: Record<string, string>;
    /** milestone/component ref id -> title. Keys are id.toString(). */
    cardTitles?: Record<string, string>;
    /** tag id -> path. Keys are id.toString(). */
    tagPaths?: Record<string, string>;
    /**
     * Terminal status value cards for this row's project. When provided
     * and the card isn't already terminal, a hover-revealed "Close ▾"
     * split button shows up on the right of the row. onTerminated fires
     * after a successful attribute.update so the caller can refresh.
     */
    terminalStatusOptions?: { id: ID; label: string }[];
    onTerminated?: () => void;
    class?: string;
  }

  let {
    card,
    selected = false,
    onSelect,
    onOpen,
    personNames,
    cardTitles,
    tagPaths,
    terminalStatusOptions,
    onTerminated,
    class: klass = '',
  }: Props = $props();

  const title = $derived.by(() => {
    const t = card.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    return '(untitled)';
  });

  const assigneeId = $derived.by(() => {
    const v = card.attributes['assignee'];
    return typeof v === 'bigint' ? v : undefined;
  });
  const assigneeName = $derived.by(() => {
    if (assigneeId === undefined) return undefined;
    const k = assigneeId.toString();
    return personNames?.[k] ?? `#${k}`;
  });

  const milestoneId = $derived.by(() => {
    const v = card.attributes['milestone_ref'];
    return typeof v === 'bigint' ? v : undefined;
  });
  const milestoneText = $derived.by(() => {
    if (milestoneId === undefined) return undefined;
    const k = milestoneId.toString();
    return cardTitles?.[k] ?? `#${k}`;
  });

  const componentId = $derived.by(() => {
    const v = card.attributes['component_ref'];
    return typeof v === 'bigint' ? v : undefined;
  });
  const componentText = $derived.by(() => {
    if (componentId === undefined) return undefined;
    const k = componentId.toString();
    return cardTitles?.[k] ?? `#${k}`;
  });

  const tagIds = $derived.by((): bigint[] => {
    const raw = card.attributes['tags'];
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is bigint => typeof v === 'bigint');
  });

  const createdAt = $derived.by(() => {
    const v = card.attributes['created_at'];
    if (typeof v === 'string' && v.length >= 10) return v.slice(0, 10);
    return undefined;
  });

  const currentStatusId = $derived.by((): ID | null => {
    const v = card.attributes['status'];
    return typeof v === 'bigint' ? v : null;
  });

  function handleClick(): void {
    onOpen?.();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen?.();
    }
  }

  function handleFocus(): void {
    onSelect?.();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<div
  role="button"
  tabindex="0"
  data-selected={selected ? 'true' : undefined}
  data-card-id={card.id}
  class={cx(
    'group flex w-full flex-col gap-2 rounded-md border border-border bg-bg p-3 text-left',
    'transition-colors hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    'data-[selected=true]:border-accent data-[selected=true]:bg-surface',
    'sm:flex-row sm:items-center',
    klass,
  )}
  onclick={handleClick}
  onkeydown={handleKeydown}
  onfocus={handleFocus}
>
  <div class="flex min-w-0 flex-1 flex-col gap-1.5">
    <div class="flex min-w-0 items-baseline gap-2">
      <span class="shrink-0 font-mono text-xs text-muted">#{card.id}</span>
      <span class="truncate text-sm font-medium text-fg">{title}</span>
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      {#if assigneeName !== undefined}
        <span class="inline-flex items-center gap-1">
          <Avatar name={assigneeName} size="sm" />
          <span class="text-xs text-muted">{assigneeName}</span>
        </span>
      {/if}
      {#if milestoneText !== undefined}
        <AttributeChip label="milestone" value={milestoneText} />
      {/if}
      {#if componentText !== undefined}
        <AttributeChip label="component" value={componentText} />
      {/if}
      {#each tagIds as tid (tid)}
        {@const path = tagPaths?.[tid.toString()] ?? `#${tid}`}
        <TagChip label={path} />
      {/each}
    </div>
  </div>
  {#if createdAt !== undefined}
    <div class="shrink-0 text-xs text-muted sm:ml-3">{createdAt}</div>
  {/if}
  {#if terminalStatusOptions !== undefined && terminalStatusOptions.length > 0}
    <!-- Stop propagation: the row's outer onclick navigates to the task
         detail, which would race the attribute update on a stray menu
         click. The component itself stops propagation on its inner
         buttons too, but the wrapping div is the right safety net. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 sm:ml-2"
      onclick={(e) => e.stopPropagation()}
    >
      <TerminalActionButton
        cardId={card.id}
        attributeName="status"
        terminalOptions={terminalStatusOptions}
        currentValue={currentStatusId}
        compact
        onChanged={() => onTerminated?.()}
      />
    </div>
  {/if}
</div>

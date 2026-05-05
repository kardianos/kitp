<script lang="ts">
  /**
   * Reusable list-style row for one card. Used by the inbox, project list,
   * and search-results screens. Click anywhere → `onOpen()`; the row is
   * focusable and Enter / Space activate it.
   *
   * Renders, in order:
   *   `#id` · title · status chip · assignee chip · milestone ref ·
   *   component ref · tag chips · created date.
   *
   * Caller-provided lookup tables resolve numeric foreign keys to display
   * names; missing entries fall through to `#<id>` so we never blank-render.
   */

  import type { CardWithAttrs } from '../../reg/types.js';
  import { cx } from '../../util/class_names.js';
  import Avatar from '../Avatar.svelte';
  import Chip from '../Chip.svelte';
  import TagChip from './TagChip.svelte';
  import AttributeChip from './AttributeChip.svelte';
  import { statusColor } from './activity_text.js';

  interface Props {
    card: CardWithAttrs;
    selected?: boolean;
    onSelect?: () => void;
    onOpen?: () => void;
    /** assignee_id -> display name */
    userNames?: Record<number, string>;
    /** milestone/component ref id -> title */
    cardTitles?: Record<number, string>;
    /** tag id -> path */
    tagPaths?: Record<number, string>;
    class?: string;
  }

  let {
    card,
    selected = false,
    onSelect,
    onOpen,
    userNames,
    cardTitles,
    tagPaths,
    class: klass = '',
  }: Props = $props();

  const title = $derived.by(() => {
    const t = card.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    return '(untitled)';
  });

  const status = $derived(card.attributes['status']);
  const statusText = $derived(typeof status === 'string' ? status : '');
  const statusHint = $derived(statusColor(status));

  const assigneeId = $derived.by(() => {
    const v = card.attributes['assignee'];
    return typeof v === 'number' ? v : undefined;
  });
  const assigneeName = $derived.by(() => {
    if (assigneeId === undefined) return undefined;
    return userNames?.[assigneeId] ?? `#${assigneeId}`;
  });

  const milestoneId = $derived.by(() => {
    const v = card.attributes['milestone_ref'];
    return typeof v === 'number' ? v : undefined;
  });
  const milestoneText = $derived.by(() => {
    if (milestoneId === undefined) return undefined;
    return cardTitles?.[milestoneId] ?? `#${milestoneId}`;
  });

  const componentId = $derived.by(() => {
    const v = card.attributes['component_ref'];
    return typeof v === 'number' ? v : undefined;
  });
  const componentText = $derived.by(() => {
    if (componentId === undefined) return undefined;
    return cardTitles?.[componentId] ?? `#${componentId}`;
  });

  const tagIds = $derived.by((): number[] => {
    const raw = card.attributes['tags'];
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is number => typeof v === 'number');
  });

  const createdAt = $derived.by(() => {
    const v = card.attributes['created_at'];
    if (typeof v === 'string' && v.length >= 10) return v.slice(0, 10);
    return undefined;
  });

  /**
   * Map our coarse status hint onto Chip's variant set. The Chip primitive
   * only ships three variants (default / accent / danger); 'doing' / 'done'
   * map to accent; 'review' falls back to default to keep the contract
   * tight. Tests verify the underlying mapping (`statusColor`); the visual
   * choice here is incidental.
   */
  const statusVariant = $derived.by((): 'default' | 'accent' | 'danger' => {
    switch (statusHint) {
      case 'blue':
      case 'green':
        return 'accent';
      case 'amber':
        return 'default';
      default:
        return 'default';
    }
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
    'flex w-full flex-col gap-2 rounded-md border border-border bg-bg p-3 text-left',
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
      {#if statusText !== ''}
        <Chip
          label={statusText}
          variant={statusVariant}
          class="data-[hint={statusHint}]"
        />
      {/if}
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
        {@const path = tagPaths?.[tid] ?? `#${tid}`}
        <TagChip label={path} />
      {/each}
    </div>
  </div>
  {#if createdAt !== undefined}
    <div class="shrink-0 text-xs text-muted sm:ml-3">{createdAt}</div>
  {/if}
</div>

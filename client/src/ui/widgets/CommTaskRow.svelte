<script lang="ts">
  /**
   * Comms-screen variant of {@link TaskRow}. Used by ListLayout when the
   * active screen's `slug === 'comms'`.
   *
   * Differs from the regular TaskRow in:
   *   - Renders a `comm_status` badge with phase-based colour (active=blue,
   *     terminal=green, triage=muted) alongside the standard task fields.
   *   - Shows the last few replies inline (oldest first; the full chain
   *     lives on the Task detail screen).
   *   - Surfaces a "Reply" button that expands into an inline composer
   *     (in-row expanding section — no modal). Send fires `reply.post`
   *     and calls `onReplySent` so the parent can refresh.
   *   - When a TransitionBar should run on the comm itself (the comm has
   *     its own `comm_status` flow), the row exposes a comm-side
   *     TransitionBar in addition to the standard hover-revealed task
   *     transitions.
   *
   * Open-in-detail still navigates to the *task*'s detail screen — comms
   * don't have their own detail page in v1; the task page is the read-only
   * hub for the comm's reply history.
   */

  import { getDispatcher } from '../../dispatch/context';
  import { replyPost } from '../../reg/handlers';
  import type {
    CommRow,
    ID,
    ReplyPostInput,
    ReplyPostOutput,
    ReplyRow,
    TransitionRow,
  } from '../../reg/types';
  import { notify } from '../toast.svelte';
  import { cx } from '../../util/class_names';
  import {
    commStatusLabel,
    commStatusTone,
    defaultReplySubject,
    defaultReplyTo,
    lastNReplies,
    replyPostPayload,
    type CommStatusPhase,
  } from '../../screens/comm_helpers';
  import Avatar from '../Avatar.svelte';
  import Button from '../Button.svelte';
  import TagChip from './TagChip.svelte';
  import AttributeChip from './AttributeChip.svelte';
  import TransitionBar from './TransitionBar.svelte';

  /**
   * Props mirror {@link TaskRow.Props} where overlapping; comm-specific
   * additions follow. The shape is intentionally explicit so the row
   * remains testable from the dispatched callsite and the parent owns
   * the data-fetch lifecycle.
   */
  interface Props {
    /** The task card the comm is attached to — drives title / row layout. */
    card: import('../../reg/types').CardWithAttrs;
    /** The comm card (hydrated with replies) — drives the comms section. */
    comm: CommRow;
    /** Phase string for `comm.comm_status`; falls through to 'active'. */
    commStatusPhase?: CommStatusPhase | string;
    /** comm_status value-card id → title lookup so the badge can render text. */
    commStatusTitles?: Record<string, string>;
    selected?: boolean;
    onSelect?: () => void;
    onOpen?: () => void;
    /** person card id -> display name. */
    personNames?: Record<string, string>;
    /** milestone / component ref id -> title. */
    cardTitles?: Record<string, string>;
    /** tag id -> path. */
    tagPaths?: Record<string, string>;
    /** Task-side transitions (status flow). Passed to the regular hover bar. */
    transitions?: TransitionRow[];
    /** Comm-side transitions (comm_status flow). Renders its own bar below the reply list. */
    commTransitions?: TransitionRow[];
    /** Fired after a successful reply.post so the parent can refresh. */
    onReplySent?: () => void;
    /** Fired when any flow attribute.update succeeds (task or comm). */
    onTransitioned?: () => void;
    /** Max inline replies in the row variant. */
    inlineReplyLimit?: number;
    class?: string;
  }

  let {
    card,
    comm,
    commStatusPhase = 'active',
    commStatusTitles = {},
    selected = false,
    onSelect,
    onOpen,
    personNames,
    cardTitles,
    tagPaths,
    transitions,
    commTransitions,
    onReplySent,
    onTransitioned,
    inlineReplyLimit = 3,
    class: klass = '',
  }: Props = $props();

  const dispatcher = getDispatcher();

  /* ---------------------------------------------------- derived row fields */

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

  /* ------------------------------------------------ comm status badge */

  const commStatusText = $derived(commStatusLabel(comm.comm_status, commStatusTitles));
  const commStatusToneClass = $derived.by(() => {
    const tone = commStatusTone(commStatusPhase);
    if (tone === 'blue') return 'border-accent/40 bg-accent/10 text-accent';
    if (tone === 'green') return 'border-success/40 bg-success/10 text-success';
    return 'border-border bg-surface text-muted';
  });

  /* ----------------------------------------------------- inline replies */

  const inlineReplies = $derived(lastNReplies(comm.replies, inlineReplyLimit));

  /* ----------------------------------------------------- reply composer */

  let composerOpen = $state(false);
  let toField = $state('');
  let subjectField = $state('');
  let bodyField = $state('');
  let sending = $state(false);

  function openComposer(): void {
    if (composerOpen) return;
    toField = defaultReplyTo(comm.replies);
    subjectField = defaultReplySubject(comm, comm.replies);
    bodyField = '';
    composerOpen = true;
  }

  function closeComposer(): void {
    composerOpen = false;
    toField = '';
    subjectField = '';
    bodyField = '';
  }

  async function sendReply(): Promise<void> {
    if (sending) return;
    const to = toField.trim();
    const body = bodyField.trim();
    if (to === '' || body === '') {
      notify({ type: 'error', message: 'Recipient and body are required.' });
      return;
    }
    sending = true;
    try {
      await dispatcher.request<ReplyPostInput, ReplyPostOutput>({
        endpoint: replyPost.endpoint,
        action: replyPost.action,
        data: replyPostPayload(comm.id, to, subjectField.trim(), body),
      });
      notify({ type: 'success', message: 'Reply sent' });
      closeComposer();
      onReplySent?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: msg.length > 0 ? msg : 'Failed to post reply' });
    } finally {
      sending = false;
    }
  }

  /* ----------------------------------------------------- event handlers */

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

  function onBodyKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void sendReply();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<div
  role="button"
  tabindex="0"
  data-testid="comm-task-row"
  data-selected={selected ? 'true' : undefined}
  data-card-id={card.id}
  data-comm-id={comm.id}
  class={cx(
    'group flex w-full flex-col gap-2 rounded-md border border-border bg-bg p-3 text-left',
    'transition-colors hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    'data-[selected=true]:border-accent data-[selected=true]:bg-surface',
    klass,
  )}
  onclick={handleClick}
  onkeydown={handleKeydown}
  onfocus={handleFocus}
>
  <!-- header row: id + title + comm status badge + task-side transitions -->
  <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
      <div class="flex min-w-0 items-baseline gap-2">
        <span class="shrink-0 font-mono text-xs text-muted">#{card.id}</span>
        <span class="truncate text-sm font-medium text-fg">{title}</span>
        {#if commStatusText !== ''}
          <span
            class={cx(
              'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
              commStatusToneClass,
            )}
            data-testid="comm-status-badge"
            data-comm-status-phase={commStatusPhase}
            title="Comm status"
          >
            {commStatusText}
          </span>
        {/if}
        <span
          class="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted"
          data-testid="comm-thread-id"
          title="Thread id"
        >
          #{comm.thread_id}
        </span>
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
    {#if transitions !== undefined && transitions.length > 0}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        onclick={(e) => e.stopPropagation()}
      >
        <TransitionBar
          cardId={card.id}
          {transitions}
          variant="row"
          onChanged={() => onTransitioned?.()}
        />
      </div>
    {/if}
  </div>

  <!-- inline replies (last N), reply button, and comm-side TransitionBar -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="flex flex-col gap-2 border-t border-border/60 pt-2"
    onclick={(e) => e.stopPropagation()}
  >
    {#if inlineReplies.length === 0}
      <p class="text-xs italic text-muted" data-testid="comm-no-replies">
        No replies yet.
      </p>
    {:else}
      <ul class="flex flex-col gap-1" data-testid="comm-inline-replies">
        {#each inlineReplies as r (r.id)}
          <li
            class={cx(
              'flex flex-col rounded-md border border-border/60 px-2 py-1 text-xs',
              r.delivery_status === 'received' ? 'bg-surface/40' : 'bg-bg',
            )}
            data-testid="comm-inline-reply"
            data-reply-id={r.id}
            data-delivery-status={r.delivery_status}
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate font-medium text-fg">
                {r.delivery_status === 'received' ? r.from : r.to}
              </span>
              <span
                class="shrink-0 rounded bg-surface px-1 text-[10px] uppercase tracking-wider text-muted"
                data-testid="comm-reply-status"
              >
                {r.delivery_status}
              </span>
            </div>
            {#if r.body_text !== ''}
              <p class="mt-0.5 line-clamp-2 whitespace-pre-wrap text-muted">{r.body_text}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="flex flex-wrap items-center justify-between gap-2">
      {#if commTransitions !== undefined && commTransitions.length > 0}
        <TransitionBar
          cardId={comm.id}
          transitions={commTransitions}
          variant="row"
          onChanged={() => onTransitioned?.()}
        />
      {:else}
        <span></span>
      {/if}
      {#if !composerOpen}
        <span data-testid="comm-reply-button">
          <Button
            size="sm"
            variant="secondary"
            onclick={openComposer}
          >
            {#snippet children()}Reply{/snippet}
          </Button>
        </span>
      {/if}
    </div>

    {#if composerOpen}
      <div
        class="flex flex-col gap-2 rounded-md border border-border bg-surface/30 p-2"
        data-testid="comm-reply-composer"
      >
        <label class="flex flex-col gap-1 text-xs text-muted">
          <span>To</span>
          <input
            bind:value={toField}
            type="text"
            data-testid="comm-reply-to"
            placeholder="recipient@example.com"
            class="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">
          <span>Subject</span>
          <input
            bind:value={subjectField}
            type="text"
            data-testid="comm-reply-subject"
            placeholder="Re: …"
            class="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">
          <span>Body</span>
          <textarea
            bind:value={bodyField}
            rows="4"
            data-testid="comm-reply-body"
            placeholder="Write your reply… (Mod+Enter to send)"
            class="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            onkeydown={onBodyKeydown}
          ></textarea>
        </label>
        <div class="flex justify-end gap-2">
          <span data-testid="comm-reply-cancel">
            <Button
              size="sm"
              variant="ghost"
              onclick={closeComposer}
              disabled={sending}
            >
              {#snippet children()}Cancel{/snippet}
            </Button>
          </span>
          <span data-testid="comm-reply-send">
            <Button
              size="sm"
              variant="primary"
              onclick={() => void sendReply()}
              loading={sending}
              disabled={toField.trim() === '' || bodyField.trim() === ''}
            >
              {#snippet children()}Send{/snippet}
            </Button>
          </span>
        </div>
      </div>
    {/if}
  </div>
</div>

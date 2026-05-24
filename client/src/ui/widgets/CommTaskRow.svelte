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
  import { attachmentList, commSetRecipients, replyPost } from '../../reg/handlers';
  import type {
    AttachmentListInput,
    AttachmentListOutput,
    AttachmentRow,
    CardWithAttrs,
    CommRow,
    CommSetRecipientsInput,
    CommSetRecipientsOutput,
    ID,
    ReplyPostInput,
    ReplyPostOutput,
    TransitionRow,
  } from '../../reg/types';
  import { notify } from '../toast.svelte';
  import { cx } from '../../util/class_names';
  import {
    commStatusLabel,
    commStatusTone,
    lastNReplies,
    type CommStatusPhase,
  } from '../../screens/comm_helpers';
  import Avatar from '../Avatar.svelte';
  import Button from '../Button.svelte';
  import Chip from '../Chip.svelte';
  import RecipientsPicker from '../RecipientsPicker.svelte';
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
    /**
     * All person cards (CardWithAttrs[]) the recipient picker should
     * see. Required for editing recipients inline; if omitted, the
     * Edit-recipients affordance hides.
     */
    persons?: readonly CardWithAttrs[];
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
    persons = [],
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
  let bodyField = $state('');
  let sending = $state(false);

  // Attachment-picker state. The list is lazy-loaded on first compose
  // so a screen rendering many comm rows pays nothing until the user
  // actually opens a composer. SHA-based round-trip dedup lives
  // entirely on the server side (file.sha256 + IMAP ingest path); the
  // client just submits the chosen attachment ids.
  let taskAttachments = $state<readonly AttachmentRow[]>([]);
  let attachmentsLoading = $state(false);
  let attachmentsLoaded = $state(false);
  let selectedAttachmentIds = $state<ID[]>([]);

  async function loadTaskAttachments(): Promise<void> {
    if (attachmentsLoaded || attachmentsLoading) return;
    attachmentsLoading = true;
    try {
      const out = await dispatcher.request<AttachmentListInput, AttachmentListOutput>({
        endpoint: attachmentList.endpoint,
        action: attachmentList.action,
        data: { cardId: card.id },
      });
      taskAttachments = out.rows;
      attachmentsLoaded = true;
    } catch (e) {
      // Don't toast on this — the composer still works for body-only
      // replies. The user just won't see the attachment picker.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('comm reply: load attachments failed', msg);
    } finally {
      attachmentsLoading = false;
    }
  }

  function toggleAttachment(id: ID): void {
    if (selectedAttachmentIds.includes(id)) {
      selectedAttachmentIds = selectedAttachmentIds.filter((x) => x !== id);
    } else {
      selectedAttachmentIds = [...selectedAttachmentIds, id];
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Recipient editor state — mirrors comm.recipients while open so the
  // user can revise the list before committing via comm.set_recipients.
  let editingRecipients = $state(false);
  let recipientsDraft = $state<ID[]>([]);
  let savingRecipients = $state(false);

  // Local copy of the comm's recipient list. Bumped from the comm prop
  // and from successful comm.set_recipients writes so the chip strip +
  // Send button reflect the latest state without waiting for the parent
  // to refetch.
  let localRecipients = $derived<ID[]>([...comm.recipients]);

  function openComposer(): void {
    if (composerOpen) return;
    bodyField = '';
    selectedAttachmentIds = [];
    composerOpen = true;
    // Lazy-load the task's existing attachments so the picker has
    // something to render. Cached for the lifetime of the row; a
    // refresh after sending re-fetches if the count looks stale.
    void loadTaskAttachments();
  }

  function closeComposer(): void {
    composerOpen = false;
    bodyField = '';
    selectedAttachmentIds = [];
    closeRecipientEditor();
  }

  function openRecipientEditor(): void {
    recipientsDraft = [...localRecipients];
    editingRecipients = true;
  }

  function closeRecipientEditor(): void {
    editingRecipients = false;
    recipientsDraft = [];
  }

  async function saveRecipients(): Promise<void> {
    if (savingRecipients) return;
    savingRecipients = true;
    try {
      await dispatcher.request<CommSetRecipientsInput, CommSetRecipientsOutput>({
        endpoint: commSetRecipients.endpoint,
        action: commSetRecipients.action,
        data: { commId: comm.id, recipientPersonIds: recipientsDraft },
      });
      // Mirror back into the live view so the chip strip + Send-disabled
      // state both reflect the new list immediately.
      localRecipients = [...recipientsDraft];
      closeRecipientEditor();
      onReplySent?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: msg.length > 0 ? msg : 'Failed to update recipients' });
    } finally {
      savingRecipients = false;
    }
  }

  async function sendReply(): Promise<void> {
    if (sending) return;
    const body = bodyField.trim();
    if (body === '') {
      notify({ type: 'error', message: 'Body is required.' });
      return;
    }
    if (localRecipients.length === 0) {
      notify({ type: 'error', message: 'Add at least one recipient before sending.' });
      return;
    }
    sending = true;
    try {
      const data: ReplyPostInput = { commId: comm.id, body };
      if (selectedAttachmentIds.length > 0) {
        data.attachmentIds = selectedAttachmentIds;
      }
      await dispatcher.request<ReplyPostInput, ReplyPostOutput>({
        endpoint: replyPost.endpoint,
        action: replyPost.action,
        data,
      });
      const summary = selectedAttachmentIds.length > 0
        ? `Reply sent (${selectedAttachmentIds.length} attachment${selectedAttachmentIds.length === 1 ? '' : 's'})`
        : 'Reply sent';
      notify({ type: 'success', message: summary });
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
        <div class="flex flex-col gap-1 text-xs text-muted">
          <div class="flex items-baseline justify-between gap-2">
            <span>To</span>
            {#if persons.length > 0 && !editingRecipients}
              <button
                type="button"
                class="text-xs text-accent hover:underline"
                onclick={openRecipientEditor}
                data-testid="comm-reply-edit-recipients"
              >
                Edit
              </button>
            {/if}
          </div>
          {#if editingRecipients}
            <RecipientsPicker
              bind:value={recipientsDraft}
              persons={[...persons]}
              aria-label="Comm recipients"
            />
            <div class="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onclick={closeRecipientEditor}
                disabled={savingRecipients}
              >
                {#snippet children()}Cancel{/snippet}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onclick={() => void saveRecipients()}
                loading={savingRecipients}
              >
                {#snippet children()}Save recipients{/snippet}
              </Button>
            </div>
          {:else if localRecipients.length === 0}
            <span class="text-fg" data-testid="comm-reply-no-recipients">
              No recipients yet — click <em>Edit</em> to add one.
            </span>
          {:else}
            <div class="flex flex-wrap gap-1" data-testid="comm-reply-to">
              {#each localRecipients as pid (pid)}
                <Chip label={personNames?.[pid.toString()] ?? `#${pid}`} />
              {/each}
            </div>
          {/if}
        </div>
        <div class="text-xs text-muted">
          Subject: <span class="font-mono">{comm.thread_id}</span> · {title}
        </div>
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
        <!--
          Attachment picker. Lists existing attachments on the parent
          task; checking one sends a wire reference to the server,
          which joins through reply_body_attachment + cas_blob_data to
          ship the bytes as MIME parts. Round-trip dedup happens on
          IMAP ingest via file.sha256 — the user can't accidentally
          create a duplicate by selecting an attachment that already
          rode this thread.
        -->
        {#if attachmentsLoading}
          <div class="text-xs text-muted">Loading attachments…</div>
        {:else if taskAttachments.length > 0}
          <div class="flex flex-col gap-1" data-testid="comm-reply-attachments">
            <div class="text-xs text-muted">Attach from this task</div>
            <ul class="flex max-h-32 flex-col gap-0.5 overflow-auto rounded-md border border-border bg-bg p-1 text-sm">
              {#each taskAttachments as a (a.id)}
                {@const checked = selectedAttachmentIds.includes(a.id)}
                <li class="flex items-center gap-2 px-1 py-0.5 hover:bg-surface">
                  <label class="flex flex-1 cursor-pointer items-center gap-2 truncate">
                    <input
                      type="checkbox"
                      class="h-3.5 w-3.5 accent-current text-accent"
                      {checked}
                      onchange={() => toggleAttachment(a.id)}
                      data-testid="comm-reply-attachment-{a.id}"
                    />
                    <span class="truncate text-fg">{a.filename}</span>
                  </label>
                  <span class="shrink-0 text-xs text-muted">{formatBytes(a.size_bytes)}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
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
              disabled={bodyField.trim() === '' || localRecipients.length === 0}
            >
              {#snippet children()}Send{/snippet}
            </Button>
          </span>
        </div>
      </div>
    {/if}
  </div>
</div>

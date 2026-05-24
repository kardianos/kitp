<!--
  TaskDetailScreen — full per-card lifecycle: title editor, description,
  attribute panel, activity stream, comment composer.

  Layout: two-column on viewports ≥ 700px (main column + 280px right
  rail). Below that we collapse to a single column so the side panel
  doesn't squeeze the description.

  Dispatcher contract:
    - On mount: ONE batch with eight sub-requests (task + activity +
      milestones + components + tags + users + persons + attribute_def).
      All eight `request()` calls happen in the same render tick so the
      dispatcher coalesces them into one POST. `users` powers the
      activity stream's actor labels; `persons` powers the assignee
      picker — post-refactor the `assignee` attribute is a card_ref to
      a `person` card, not a `user_account` ref.
    - Title / description / attribute commits issue ONE batch
      (attribute.update) followed by a refresh batch.
    - Comment posts and tag apply/remove each issue ONE batch followed
      by refresh.

  Ports `client/lib/ui/screens/task_detail_screen.dart` (759 LOC).
-->
<script lang="ts">
  import { getContext, tick, untrack } from 'svelte';
  import type { AuthState } from '../auth/auth_state.svelte';
  import { getDispatcher } from '../dispatch/context';
  import { clearHelpTopic, setHelpTopic } from '../help/help_context.svelte';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { goBackOrFallback, navigate } from '../routing/router.svelte';
  import { taskNavList } from '../routing/task_nav_list.svelte';
  import { notify } from '../ui/toast.svelte';
  import Button from '../ui/Button.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Markdown from '../ui/Markdown.svelte';
  import AutoGrowTextarea from '../ui/inputs/AutoGrowTextarea.svelte';
  import { formatRelativeTime } from '../ui/widgets/time';
  import Spinner from '../ui/Spinner.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import RecipientsPicker from '../ui/RecipientsPicker.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import ActivityRowView from '../ui/widgets/ActivityRow.svelte';
  import TagChip from '../ui/widgets/TagChip.svelte';
  import AttachmentsSection from '../ui/widgets/AttachmentsSection.svelte';
  import MoveTaskDialog from '../ui/widgets/MoveTaskDialog.svelte';
  import PurgeTaskDialog from '../ui/widgets/PurgeTaskDialog.svelte';
  import RelatedTasksPanel from '../ui/widgets/RelatedTasksPanel.svelte';
  import QuickEntryOverlay from '../quick_entry/QuickEntryOverlay.svelte';
  import { useQuickEntry } from '../quick_entry/use_quick_entry.svelte';
  import AttachmentsPreviewStrip from '../ui/widgets/AttachmentsPreviewStrip.svelte';
  import AttributeSidePanel from '../ui/widgets/AttributeSidePanel.svelte';
  import TransitionBar from '../ui/widgets/TransitionBar.svelte';
  import { isAssignablePerson } from '../util/person';
  import { sharedSchemaCache } from '../filter/attribute_schema.svelte';
  import type { FilterAttribute } from '../filter/attribute_schema.svelte';
  import type {
    ActivityRow,
    ActivitySelectInput,
    ActivitySelectOutput,
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSearchInput,
    CardSearchOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ChannelListInput,
    ChannelListOutput,
    ChannelRow,
    CommCreateInput,
    CommCreateOutput,
    CommListForTaskInput,
    CommListForTaskOutput,
    CommRow,
    CommentInsertInput,
    CommentInsertOutput,
    CommentUpdateInput,
    CommentUpdateOutput,
    FlowStepListForCardInput,
    FlowStepListForCardOutput,
    ID,
    TagApplyInput,
    TagApplyOutput,
    TagRemoveInput,
    TagRemoveOutput,
    TransitionRow,
    UserRow,
    UserSelectInput,
    UserSelectOutput,
  } from '../reg/types';
  import {
    commChannelList,
    commCreate,
    commListForTask,
    flowStepListForCard,
  } from '../reg/handlers';
  import {
    commStatusLabel,
    commStatusTone,
    sortRepliesAsc,
  } from './comm_helpers';
  import {
    activitySelect,
    appliedTagIds,
    applyTagPayload,
    attributeUpdate,
    cardSearch,
    cardSelectWithAttributes,
    cardTitleMap,
    commentInsert,
    commentInsertPayload,
    commentUpdate,
    commitDescriptionPayload,
    commitTitlePayload,
    personNameMap,
    pickTaskById,
    removeTagPayload,
    sortActivityDesc,
    tagApply,
    tagPathMap,
    tagRemove,
    userNameMap,
    userSelect,
    ACTIVITY_LIMIT,
  } from './task_detail_helpers';

  setActiveScope('task_detail');

  $effect(() => {
    setHelpTopic({ kind: 'topic', topic: 'task_detail' });
    return () => clearHelpTopic();
  });

  /* -------------------------------------------------------------------- */
  /* Props + dispatcher                                                   */
  /* -------------------------------------------------------------------- */

  interface Props {
    params?: Record<string, string>;
  }
  let { params = {} }: Props = $props();
  // The route pattern is `/task/:id`; default to 0 if the param is
  // malformed (the screen renders a "task not found" empty state once
  // the load resolves).
  const taskId = $derived.by((): ID => {
    const raw = params.id ?? '';
    if (raw === '') return 0n;
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  });

  const dispatcher = getDispatcher();
  const schemaCache = sharedSchemaCache(dispatcher);
  const authState = getContext<AuthState | undefined>('authState');

  /* -------------------------------------------------------------------- */
  /* Reactive state                                                       */
  /* -------------------------------------------------------------------- */

  let task = $state<CardWithAttrs | null>(null);
  /** Every task card visible to the user. Sourced from the same
   *  `card.select_with_attributes(card_type=task)` request that fetches
   *  the focal task, so feeding the RelatedTasksPanel costs zero extra
   *  round-trips. Parent + children are derived from this list. */
  let allTasks = $state<readonly CardWithAttrs[]>([]);
  let activity = $state<readonly ActivityRow[]>([]);
  let milestones = $state<readonly CardWithAttrs[]>([]);
  let components = $state<readonly CardWithAttrs[]>([]);
  let tagCards = $state<readonly CardWithAttrs[]>([]);
  let statusCards = $state<readonly CardWithAttrs[]>([]);
  /**
   * Read-only comm list for the "Comms" section between Activity and
   * Comments. Spec §"What about the Task detail view?" explicitly says
   * the Reply action is NOT available on Task detail — users navigate to
   * the Comms screen to author replies. We only render title, status,
   * thread id, and the reply chain here.
   */
  let comms = $state<readonly CommRow[]>([]);
  /**
   * Two-way bound to RelatedTasksPanel so the `e p` chord can pop the
   * parent picker from anywhere on the screen. The panel also flips
   * this on its "+ Set parent" button click, so click and chord share
   * one state.
   */
  let parentPickerOpen = $state(false);
  /**
   * Two-way bound for the "Add existing child" picker. `e a` flips
   * this so the search Combobox auto-opens with focus on its query
   * input.
   */
  let childPickerOpen = $state(false);
  /** Open / close state for the cross-project move dialog. */
  let moveDialogOpen = $state(false);
  /** Open / close state for the hard-delete (task.purge) confirm
   *  dialog. Reachable only from the header kebab; gated by a
   *  type-the-title confirm inside the dialog itself. */
  let purgeDialogOpen = $state(false);
  /** Open / close state for the header kebab. Tiny menu — just hosts
   *  "Move to project…" today, but the surface is in place for any
   *  future task-level actions. */
  let headerMenuOpen = $state(false);
  /**
   * Available state transitions for this task — drives the header
   * `<TransitionBar>`. Refreshed on every load + after every successful
   * `attribute.update` (status changes change which transitions exist).
   */
  let transitions = $state<readonly TransitionRow[]>([]);
  /**
   * Reference to the mounted `<TransitionBar>` so the `c` keyboard
   * shortcut can fire the first transition in the `close` bucket (the
   * old `TerminalActionButton`'s primary action moves under it per spec
   * §V14).
   */
  let transitionBar: { fireFirstClose: () => void } | undefined = $state();
  // `users` (UserRow[]) backs the activity stream's "actor" labels
  // (activity.actor_id is a `user_account.id`).
  let users = $state<readonly UserRow[]>([]);
  // `persons` (CardWithAttrs[] of card_type='person') backs the assignee
  // picker — post-refactor the `assignee` attribute is a card_ref to a
  // `person` card, NOT a user_account ref.
  let persons = $state<readonly CardWithAttrs[]>([]);
  let loading = $state(true);
  let errorMsg = $state<string | null>(null);

  // Title editor — `editingTitle` flips on `e` or click; `titleDraft` is
  // the in-flight value (commits on Mod+Enter / Enter, cancels on Esc).
  let editingTitle = $state(false);
  let titleDraft = $state('');
  let titleEl: HTMLInputElement | null = $state(null);

  // Description editor — same pattern. Description supports multi-line so
  // bare Enter inserts a newline; Mod+Enter commits.
  let editingDescription = $state(false);
  let descDraft = $state('');
  let descEl: HTMLTextAreaElement | null = $state(null);


  // Comment composer.
  let commentDraft = $state('');
  let commentEl: HTMLTextAreaElement | null = $state(null);
  let postingComment = $state(false);

  // Per-comment edit state. Keyed by stringified activity id. `draft`
  // holds the in-flight body; `busy` blocks duplicate submits.
  let commentEdits = $state<Record<string, { draft: string; busy: boolean }>>({});
  function startCommentEdit(id: ID, currentBody: string): void {
    commentEdits = {
      ...commentEdits,
      [id.toString()]: { draft: currentBody, busy: false },
    };
  }
  function cancelCommentEdit(id: ID): void {
    const next = { ...commentEdits };
    delete next[id.toString()];
    commentEdits = next;
  }
  function setCommentDraft(id: ID, draft: string): void {
    const key = id.toString();
    const cur = commentEdits[key];
    if (cur === undefined) return;
    commentEdits = { ...commentEdits, [key]: { ...cur, draft } };
  }

  // Bumped each time the right-rail AttachmentsSection commits an upload
  // or delete; the preview strip listens to it via a $effect to refetch.
  let attachmentsVersion = $state(0);

  /* ---- "Start comm" form on the Comms section ----
   *
   * Admin-gated affordance for attaching a new outbound email thread to
   * a task that did NOT come in through email — the inbound IMAP path
   * mints task+comm together; this surfaces the equivalent for tasks
   * authored in-app. Calls `comm.create` with a user-picked channel +
   * optional initial message. Channels are loaded lazily on first open
   * to avoid an extra request on every task detail load.
   */
  let channels = $state<readonly ChannelRow[]>([]);
  let channelsLoaded = $state(false);
  let loadingChannels = $state(false);
  let newCommOpen = $state(false);
  let newCommChannelId = $state<ID | null>(null);
  let newCommRecipients = $state<ID[]>([]);
  let creatingComm = $state(false);

  async function ensureChannelsLoaded(): Promise<void> {
    if (channelsLoaded || loadingChannels) return;
    if (task === null || task.parent_card_id === undefined) return;
    const pid = task.parent_card_id;
    loadingChannels = true;
    try {
      const out = await dispatcher.request<ChannelListInput, ChannelListOutput>({
        endpoint: commChannelList.endpoint,
        action: commChannelList.action,
        data: { projectId: pid },
      });
      channels = out.rows;
      channelsLoaded = true;
    } catch (e) {
      notify({
        type: 'error',
        message: `Load comm channels failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      loadingChannels = false;
    }
  }

  function openNewCommForm(): void {
    newCommOpen = true;
    newCommChannelId = null;
    newCommRecipients = [];
    void ensureChannelsLoaded();
  }

  function closeNewCommForm(): void {
    newCommOpen = false;
    newCommChannelId = null;
    newCommRecipients = [];
  }

  async function submitNewComm(): Promise<void> {
    if (task === null || newCommChannelId === null) return;
    if (newCommRecipients.length === 0) return;
    creatingComm = true;
    try {
      const input: CommCreateInput = {
        taskId: task.id,
        channelId: newCommChannelId,
        recipientPersonIds: newCommRecipients,
      };
      await dispatcher.request<CommCreateInput, CommCreateOutput>({
        endpoint: commCreate.endpoint,
        action: commCreate.action,
        data: input,
      });
      // Refresh the comm list so the new thread shows immediately.
      const out = await dispatcher.request<
        CommListForTaskInput,
        CommListForTaskOutput
      >({
        endpoint: commListForTask.endpoint,
        action: commListForTask.action,
        data: { taskId: task.id },
      });
      comms = out.rows;
      closeNewCommForm();
      notify({ type: 'success', message: 'Comm thread started.' });
    } catch (e) {
      notify({
        type: 'error',
        message: `Start comm failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      creatingComm = false;
    }
  }

  /** Combobox options for the channel picker. Disabled rows for channels
   *  whose SMTP password isn't set — outbound replies will fail until
   *  the admin configures them — so we surface the state but block the
   *  pick to avoid silently-broken threads. */
  const channelOptions = $derived<
    { value: ID; label: string; disabled?: boolean }[]
  >(
    channels.map((c) => {
      const status =
        c.channel_status === 'enabled' && c.has_smtp_password
          ? ''
          : c.channel_status !== 'enabled'
            ? ` (${c.channel_status})`
            : ' (smtp not configured)';
      return {
        value: c.id,
        label: `${c.name}${status}`,
        disabled:
          c.channel_status !== 'enabled' || !c.has_smtp_password,
      };
    }),
  );

  // Tag picker (Combobox toggled by `t` shortcut and the "+ Add tag" btn).
  let tagPickerOpen = $state(false);
  let tagPickerValue = $state<ID | null>(null);

  /* -------------------------------------------------------------------- */
  /* Derived lookups                                                      */
  /* -------------------------------------------------------------------- */

  const userNames = $derived(userNameMap(users));
  const personNames = $derived(personNameMap(persons));
  // Project-scoped picker option sets: milestones, components, and tags
  // sit one level under their project in v1, so filtering by
  // task.parent_card_id gives the in-project subset. The initial batch
  // loads the lists globally (it can't filter — the task hasn't loaded
  // yet); this $derived narrows them once the task is known.
  const scopedMilestones = $derived.by((): readonly CardWithAttrs[] => {
    if (task === null || task.parent_card_id === undefined) return milestones;
    const pid = task.parent_card_id;
    return milestones.filter((m) => m.parent_card_id === pid);
  });
  const scopedComponents = $derived.by((): readonly CardWithAttrs[] => {
    if (task === null || task.parent_card_id === undefined) return components;
    const pid = task.parent_card_id;
    return components.filter((c) => c.parent_card_id === pid);
  });
  const scopedTagCards = $derived.by((): readonly CardWithAttrs[] => {
    if (task === null || task.parent_card_id === undefined) return tagCards;
    const pid = task.parent_card_id;
    return tagCards.filter((tc) => tc.parent_card_id === pid);
  });
  const scopedStatuses = $derived.by((): readonly CardWithAttrs[] => {
    if (task === null || task.parent_card_id === undefined) return statusCards;
    const pid = task.parent_card_id;
    return statusCards.filter((s) => s.parent_card_id === pid);
  });
  const milestoneTitles = $derived(cardTitleMap(scopedMilestones));
  const componentTitles = $derived(cardTitleMap(scopedComponents));
  const statusTitles = $derived(cardTitleMap(scopedStatuses));
  const tagPaths = $derived(tagPathMap(scopedTagCards));
  // For ActivityRow's cardTitles map we merge the ref tables — every
  // value-card type a task can point at (milestone / component / status
  // / future admin types) shares the same id namespace, so one map.
  const cardTitles = $derived({
    ...milestoneTitles,
    ...componentTitles,
    ...statusTitles,
  });

  /**
   * Status label + phase lookup for the RelatedTasksPanel chips. Keyed
   * by status card id (stringified) so the panel can render a "Doing"
   * pill with phase-coloured tone without a separate fetch.
   */
  const statusLabels = $derived.by((): Record<string, { label: string; phase: 'triage' | 'active' | 'terminal' }> => {
    const out: Record<string, { label: string; phase: 'triage' | 'active' | 'terminal' }> = {};
    for (const s of statusCards) {
      const t = s.attributes['title'];
      out[s.id.toString()] = {
        label: typeof t === 'string' && t !== '' ? t : `#${s.id}`,
        phase: s.phase,
      };
    }
    return out;
  });

  /** The current task's parent (or null when standalone). Pulled from
   *  the in-memory `allTasks` set so we don't issue a second fetch for
   *  it — the dispatcher already has every task in the response. */
  const parentTask = $derived.by((): CardWithAttrs | null => {
    if (task === null) return null;
    const pid = task.attributes['parent_task'];
    if (typeof pid !== 'bigint') return null;
    return allTasks.find((t) => t.id === pid) ?? null;
  });

  /** Relationship label this task stores about its parent link. */
  const selfRelationship = $derived.by((): string | null => {
    if (task === null) return null;
    const v = task.attributes['parent_relationship'];
    return typeof v === 'string' && v !== '' ? v : null;
  });

  /** Tasks whose `parent_task` points back at this card. */
  const childTasks = $derived.by((): readonly CardWithAttrs[] => {
    const me = task;
    if (me === null) return [];
    return allTasks.filter((t) => {
      const p = t.attributes['parent_task'];
      return typeof p === 'bigint' && p === me.id;
    });
  });

  /**
   * Comm-status phase lookup keyed by value-card id-as-string. Comm-status
   * value-cards share the `status` card_type with task statuses; both
   * loads share the `scopedStatuses` set. For the read-only Comms
   * section we only need the badge tone (active=blue, terminal=green,
   * triage=muted), so a phase lookup is sufficient.
   */
  const commStatusPhases = $derived.by((): Record<string, 'triage' | 'active' | 'terminal'> => {
    const out: Record<string, 'triage' | 'active' | 'terminal'> = {};
    for (const s of scopedStatuses) out[s.id.toString()] = s.phase;
    return out;
  });

  /** Resolve a comm_status id to its badge tone classes via the kernel's phase. */
  function commStatusBadgeClass(commStatus: ID): string {
    const phase = commStatusPhases[commStatus.toString()] ?? 'active';
    const tone = commStatusTone(phase);
    if (tone === 'blue') return 'border-accent/40 bg-accent/10 text-accent';
    if (tone === 'green') return 'border-success/40 bg-success/10 text-success';
    return 'border-border bg-surface text-muted';
  }

  const orderedActivity = $derived(sortActivityDesc(activity));

  /**
   * Comment threads derived from the activity stream. A comment is an
   * activity row of `kind='comment'` carrying its body inline (see
   * server/internal/dom/comment). Newest-first to match the activity
   * stream's reverse-chronological order; the composer below the list
   * makes "scroll back to see history" the natural read order.
   */
  type CommentEntry = {
    id: ID;
    body: string;
    actorId: ID;
    createdAt: string;
    edited: boolean;
  };
  const comments = $derived.by((): CommentEntry[] => {
    // Latest comment_edit for a given comment id wins; we surface its
    // body in place of the original. The activity stream is ordered
    // newest-first so we iterate in that order.
    const editedBodies = new Map<string, string>();
    for (const a of orderedActivity) {
      if (a.kind !== 'comment_edit') continue;
      const vn = a.value_new as { activity_id?: unknown; new_body?: unknown } | null;
      if (vn === null || typeof vn !== 'object') continue;
      const target = vn.activity_id;
      const body = vn.new_body;
      const key = typeof target === 'bigint' ? target.toString() : String(target);
      if (typeof body === 'string' && !editedBodies.has(key)) {
        editedBodies.set(key, body);
      }
    }
    const out: CommentEntry[] = [];
    for (const a of orderedActivity) {
      if (a.kind !== 'comment') continue;
      const key = a.id.toString();
      const edited = editedBodies.has(key);
      const body = edited ? (editedBodies.get(key) ?? '') : (a.comment_body ?? '');
      out.push({
        id: a.id,
        body,
        actorId: a.actor_id,
        createdAt: a.created_at,
        edited,
      });
    }
    return out;
  });

  /** Schema we feed to AttributeSidePanel. Filtered to the bound-on-task set. */
  const schema = $derived.by((): FilterAttribute[] => {
    if (!schemaCache.loaded) return [];
    const out: FilterAttribute[] = [];
    for (const def of schemaCache.defs) {
      // Skip the title / description / tags / sort_order built-ins — title
      // and description have dedicated editors above; `tags` has its own
      // section below the panel; `sort_order` is reorder UI only.
      // parent_task / parent_relationship are owned by RelatedTasksPanel.
      if (
        def.name === 'title' ||
        def.name === 'description' ||
        def.name === 'tags' ||
        def.name === 'sort_order' ||
        def.name === 'parent_task' ||
        def.name === 'parent_relationship'
      ) {
        continue;
      }
      // Only show defs explicitly bound to the `task` card type. The server's
      // attribute.update validator inner-joins `edge`, so unbound defs reject
      // every write with `edge_violation` — surfacing them here just leads to
      // failed saves.
      const boundToTask = def.bound_to.some((b) => b.card_type_name === 'task');
      if (!boundToTask) continue;
      const fa = schemaCache.toFilterAttribute(def.name);
      if (fa !== null) out.push(fa);
    }
    return out;
  });

  /** Pull the person-card title (used wherever we need the display name). */
  function personLabel(p: CardWithAttrs): string {
    const t = p.attributes['title'];
    return typeof t === 'string' && t.length > 0 ? t : `#${p.id}`;
  }

  /**
   * refOptions for the side panel — these populate the trigger button's
   * label for currently-set values. For the three eagerly-loaded built-ins
   * we pass the full list; the dropdown's open-time options come from
   * `refLoaders` below. `assignee` is a card_ref to a `person` card
   * post-refactor, so its option list now comes from the persons fetch
   * rather than `user.select`.
   */
  const refOptions = $derived.by((): Record<string, { value: unknown; label: string }[]> => {
    const out: Record<string, { value: unknown; label: string }[]> = {};
    out['assignee'] = persons
      .filter(isAssignablePerson)
      .map((p) => ({ value: p.id, label: personLabel(p) }));
    // originator is also a card_ref → person; unlike assignee it may
    // legitimately point at a contact (e.g. the inbound email sender
    // when a task spawned from a comm), so we don't filter to
    // assignable members here. Without this entry the side panel
    // can't resolve the stored id to a name and shows a raw bigint.
    out['originator'] = persons.map((p) => ({ value: p.id, label: personLabel(p) }));
    out['milestone_ref'] = scopedMilestones.map((m) => ({
      value: m.id,
      label:
        typeof m.attributes['title'] === 'string'
          ? (m.attributes['title'] as string)
          : `#${m.id}`,
    }));
    out['component_ref'] = scopedComponents.map((c) => ({
      value: c.id,
      label:
        typeof c.attributes['title'] === 'string'
          ? (c.attributes['title'] as string)
          : `#${c.id}`,
    }));
    out['status'] = scopedStatuses.map((s) => ({
      value: s.id,
      label:
        typeof s.attributes['title'] === 'string'
          ? (s.attributes['title'] as string)
          : `#${s.id}`,
    }));
    return out;
  });

  /**
   * Async loaders for every ref:* attribute in the schema.
   *
   *   Every `ref:<card_type>` def — built-ins like status / assignee /
   *   milestone_ref / component_ref and any custom ref a project admin
   *   has wired up — uses the same `card.search` loader. The target card
   *   type comes from `attribute_def.target_card_type_id`; person refs
   *   stay global (no project filter), every other type is scoped to the
   *   task's enclosing project so the picker mirrors the per-project
   *   reference-scope rule enforced on the write side.
   */
  const refLoaders = $derived.by(() => {
    const out: Record<
      string,
      (q: string) => Promise<{ value: unknown; label: string }[]>
    > = {};
    for (const fa of schema) {
      if (!fa.valueType.startsWith('ref:')) continue;
      const cardType = fa.valueType.slice('ref:'.length);
      const scopeParent =
        cardType !== 'person' && task !== null && task.parent_card_id !== undefined
          ? task.parent_card_id
          : undefined;
      out[fa.name] = async (q: string) => {
        const data: CardSearchInput = { cardTypeName: cardType, query: q, limit: 50 };
        if (scopeParent !== undefined) data.parentCardId = scopeParent;
        const res = await dispatcher.request<CardSearchInput, CardSearchOutput>({
          endpoint: cardSearch.endpoint,
          action: cardSearch.action,
          data,
        });
        return res.rows.map((r) => ({ value: r.id, label: r.title }));
      };
    }
    return out;
  });

  /** Tag ids currently applied to the task. */
  const appliedTags = $derived(appliedTagIds(task));

  /** Tag-picker option list — every in-project tag that is NOT yet applied. */
  const tagPickerOptions = $derived.by(() => {
    const applied = new Set(appliedTags);
    return scopedTagCards
      .filter((t) => !applied.has(t.id))
      .map((t) => ({
        value: t.id,
        label: tagPaths[t.id.toString()] ?? `#${t.id}`,
      }));
  });

  /* -------------------------------------------------------------------- */
  /* Initial load + refresh                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Issue the eight-sub-request initial batch. Every dispatcher call
   * fires synchronously inside the same render tick so the dispatcher
   * coalesces them into ONE POST `/api/v1/batch`.
   *
   * On `initial=true` we seed the editor drafts; subsequent calls (after
   * a mutation) preserve any in-flight edit (i.e. text in the comment
   * composer while we're refreshing).
   */
  async function refresh(initial = false): Promise<void> {
    loading = true;
    errorMsg = null;

    const fTask = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'task' },
    });
    const fActivity = dispatcher.request<ActivitySelectInput, ActivitySelectOutput>({
      endpoint: activitySelect.endpoint,
      action: activitySelect.action,
      data: { cardId: taskId, limit: ACTIVITY_LIMIT },
    });
    const fMilestones = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'milestone' },
    });
    const fComponents = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'component' },
    });
    const fTags = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'tag' },
    });
    const fStatuses = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'status' },
    });
    const fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>({
      endpoint: userSelect.endpoint,
      action: userSelect.action,
      data: {},
    });
    // Persons feed the assignee picker (post-refactor the `assignee`
    // attribute is a card_ref to a `person` card). The user.select fetch
    // above is preserved so the activity stream's actor labels keep
    // resolving via `user_account.display_name`.
    const fPersons = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'person' },
    });
    // Gate 7: TransitionBar reads from this. Falls back to an empty list
    // on any error (the screen is still usable without flow info). The
    // request goes out on the same tick as the others so the dispatcher
    // folds it into the same POST.
    const fTransitions = dispatcher
      .request<FlowStepListForCardInput, FlowStepListForCardOutput>({
        endpoint: flowStepListForCard.endpoint,
        action: flowStepListForCard.action,
        data: { cardId: taskId },
      })
      .catch(() => ({ rows: [] as TransitionRow[] }));
    // Comm Gate 8: read-only list of comms attached to this task. The
    // section renders between Activity and Comments; no Reply action is
    // available here per spec — the user navigates to the Comms screen
    // to author replies. Folded into the initial-batch POST.
    const fComms = dispatcher
      .request<CommListForTaskInput, CommListForTaskOutput>({
        endpoint: commListForTask.endpoint,
        action: commListForTask.action,
        data: { taskId },
      })
      .catch(() => ({ rows: [] as CommRow[] }));
    // Driven through AttributeSchemaCache so concurrent screens share the
    // result. `load()` already short-circuits when the cache is hot — but
    // the first call still issues a real request; that request goes onto
    // the same render tick as the others, so the batch contract is met.
    const fSchema = schemaCache.load();

    try {
      const [tOut, aOut, mOut, cOut, tagOut, sOut, uOut, pOut, trOut, commsOut] = await Promise.all([
        fTask,
        fActivity,
        fMilestones,
        fComponents,
        fTags,
        fStatuses,
        fUsers,
        fPersons,
        fTransitions,
        fComms,
      ]);
      await fSchema;

      const found = pickTaskById(tOut.rows, taskId);
      task = found;
      allTasks = tOut.rows;
      activity = aOut.rows;
      milestones = mOut.rows;
      components = cOut.rows;
      tagCards = tagOut.rows;
      statusCards = sOut.rows;
      users = uOut.rows;
      persons = pOut.rows;
      transitions = trOut.rows;
      comms = commsOut.rows;
      loading = false;

      if (initial && found !== null) {
        const t = found.attributes['title'];
        titleDraft = typeof t === 'string' ? t : '';
        const d = found.attributes['description'];
        descDraft = typeof d === 'string' ? d : '';
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      loading = false;
    }
  }

  // Refetch whenever `taskId` changes — covers both the initial mount
  // and prev/next navigation (the Router reuses the same screen instance
  // when only the route param flips, so onMount alone would never fire
  // for a flip from /task/10 to /task/20).
  //
  // `refresh(true)` reseeds the inline-edit drafts (title / description)
  // for the new task. Wrapped in untrack() so the side effects inside
  // refresh() don't pull every piece of mutated state into the
  // effect's tracked deps — only `taskId` is a real trigger.
  $effect(() => {
    void taskId;
    untrack(() => {
      void refresh(true);
    });
  });

  /* -------------------------------------------------------------------- */
  /* Title edit                                                           */
  /* -------------------------------------------------------------------- */

  async function focusTitleEdit(): Promise<void> {
    if (task === null) return;
    const cur = task.attributes['title'];
    titleDraft = typeof cur === 'string' ? cur : '';
    editingTitle = true;
    await tick();
    titleEl?.focus();
    titleEl?.select();
  }

  function cancelTitleEdit(): void {
    editingTitle = false;
    if (task !== null) {
      const cur = task.attributes['title'];
      titleDraft = typeof cur === 'string' ? cur : '';
    }
  }

  async function commitTitle(): Promise<void> {
    if (task === null) return;
    const next = titleDraft.trim();
    const cur = task.attributes['title'];
    const curStr = typeof cur === 'string' ? cur : '';
    if (next === '' || next === curStr) {
      editingTitle = false;
      return;
    }
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: commitTitlePayload(taskId, next),
      });
      editingTitle = false;
      notify({ type: 'success', message: 'Title saved' });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: msg.length > 0 ? msg : 'Failed to save title' });
      // Keep `editingTitle` true and the in-flight draft so the user can retry.
    }
  }

  function onTitleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelTitleEdit();
    } else if (e.key === 'Enter') {
      // Bare Enter and Mod+Enter both commit (single-line title).
      e.preventDefault();
      void commitTitle();
    }
  }

  /* -------------------------------------------------------------------- */
  /* Description edit                                                     */
  /* -------------------------------------------------------------------- */

  async function focusDescriptionEdit(): Promise<void> {
    if (task === null) return;
    const cur = task.attributes['description'];
    descDraft = typeof cur === 'string' ? cur : '';
    editingDescription = true;
    await tick();
    descEl?.focus();
  }

  function cancelDescriptionEdit(): void {
    editingDescription = false;
    if (task !== null) {
      const cur = task.attributes['description'];
      descDraft = typeof cur === 'string' ? cur : '';
    }
  }

  async function commitDescription(): Promise<void> {
    if (task === null) return;
    const next = descDraft;
    const cur = task.attributes['description'];
    const curStr = typeof cur === 'string' ? cur : '';
    if (next === curStr) {
      editingDescription = false;
      return;
    }
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: commitDescriptionPayload(taskId, next),
      });
      editingDescription = false;
      notify({ type: 'success', message: 'Description saved' });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({
        type: 'error',
        message: msg.length > 0 ? msg : 'Failed to save description',
      });
    }
  }

  function onDescriptionKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelDescriptionEdit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commitDescription();
    }
    // Bare Enter inserts a newline (textarea default).
  }

  /* -------------------------------------------------------------------- */
  /* Comment composer                                                     */
  /* -------------------------------------------------------------------- */

  async function focusComment(): Promise<void> {
    await tick();
    commentEl?.focus();
  }

  async function postComment(): Promise<void> {
    const body = commentDraft.trim();
    if (body === '' || postingComment) return;
    postingComment = true;
    try {
      await dispatcher.request<CommentInsertInput, CommentInsertOutput>({
        endpoint: commentInsert.endpoint,
        action: commentInsert.action,
        data: commentInsertPayload(taskId, body),
      });
      commentDraft = '';
      notify({ type: 'success', message: 'Comment posted' });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({
        type: 'error',
        message: msg.length > 0 ? msg : 'Failed to post comment',
      });
    } finally {
      postingComment = false;
    }
  }

  async function commitCommentEdit(activityId: ID): Promise<void> {
    const key = activityId.toString();
    const state = commentEdits[key];
    if (state === undefined || state.busy) return;
    const body = state.draft.trim();
    if (body === '') return;
    commentEdits = { ...commentEdits, [key]: { ...state, busy: true } };
    try {
      await dispatcher.request<CommentUpdateInput, CommentUpdateOutput>({
        endpoint: commentUpdate.endpoint,
        action: commentUpdate.action,
        data: { activityId, body },
      });
      cancelCommentEdit(activityId);
      notify({ type: 'success', message: 'Comment updated' });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({
        type: 'error',
        message: msg.length > 0 ? msg : 'Failed to update comment',
      });
      const cur = commentEdits[key];
      if (cur !== undefined) {
        commentEdits = { ...commentEdits, [key]: { ...cur, busy: false } };
      }
    }
  }

  function onCommentKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void postComment();
    }
  }

  /* -------------------------------------------------------------------- */
  /* Attribute side-panel                                                 */
  /* -------------------------------------------------------------------- */

  function onAttributeChanged(_name: string, _value: unknown): void {
    // The panel itself dispatched the attribute.update; we only need to
    // refresh so the activity stream + summary update.
    notify({ type: 'success', message: 'Saved' });
    void refresh();
  }

  /* -------------------------------------------------------------------- */
  /* Tag handling                                                         */
  /* -------------------------------------------------------------------- */

  async function applyTag(tagCardId: ID): Promise<void> {
    try {
      await dispatcher.request<TagApplyInput, TagApplyOutput>({
        endpoint: tagApply.endpoint,
        action: tagApply.action,
        data: applyTagPayload(taskId, tagCardId),
      });
      notify({ type: 'success', message: 'Tag added' });
      tagPickerValue = null;
      tagPickerOpen = false;
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: msg.length > 0 ? msg : 'Failed to add tag' });
    }
  }

  async function removeTag(tagCardId: ID): Promise<void> {
    try {
      await dispatcher.request<TagRemoveInput, TagRemoveOutput>({
        endpoint: tagRemove.endpoint,
        action: tagRemove.action,
        data: removeTagPayload(taskId, tagCardId),
      });
      notify({ type: 'success', message: 'Tag removed' });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({
        type: 'error',
        message: msg.length > 0 ? msg : 'Failed to remove tag',
      });
    }
  }

  async function toggleTags(): Promise<void> {
    const next = !tagPickerOpen;
    tagPickerOpen = next;
    if (next) {
      // Pop the dropdown immediately so a single click on "+ Add tag" reveals
      // the picker — no second click on the trigger needed.
      await tick();
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-testid="task-tag-picker"] button[role="combobox"]',
      );
      trigger?.click();
    }
  }

  function onTagPickerChange(v: ID | ID[] | null): void {
    if (typeof v === 'bigint') {
      void applyTag(v);
    }
  }

  /* -------------------------------------------------------------------- */
  /* Navigation                                                           */
  /* -------------------------------------------------------------------- */

  function goBack(): void {
    // Prefer the in-app screen the user came from (Kanban / Grid / Inbox /
    // Project detail) so any filter state encoded in the query string is
    // preserved. Cold-loaded into the detail (no prior path) → fall back to
    // the parent project, or the projects list as a last resort.
    const fallback =
      task !== null && typeof task.parent_card_id === 'bigint'
        ? `/project/${task.parent_card_id}/screen/project`
        : '/projects';
    goBackOrFallback(fallback);
  }

  /* -------------------------------------------------------------------- */
  /* Prev/next-in-list navigation                                         */
  /* -------------------------------------------------------------------- */
  //
  // The list screen the user came from (Inbox / Grid / Project / a single
  // Kanban column) pushes its filtered, ordered task ids into
  // `taskNavList` immediately before navigate(). We find the current id
  // in that list and expose `<<` / `>>` controls plus j/k/[/] shortcuts
  // for stepping to the neighbour task.
  //
  // Stepping uses `replace: true` so the back-button still returns to the
  // original list — without that, walking through twenty issues would
  // need twenty Back presses to escape.
  //
  // When the user cold-loads /task/123 (no list seeded), `navIndex` is
  // -1 and the controls hide cleanly.

  const navIndex = $derived(taskNavList.ids.indexOf(taskId));
  const navTotal = $derived(taskNavList.ids.length);
  const hasPrev = $derived(navIndex > 0);
  const hasNext = $derived(navIndex >= 0 && navIndex < navTotal - 1);

  function goPrev(): void {
    if (!hasPrev) return;
    const id = taskNavList.ids[navIndex - 1];
    if (id === undefined) return;
    navigate(`/task/${id}`, { replace: true });
  }

  function goNext(): void {
    if (!hasNext) return;
    const id = taskNavList.ids[navIndex + 1];
    if (id === undefined) return;
    navigate(`/task/${id}`, { replace: true });
  }

  /* -------------------------------------------------------------------- */
  /* Keyboard shortcuts                                                   */
  /* -------------------------------------------------------------------- */

  // Edit-prefix chords: `e` opens a chord buffer (1.2 s timeout from
  // the shortcut dispatcher) and the second key picks the field. We
  // namespace the editing actions under one prefix instead of consuming
  // single letters so attribute panels (incl. user-defined attributes)
  // can claim their own `e <key>` without colliding with screen-wide
  // shortcuts like `t` (tag picker) or `j` / `k` (prev/next).
  useShortcut('task_detail', 'e t', () => void focusTitleEdit(), 'Edit title');
  useShortcut('task_detail', 'e d', () => void focusDescriptionEdit(), 'Edit description');
  useShortcut('task_detail', 'e c', () => void focusComment(), 'Edit a comment');
  // `e p` opens the parent picker on RelatedTasksPanel; if a parent is
  // already set the picker overrides the chip so the user can re-bind
  // in one keystroke (Save overwrites, Cancel falls back). `e s`
  // triggers the existing "+ New sub-task" path via the QuickEntry
  // overlay (parent_task pre-stamped to the focal task). `e a` opens
  // the "Add child" picker to link an existing task as a child — the
  // panel auto-opens the search Combobox and focuses its input so the
  // user can start typing the child's name immediately.
  //
  // `e a` (not `e d`, the natural "add" mnemonic) is used because `e
  // d` is already bound to "Edit description"; `a` reads cleanly as
  // "add child" without disturbing the description chord.
  useShortcut('task_detail', 'e p', () => { parentPickerOpen = true; }, 'Set parent');
  useShortcut('task_detail', 'e s', openNewSubtask, 'New sub-task');
  useShortcut('task_detail', 'e a', () => { childPickerOpen = true; }, 'Add existing child');
  useShortcut('task_detail', 't', toggleTags, 'Toggle tag picker');
  // V14: close bucket of TransitionBar replaces the old TerminalActionButton.
  // `c` fires the first transition in the close bucket (active→terminal),
  // matching the pre-Gate-7 keybinding.
  useShortcut(
    'task_detail',
    'c',
    () => transitionBar?.fireFirstClose(),
    'Close task (first close transition)',
  );
  // List-walking shortcuts. j/k mirror the list-screen convention
  // (j = down/next, k = up/previous); ] / [ are a bracket alternative
  // for either hand. Each useShortcut call registers both bindings and
  // the help overlay collapses them into one row.
  useShortcut('task_detail', ['j', ']'], goNext, 'Next task in list');
  useShortcut('task_detail', ['k', '['], goPrev, 'Previous task in list');
  // Esc / q both return to the previous screen — same effect as the
  // back chevron on the left. `fireInInputs: false` overrides the
  // dispatcher's default-true behaviour for Esc so the title /
  // description / comment editors retain their own Esc-to-cancel
  // handling without also bouncing the user out of the screen.
  useShortcut('task_detail', ['Esc', 'q'], goBack, 'Back to previous screen', {
    fireInInputs: false,
  });

  /**
   * QuickEntry overlay — feeds the "+ New sub-task" affordance on
   * RelatedTasksPanel. The rune binds `n` to the task_detail scope so
   * the standard "new task" shortcut works here too. The sub-task
   * prefill is supplied at click time via `qe.open(override)` from
   * `openNewSubtask` — that way prev/next navigation always stamps
   * the *current* taskId rather than the one captured at mount.
   */
  const taskTagOptions = $derived(
    scopedTagCards.map((tc) => {
      const p = tc.attributes['path'];
      return {
        value: tc.id,
        label: typeof p === 'string' && p !== '' ? p : `#${tc.id}`,
      };
    }),
  );
  const qe = useQuickEntry({
    scope: 'task_detail',
    defaultCardType: 'task',
    // Must be SCOPED — feeding the full statusCards list (every
    // project's statuses) lets the default-create-status resolver
    // pick a status that belongs to a different project than the
    // sub-task will land in. The server then rejects the insert
    // with "value card N belongs to project X but target is in
    // project Y". `scopedStatuses` filters to the focal task's
    // parent project, which is also the new sub-task's project.
    candidateStatuses: () => [...scopedStatuses],
    attributePalette: () => schema,
    tagOptions: () => taskTagOptions,
    onCreated: () => {
      void refresh();
    },
  });

  /** Open QuickEntry with `parent_task = currentTaskId` stamped via a
   *  one-shot override. Re-resolves `taskId` on every click so it always
   *  matches the focal task. */
  function openNewSubtask(): void {
    qe.open({
      extraAttributes: [
        { name: 'parent_task', value: taskId },
        { name: 'parent_relationship', value: 'subtask' },
      ],
    });
  }

  /* -------------------------------------------------------------------- */
  /* Display helpers                                                      */
  /* -------------------------------------------------------------------- */

  const displayTitle = $derived.by((): string => {
    if (task === null) return `Task ${taskId}`;
    const t = task.attributes['title'];
    return typeof t === 'string' && t.length > 0 ? t : `Task ${taskId}`;
  });

  const displayDescription = $derived.by((): string => {
    if (task === null) return '';
    const d = task.attributes['description'];
    return typeof d === 'string' ? d : '';
  });
</script>

<div
  class="task-detail grid h-full grid-cols-1 gap-3 p-3 md:grid-cols-[minmax(0,1fr)_320px]"
  data-testid="task-detail"
>
  {#if loading && task === null}
    <div class="col-span-full flex justify-center py-16" aria-live="polite">
      <Spinner size="lg" />
    </div>
  {:else if errorMsg !== null}
    <div class="col-span-full" data-testid="task-error">
      <EmptyState
        title="Failed to load task"
        description={errorMsg}
        action={{ label: 'Retry', onClick: () => void refresh(true) }}
      />
    </div>
  {:else if task === null}
    <div class="col-span-full" data-testid="task-not-found">
      <EmptyState
        title="Task not found"
        description="No task with id {taskId} exists or it was deleted."
        action={{ label: 'Back to projects', onClick: goBack }}
      />
    </div>
  {:else}
    <!-- Main column ----------------------------------------------------- -->
    <main class="flex min-w-0 flex-col gap-2 border border-section bg-bg">
      <!-- Header: back arrow + title (read-only / editing) -->
      <header class="flex items-start gap-2 border-b border-section bg-surface/40 px-3 py-2">
        <IconButton
          aria-label="Back"
          onclick={goBack}
          class="mt-1 shrink-0"
        >
          {#snippet children()}
            <svg viewBox="0 0 16 16" class="h-4 w-4" aria-hidden="true">
              <path
                d="M10 3 L5 8 L10 13"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                fill="none"
              />
            </svg>
          {/snippet}
        </IconButton>
        <div class="min-w-0 flex-1">
          {#if editingTitle}
            <input
              bind:this={titleEl}
              bind:value={titleDraft}
              type="text"
              data-testid="task-title-input"
              class="w-full border border-section bg-bg px-2 py-1 text-lg font-semibold text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              onkeydown={onTitleKeydown}
              onblur={() => void commitTitle()}
            />
          {:else}
            <div class="group flex items-center gap-1">
              <h1
                data-testid="task-title"
                class="truncate px-1 text-lg font-semibold text-fg"
              >
                {displayTitle}
              </h1>
              <IconButton
                aria-label="Edit title"
                title="Edit title (e t)"
                size="sm"
                variant="ghost"
                onclick={() => void focusTitleEdit()}
              >
                {#snippet children()}
                  <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" aria-hidden="true">
                    <path
                      d="M11.5 1.5 L14.5 4.5 L5 14 L1.5 14.5 L2 11 L11.5 1.5 Z"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linejoin="round"
                      fill="none"
                    />
                  </svg>
                {/snippet}
              </IconButton>
            </div>
          {/if}
          <p class="mt-0.5 px-1 font-mono text-[11px] text-muted">#{taskId}</p>
        </div>
        {#if task !== null && transitions.length > 0}
          <div class="shrink-0 self-start pt-0.5">
            <TransitionBar
              bind:this={transitionBar}
              cardId={task.id}
              transitions={transitions as TransitionRow[]}
              variant="detail"
              onChanged={() => void refresh(false)}
            />
          </div>
        {/if}
        {#if navTotal > 0 && navIndex >= 0}
          <!-- Top-right prev/next chevrons. Hidden on cold-load (navIndex
               < 0); rendered with a position counter so the user knows
               where they are in the source list. -->
          <div
            class="ml-auto flex shrink-0 items-center gap-1 self-start pt-0.5"
            data-testid="task-nav-chevrons"
          >
            <span class="hidden text-[11px] text-muted sm:inline" title={taskNavList.label}>
              {navIndex + 1} / {navTotal}
            </span>
            <span data-testid="task-nav-prev">
              <IconButton
                aria-label="Previous task in {taskNavList.label}"
                title="Previous (k or [)"
                size="sm"
                disabled={!hasPrev}
                onclick={goPrev}
              >
                {#snippet children()}
                  <svg viewBox="0 0 16 16" class="h-4 w-4" aria-hidden="true">
                    <path
                      d="M11 3 L7 8 L11 13 M7 3 L3 8 L7 13"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      fill="none"
                    />
                  </svg>
                {/snippet}
              </IconButton>
            </span>
            <span data-testid="task-nav-next">
              <IconButton
                aria-label="Next task in {taskNavList.label}"
                title="Next (j or ])"
                size="sm"
                disabled={!hasNext}
                onclick={goNext}
              >
                {#snippet children()}
                  <svg viewBox="0 0 16 16" class="h-4 w-4" aria-hidden="true">
                    <path
                      d="M5 3 L9 8 L5 13 M9 3 L13 8 L9 13"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      fill="none"
                    />
                  </svg>
                {/snippet}
              </IconButton>
            </span>
          </div>
        {/if}
        <!-- Header kebab: per-task actions that don't fit elsewhere.
             Anchored to the right edge so the prev/next chevrons stay
             flush against the title row. -->
        {#if task !== null}
          <div class="relative shrink-0 self-start pt-0.5">
            <button
              type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-bg text-muted hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-haspopup="menu"
              aria-expanded={headerMenuOpen}
              aria-label="Task actions"
              title="Task actions"
              data-testid="task-actions-trigger"
              onclick={() => (headerMenuOpen = !headerMenuOpen)}
            >
              <svg viewBox="0 0 12 12" class="h-3.5 w-3.5" aria-hidden="true">
                <circle cx="6" cy="2" r="1" fill="currentColor" />
                <circle cx="6" cy="6" r="1" fill="currentColor" />
                <circle cx="6" cy="10" r="1" fill="currentColor" />
              </svg>
            </button>
            {#if headerMenuOpen}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="fixed inset-0 z-40"
                onclick={() => (headerMenuOpen = false)}
              ></div>
              <div
                role="menu"
                class="absolute right-0 top-full z-50 mt-1 flex w-56 flex-col overflow-hidden rounded-md border border-border bg-bg py-1 text-sm shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  class="px-3 py-1.5 text-left text-fg hover:bg-surface focus:outline-none focus-visible:bg-surface"
                  onclick={() => {
                    headerMenuOpen = false;
                    moveDialogOpen = true;
                  }}
                >
                  Move to another project…
                </button>
                <div class="my-1 border-t border-border"></div>
                <button
                  type="button"
                  role="menuitem"
                  class="px-3 py-1.5 text-left text-danger hover:bg-surface focus:outline-none focus-visible:bg-surface"
                  data-testid="task-purge-trigger"
                  onclick={() => {
                    headerMenuOpen = false;
                    purgeDialogOpen = true;
                  }}
                >
                  Delete forever…
                </button>
              </div>
            {/if}
          </div>
        {/if}
      </header>

      <!-- Description -->
      <section aria-labelledby="desc-heading" class="border-t border-section">
        <div class="flex items-center justify-between border-b border-fg/40 bg-surface/40 px-3 py-1">
          <h2
            id="desc-heading"
            class="text-[11px] font-semibold uppercase tracking-wide text-fg"
          >
            Description
          </h2>
          {#if !editingDescription}
            <IconButton
              aria-label="Edit description"
              title="Edit description (e d)"
              size="sm"
              variant="ghost"
              onclick={() => void focusDescriptionEdit()}
            >
              {#snippet children()}
                <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" aria-hidden="true">
                  <path
                    d="M11.5 1.5 L14.5 4.5 L5 14 L1.5 14.5 L2 11 L11.5 1.5 Z"
                    stroke="currentColor"
                    stroke-width="1.2"
                    stroke-linejoin="round"
                    fill="none"
                  />
                </svg>
              {/snippet}
            </IconButton>
          {/if}
        </div>
        {#if editingDescription}
          <AutoGrowTextarea
            bind:el={descEl}
            bind:value={descDraft}
            data-testid="task-description-input"
            rows={6}
            class="min-h-[9rem] bg-bg px-3 py-2 text-sm text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            placeholder="Write a description… (Mod+Enter to save, Esc to cancel)"
            onkeydown={onDescriptionKeydown}
            onblur={() => void commitDescription()}
          />
        {:else}
          <div
            data-testid="task-description"
            class="min-h-[3rem] px-3 py-2 text-sm text-fg"
          >
            {#if displayDescription === ''}
              <button
                type="button"
                class="text-muted hover:text-fg hover:underline focus:outline-none focus-visible:underline"
                onclick={() => void focusDescriptionEdit()}
              >
                + Add a description…
              </button>
            {:else}
              <!-- View mode renders the description as markdown (sanitized
                   server-side… well, client-side via DOMPurify in the
                   Markdown component). Edit mode above is a plain
                   textarea so the user keeps source-level control. -->
              <Markdown source={displayDescription} />
            {/if}
          </div>
        {/if}
      </section>

      <!-- Related tasks (parent + children). Lives in the main column
           — not the right rail — so the chips have full width for
           comfortably long task titles. Sits directly under Description
           so the structural relationship is visible right after the
           task body. -->
      <RelatedTasksPanel
        cardId={taskId}
        parent={parentTask}
        selfRelationship={selfRelationship}
        children={childTasks}
        projectId={task.parent_card_id ?? null}
        {statusLabels}
        onChanged={() => void refresh()}
        onCreateSubtask={openNewSubtask}
        bind:parentPickerOpen
        bind:childPickerOpen
      />

      <!-- Image / PDF preview strip — sits between Description and Activity
           per spec. Filters its own list to known-previewable kinds; if the
           card has no image / PDF attachments the section renders nothing. -->
      <AttachmentsPreviewStrip cardId={taskId} version={attachmentsVersion} />

      <!-- Comms (read-only — Reply lives on the Comms screen).
           Per spec §"What about the Task detail view?": Task detail shows
           internal comments (existing), attached comms (this section), and
           the reply history of each comm. The "Reply" action is *not*
           available here; the user navigates to the Comms screen to post
           a reply, keeping the boundary clean. -->
      <section aria-labelledby="comms-heading" class="flex flex-col border-t border-section">
        <h2
          id="comms-heading"
          class="flex items-center justify-between gap-2 border-b border-fg/40 bg-surface/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
        >
          <span>Comms ({comms.length})</span>
          <span class="inline-flex shrink-0 items-center gap-2">
            {#if authState?.isAdmin}
              <button
                type="button"
                data-testid="task-comms-start"
                class="rounded-md border border-border bg-bg px-2 py-0.5 text-[10px] font-normal text-fg hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                disabled={newCommOpen}
                onclick={openNewCommForm}
              >
                + Start comm
              </button>
            {/if}
            {#if task !== null && typeof task.parent_card_id === 'bigint'}
              <a
                href="/project/{task.parent_card_id}/screen/comms"
                data-testid="task-comms-goto-link"
                class="rounded-md border border-border bg-bg px-2 py-0.5 text-[10px] font-normal text-fg hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onclick={(e) => {
                  e.preventDefault();
                  const pid = task?.parent_card_id;
                  if (typeof pid === 'bigint') navigate(`/project/${pid}/screen/comms`);
                }}
              >
                Go to Comms
              </a>
            {/if}
          </span>
        </h2>
        {#if newCommOpen}
          <div
            class="flex flex-col gap-2 border-b border-fg/15 bg-bg/40 px-3 py-2"
            data-testid="task-comms-start-form"
          >
            <div class="flex flex-col gap-0.5 text-xs text-muted">
              <span>Channel</span>
              {#if loadingChannels && channels.length === 0}
                <span class="inline-flex items-center gap-2"><Spinner size="sm" /> Loading channels…</span>
              {:else if channels.length === 0}
                <span class="text-fg">
                  No comm channels configured for this project. Set one up in Admin → Comm channels.
                </span>
              {:else}
                <Combobox
                  aria-label="Comm channel"
                  options={channelOptions}
                  value={newCommChannelId}
                  searchable={channelOptions.length > 8}
                  placeholder="Pick a channel…"
                  onchange={(v) => {
                    if (v === null || v === undefined) newCommChannelId = null;
                    else if (typeof v === 'bigint') newCommChannelId = v;
                  }}
                />
              {/if}
            </div>
            <div class="flex flex-col gap-0.5 text-xs text-muted">
              <span>
                Recipients
                <span class="font-normal text-muted/80">
                  — pick existing people or type an email to add a new contact. The reply Subject is always the thread id + task title.
                </span>
              </span>
              <RecipientsPicker
                bind:value={newCommRecipients}
                persons={[...persons]}
                placeholder="alice@example.com…"
                aria-label="Comm recipients"
              />
            </div>
            <div class="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onclick={closeNewCommForm} disabled={creatingComm}>
                {#snippet children()}Cancel{/snippet}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onclick={() => void submitNewComm()}
                disabled={creatingComm || newCommChannelId === null || newCommRecipients.length === 0}
              >
                {#snippet children()}
                  {creatingComm ? 'Starting…' : 'Start comm'}
                {/snippet}
              </Button>
            </div>
          </div>
        {/if}
        {#if comms.length === 0}
          <p class="px-3 py-2 text-sm text-muted" data-testid="task-comms-empty">
            No comms attached.
          </p>
        {:else}
          <ul
            data-testid="task-comms-list"
            class="flex flex-col gap-0 divide-y divide-fg/15 bg-bg"
          >
            {#each comms as c (c.id)}
              {@const replies = sortRepliesAsc(c.replies)}
              <li class="flex flex-col gap-1 px-3 py-2" data-testid="task-comms-row" data-comm-id={c.id}>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate text-sm font-medium text-fg">{c.title}</span>
                  <span
                    class="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted"
                    data-testid="task-comms-id"
                    title="Comm id"
                  >
                    m{c.id}
                  </span>
                  {#if c.comm_status !== 0n}
                    <span
                      class="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium {commStatusBadgeClass(c.comm_status)}"
                      data-testid="task-comms-status"
                    >
                      {commStatusLabel(c.comm_status, statusTitles)}
                    </span>
                  {/if}
                  <span
                    class="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted"
                    data-testid="task-comms-thread-id"
                    title="Thread id"
                  >
                    #{c.thread_id}
                  </span>
                </div>
                {#if replies.length === 0}
                  <p class="text-xs italic text-muted" data-testid="task-comms-no-replies">
                    No replies yet.
                  </p>
                {:else}
                  <ul class="flex flex-col gap-1" data-testid="task-comms-replies">
                    {#each replies as r (r.id)}
                      <li
                        class="rounded-md border border-border/60 px-2 py-1 text-xs"
                        data-testid="task-comms-reply"
                        data-reply-id={r.id}
                        data-delivery-status={r.delivery_status}
                      >
                        <div class="flex items-center justify-between gap-2">
                          <span class="truncate font-medium text-fg">
                            {r.delivery_status === 'received' ? r.from : r.to}
                          </span>
                          <span
                            class="shrink-0 rounded bg-surface px-1 text-[10px] uppercase tracking-wider text-muted"
                          >
                            {r.delivery_status}
                          </span>
                        </div>
                        {#if r.body_text !== ''}
                          <p class="mt-0.5 whitespace-pre-wrap text-muted">{r.body_text}</p>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Comments — bodies inline. The activity stream below this
           section only carries the audit line per comment / edit. -->
      <section aria-labelledby="comments-heading" class="flex flex-col border-t border-section">
        <h2
          id="comments-heading"
          class="border-b border-fg/40 bg-surface/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
        >
          Comments ({comments.length})
        </h2>
        {#if comments.length === 0}
          <p class="px-3 py-2 text-sm text-muted" data-testid="task-comments-empty">
            No comments yet.
          </p>
        {:else}
          <ul class="flex flex-col divide-y divide-fg/15">
            {#each comments as c (c.id)}
              {@const key = c.id.toString()}
              {@const edit = commentEdits[key]}
              {@const canEdit = authState?.userId === c.actorId.toString()}
              {@const actorLabel = userNames[c.actorId.toString()] ?? `user#${c.actorId}`}
              <li class="px-3 py-2" data-testid="task-comment-row" data-comment-id={c.id}>
                <div class="flex items-baseline gap-2 text-xs">
                  <span class="font-medium text-fg">{actorLabel}</span>
                  <span class="font-mono text-[10px] text-muted" data-testid="task-comment-id">
                    c{c.id}
                  </span>
                  {#if c.edited}
                    <span class="text-[10px] italic text-muted">(edited)</span>
                  {/if}
                  <span class="ml-auto text-[11px] tabular-nums text-muted">
                    {formatRelativeTime(c.createdAt)}
                  </span>
                  {#if canEdit && edit === undefined}
                    <IconButton
                      aria-label="Edit comment"
                      title="Edit comment"
                      size="sm"
                      variant="ghost"
                      onclick={() => startCommentEdit(c.id, c.body)}
                    >
                      {#snippet children()}
                        <svg viewBox="0 0 16 16" class="h-3 w-3" aria-hidden="true">
                          <path
                            d="M11.5 1.5 L14.5 4.5 L5 14 L1.5 14.5 L2 11 L11.5 1.5 Z"
                            stroke="currentColor"
                            stroke-width="1.2"
                            stroke-linejoin="round"
                            fill="none"
                          />
                        </svg>
                      {/snippet}
                    </IconButton>
                  {/if}
                </div>
                {#if edit !== undefined}
                  <div class="mt-1 flex flex-col gap-1">
                    <AutoGrowTextarea
                      value={edit.draft}
                      onValueChange={(v) => setCommentDraft(c.id, v)}
                      data-testid="task-comment-edit-input"
                      rows={3}
                      class="border border-fg/40 bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                      disabled={edit.busy}
                      onkeydown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelCommentEdit(c.id);
                        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void commitCommentEdit(c.id);
                        }
                      }}
                    />
                    <div class="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={edit.busy}
                        onclick={() => cancelCommentEdit(c.id)}
                      >
                        {#snippet children()}Cancel{/snippet}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={edit.busy}
                        disabled={edit.busy || edit.draft.trim() === ''}
                        onclick={() => void commitCommentEdit(c.id)}
                      >
                        {#snippet children()}Save{/snippet}
                      </Button>
                    </div>
                  </div>
                {:else}
                  <div class="mt-1 text-sm text-fg">
                    <Markdown source={c.body} />
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Comment composer -->
      <section aria-labelledby="comment-heading" class="flex flex-col border-t border-section">
        <h2
          id="comment-heading"
          class="border-b border-fg/40 bg-surface/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
        >
          Add comment
        </h2>
        <div class="flex flex-col gap-2 px-3 py-2">
          <AutoGrowTextarea
            bind:el={commentEl}
            bind:value={commentDraft}
            data-testid="task-comment-input"
            rows={3}
            class="border border-fg/40 bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            placeholder="Add a comment… (Markdown supported · Mod+Enter to post)"
            disabled={postingComment}
            onkeydown={onCommentKeydown}
          />
          <div class="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              loading={postingComment}
              disabled={commentDraft.trim() === ''}
              onclick={() => void postComment()}
            >
              {#snippet children()}Comment{/snippet}
            </Button>
          </div>
        </div>
      </section>

      <!-- Activity stream. Sits below the comment composer so the
           composer is the first thing reached when scrolling; the
           stream is a continuous, low-chrome timeline rather than
           a table of rows. -->
      <section aria-labelledby="activity-heading" class="flex flex-col border-t border-section">
        <h2
          id="activity-heading"
          class="border-b border-fg/40 bg-surface/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
        >
          Activity ({orderedActivity.length})
        </h2>
        {#if orderedActivity.length === 0}
          <p class="px-3 py-2 text-sm text-muted">No activity yet.</p>
        {:else}
          <div
            data-testid="task-activity-list"
            class="flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto bg-bg px-3 py-1.5 text-sm leading-snug"
          >
            {#each orderedActivity as row (row.id)}
              <ActivityRowView
                {row}
                userNames={userNames}
                cardTitles={cardTitles}
                tagPaths={tagPaths}
              />
            {/each}
          </div>
        {/if}
      </section>
    </main>

    <!-- Right rail ------------------------------------------------------- -->
    <aside class="flex flex-col gap-2">
      <AttributeSidePanel
        cardId={taskId}
        attributes={task.attributes}
        {schema}
        {refOptions}
        {refLoaders}
        onChanged={onAttributeChanged}
      />

      <AttachmentsSection
        cardId={taskId}
        onChanged={() => {
          // Bump the strip's version so it refetches its filtered list,
          // and refresh the activity stream so the attachment_create /
          // attachment_delete row shows up.
          attachmentsVersion += 1;
          void refresh();
        }}
      />

      <!-- Tags section -->
      <section
        aria-labelledby="tags-heading"
        class="flex flex-col border border-section bg-bg"
      >
        <h2
          id="tags-heading"
          class="border-b border-fg/40 bg-surface/40 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
        >
          Tags
        </h2>
        <div class="flex flex-col gap-1.5 px-2 py-1.5">
          {#if appliedTags.length === 0}
            <p class="text-xs text-muted">No tags applied.</p>
          {:else}
            <div data-testid="task-tag-row" class="flex flex-wrap gap-1">
              {#each appliedTags as tid (tid)}
                {@const path = tagPaths[tid.toString()] ?? `#${tid}`}
                <TagChip
                  label={path}
                  removable
                  onRemove={() => void removeTag(tid)}
                />
              {/each}
            </div>
          {/if}

          {#if tagPickerOpen}
            <div data-testid="task-tag-picker">
              <Combobox
                options={tagPickerOptions}
                value={tagPickerValue}
                placeholder="Pick a tag…"
                aria-label="Add tag"
                onchange={onTagPickerChange}
              />
              <div class="mt-1 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => {
                    tagPickerOpen = false;
                  }}
                >
                  {#snippet children()}Cancel{/snippet}
                </Button>
              </div>
            </div>
          {:else}
            <Button
              variant="secondary"
              size="sm"
              onclick={toggleTags}
              class="self-start"
            >
              {#snippet children()}+ Add tag{/snippet}
            </Button>
          {/if}
        </div>
      </section>
    </aside>
  {/if}
</div>

<QuickEntryOverlay {...qe.props} />

<MoveTaskDialog
  bind:open={moveDialogOpen}
  cardId={task !== null ? taskId : null}
  sourceProjectId={task?.parent_card_id ?? null}
  onMoved={(out) => {
    // The task moved; navigate to the destination project's task view
    // so the user immediately lands on the now-up-to-date detail. The
    // task id itself is unchanged, so the same URL works — we just
    // force a refresh through the existing refresh() path.
    void refresh(false);
  }}
/>

<PurgeTaskDialog
  bind:open={purgeDialogOpen}
  cardId={task !== null ? taskId : null}
  taskTitle={displayTitle}
  onPurged={() => {
    // The card no longer exists; bail out before the screen tries to
    // re-render against a missing row. goBack falls through to a sane
    // default (the source list) when the history stack is empty.
    goBack();
  }}
/>

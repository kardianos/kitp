<!--
  TaskDetailScreen — full per-card lifecycle: title editor, description,
  attribute panel, activity stream, comment composer.

  Layout: two-column on viewports ≥ 700px (main column + 280px right
  rail). Below that we collapse to a single column so the side panel
  doesn't squeeze the description.

  Dispatcher contract:
    - On mount: ONE batch with seven sub-requests (task + activity +
      milestones + components + tags + users + attribute_def). All
      seven `request()` calls happen in the same render tick so the
      dispatcher coalesces them into one POST.
    - Title / description / attribute commits issue ONE batch
      (attribute.update) followed by a refresh batch.
    - Comment posts and tag apply/remove each issue ONE batch followed
      by refresh.

  Ports `client/lib/ui/screens/task_detail_screen.dart` (759 LOC).
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { getDispatcher } from '../dispatch/context';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { goBackOrFallback, navigate } from '../routing/router.svelte';
  import { taskNavList } from '../routing/task_nav_list.svelte';
  import { projectScope } from '../shell/project_scope.svelte';
  import { notify } from '../ui/toast.svelte';
  import Button from '../ui/Button.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Markdown from '../ui/Markdown.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import ActivityRowView from '../ui/widgets/ActivityRow.svelte';
  import TagChip from '../ui/widgets/TagChip.svelte';
  import AttachmentsSection from '../ui/widgets/AttachmentsSection.svelte';
  import AttachmentsPreviewStrip from '../ui/widgets/AttachmentsPreviewStrip.svelte';
  import AttributeSidePanel from '../ui/widgets/AttributeSidePanel.svelte';
  import BlockersPanel from '../ui/widgets/BlockersPanel.svelte';
  import ClassifyDialog from '../ui/widgets/ClassifyDialog.svelte';
  import GateStrip from '../ui/widgets/GateStrip.svelte';
  import { AttributeSchemaCache } from '../filter/attribute_schema.svelte';
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
    CommentInsertInput,
    CommentInsertOutput,
    TagApplyInput,
    TagApplyOutput,
    TagRemoveInput,
    TagRemoveOutput,
    UserRow,
    UserSelectInput,
    UserSelectOutput,
    WorkflowTransitionListInput,
    WorkflowTransitionListOutput,
    WorkflowTransitionRow,
  } from '../reg/types';
  import { workflowTransitionList } from '../reg/handlers_admin';
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
    commitDescriptionPayload,
    commitTitlePayload,
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
  const taskId = $derived(Number(params.id ?? '') || 0);

  const dispatcher = getDispatcher();
  const schemaCache = new AttributeSchemaCache(dispatcher);

  /* -------------------------------------------------------------------- */
  /* Reactive state                                                       */
  /* -------------------------------------------------------------------- */

  let task = $state<CardWithAttrs | null>(null);
  let classifyOpen = $state(false);
  // Transitions for the current task's workflow_def_ref. Loaded on mount
  // (and on refresh) so the status picker can hide unreachable options.
  let workflowTransitions = $state<WorkflowTransitionRow[]>([]);
  // Bumped after every refresh so BlockersPanel re-evaluates.
  let blockersVersion = $state(0);
  let activity = $state<readonly ActivityRow[]>([]);
  let milestones = $state<readonly CardWithAttrs[]>([]);
  let components = $state<readonly CardWithAttrs[]>([]);
  let tagCards = $state<readonly CardWithAttrs[]>([]);
  let users = $state<readonly UserRow[]>([]);
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

  // Bumped each time the right-rail AttachmentsSection commits an upload
  // or delete; the preview strip listens to it via a $effect to refetch.
  let attachmentsVersion = $state(0);

  // Tag picker (Combobox toggled by `t` shortcut and the "+ Add tag" btn).
  let tagPickerOpen = $state(false);
  let tagPickerValue = $state<number | null>(null);

  /* -------------------------------------------------------------------- */
  /* Derived lookups                                                      */
  /* -------------------------------------------------------------------- */

  const userNames = $derived(userNameMap(users));
  const milestoneTitles = $derived(cardTitleMap(milestones));
  const componentTitles = $derived(cardTitleMap(components));
  const tagPaths = $derived(tagPathMap(tagCards));
  // For ActivityRow's cardTitles map we merge the ref tables — milestones
  // and components both flow into the same `card_id` namespace.
  const cardTitles = $derived({ ...milestoneTitles, ...componentTitles });

  const orderedActivity = $derived(sortActivityDesc(activity));

  /** Schema we feed to AttributeSidePanel. Filtered to the bound-on-task set. */
  const schema = $derived.by((): FilterAttribute[] => {
    if (!schemaCache.loaded) return [];
    const out: FilterAttribute[] = [];
    for (const def of schemaCache.defs) {
      // Skip the title / description / tags / sort_order built-ins — title
      // and description have dedicated editors above; `tags` has its own
      // section below the panel; `sort_order` is reorder UI only.
      if (
        def.name === 'title' ||
        def.name === 'description' ||
        def.name === 'tags' ||
        def.name === 'sort_order'
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

  /**
   * refOptions for the side panel — these populate the trigger button's
   * label for currently-set values. For the three eagerly-loaded built-ins
   * we pass the full list; the dropdown's open-time options come from
   * `refLoaders` below.
   */
  const refOptions = $derived.by((): Record<string, { value: unknown; label: string }[]> => {
    const out: Record<string, { value: unknown; label: string }[]> = {};
    out['assignee'] = users.map((u) => ({ value: u.id, label: u.display_name }));
    out['milestone_ref'] = milestones.map((m) => ({
      value: m.id,
      label:
        typeof m.attributes['title'] === 'string'
          ? (m.attributes['title'] as string)
          : `#${m.id}`,
    }));
    out['component_ref'] = components.map((c) => ({
      value: c.id,
      label:
        typeof c.attributes['title'] === 'string'
          ? (c.attributes['title'] as string)
          : `#${c.id}`,
    }));
    // Workflow-aware status picker: when the task is bound to a workflow
    // we restrict options to (current state) ∪ (states reachable from
    // current via workflow_transition). This narrows the picker to the
    // actually-allowed set; the server still rejects an out-of-graph
    // value, but the UX shouldn't have offered it in the first place.
    if (task !== null && workflowTransitions.length > 0) {
      const statusAttr = schema.find((s) => s.name === 'status');
      if (statusAttr?.options !== undefined) {
        const cur =
          typeof task.attributes['status'] === 'string'
            ? task.attributes['status']
            : '';
        const reachable = new Set<string>([cur]);
        for (const t of workflowTransitions) {
          if (t.from_state === cur) reachable.add(t.to_state);
        }
        out['status'] = statusAttr.options.filter((opt) =>
          reachable.has(String(opt.value)),
        );
      }
    }
    return out;
  });

  /**
   * Async loaders for every ref:* attribute in the schema.
   *
   *   - `ref:user` is served from the eagerly-loaded `users` list by
   *     filtering in memory — no extra round-trip needed for the user
   *     count this app has, and the picker still feels "live".
   *   - Every other `ref:<card_type>` (built-ins like milestone_ref /
   *     component_ref AND any custom ref a project admin has wired up)
   *     calls `card.search` so the picker scales beyond what we'd want
   *     to load up front.
   */
  const refLoaders = $derived.by(() => {
    const out: Record<
      string,
      (q: string) => Promise<{ value: unknown; label: string }[]>
    > = {};
    for (const fa of schema) {
      if (!fa.valueType.startsWith('ref:')) continue;
      const cardType = fa.valueType.slice('ref:'.length);
      if (cardType === 'user') {
        out[fa.name] = async (q: string) => {
          const needle = q.trim().toLowerCase();
          const matched = needle === ''
            ? users
            : users.filter((u) => u.display_name.toLowerCase().includes(needle));
          return matched.slice(0, 50).map((u) => ({
            value: u.id,
            label: u.display_name,
          }));
        };
      } else {
        out[fa.name] = async (q: string) => {
          const res = await dispatcher.request<CardSearchInput, CardSearchOutput>({
            endpoint: cardSearch.endpoint,
            action: cardSearch.action,
            data: { cardTypeName: cardType, query: q, limit: 50 },
          });
          return res.rows.map((r) => ({ value: r.id, label: r.title }));
        };
      }
    }
    return out;
  });

  /** Tag ids currently applied to the task. */
  const appliedTags = $derived(appliedTagIds(task));

  /** Tag-picker option list — every tag that is NOT yet applied. */
  const tagPickerOptions = $derived.by(() => {
    const applied = new Set(appliedTags);
    return tagCards
      .filter((t) => !applied.has(t.id))
      .map((t) => ({
        value: t.id,
        label: tagPaths[t.id] ?? `#${t.id}`,
      }));
  });

  /* -------------------------------------------------------------------- */
  /* Initial load + refresh                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Issue the seven-sub-request initial batch. Every dispatcher call
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
    const fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>({
      endpoint: userSelect.endpoint,
      action: userSelect.action,
      data: {},
    });
    // Driven through AttributeSchemaCache so concurrent screens share the
    // result. `load()` already short-circuits when the cache is hot — but
    // the first call still issues a real request; that request goes onto
    // the same render tick as the others, so the batch contract is met.
    // Pass the active project as projectCardId so per-project enum
    // options surface in pickers (migration 0020).
    const fSchema = schemaCache.load(
      projectScope.projectId !== null && projectScope.projectId !== undefined
        ? { projectCardId: projectScope.projectId }
        : undefined,
    );

    try {
      const [tOut, aOut, mOut, cOut, tagOut, uOut] = await Promise.all([
        fTask,
        fActivity,
        fMilestones,
        fComponents,
        fTags,
        fUsers,
      ]);
      await fSchema;

      const found = pickTaskById(tOut.rows, taskId);
      task = found;
      activity = aOut.rows;
      milestones = mOut.rows;
      components = cOut.rows;
      tagCards = tagOut.rows;
      users = uOut.rows;
      loading = false;

      // If the task is bound to a workflow, fetch its transitions so the
      // status picker can constrain options. Skip if no workflow_def_ref.
      const wfRef = found?.attributes['workflow_def_ref'];
      if (typeof wfRef === 'number' && wfRef > 0) {
        try {
          const wOut = await dispatcher.request<
            WorkflowTransitionListInput,
            WorkflowTransitionListOutput
          >({
            endpoint: workflowTransitionList.endpoint,
            action: workflowTransitionList.action,
            data: { workflowDefId: wfRef },
          });
          workflowTransitions = wOut.rows;
        } catch {
          workflowTransitions = [];
        }
      } else {
        workflowTransitions = [];
      }

      if (initial && found !== null) {
        const t = found.attributes['title'];
        titleDraft = typeof t === 'string' ? t : '';
        const d = found.attributes['description'];
        descDraft = typeof d === 'string' ? d : '';
      }
      blockersVersion += 1;
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

  async function applyTag(tagCardId: number): Promise<void> {
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

  async function removeTag(tagCardId: number): Promise<void> {
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

  function onTagPickerChange(v: number | number[] | null): void {
    if (typeof v === 'number') {
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
      task !== null && typeof task.parent_card_id === 'number'
        ? `/project/${task.parent_card_id}`
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
  useShortcut('task_detail', 't', toggleTags, 'Toggle tag picker');
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
    <main class="flex min-w-0 flex-col gap-2 border border-fg/70 bg-bg">
      <!-- Header: back arrow + title (read-only / editing) -->
      <header class="flex items-start gap-2 border-b border-fg/70 bg-surface/40 px-3 py-2">
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
              class="w-full border border-fg/70 bg-bg px-2 py-1 text-lg font-semibold text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              onkeydown={onTitleKeydown}
              onblur={() => void commitTitle()}
            />
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <h1
              data-testid="task-title"
              class="cursor-text truncate px-1 text-lg font-semibold text-fg hover:bg-surface/60"
              title="Click to edit (or press e)"
              onclick={() => void focusTitleEdit()}
            >
              {displayTitle}
            </h1>
          {/if}
          <p class="mt-0.5 px-1 font-mono text-[11px] text-muted">#{taskId}</p>
        </div>
        <GateStrip parentCardId={taskId} onChanged={() => void refresh()} />
        <BlockersPanel cardId={taskId} version={blockersVersion} />
        <span class="ml-2 mt-0.5 self-start" data-testid="classify-button-wrap">
          <Button variant="secondary" onclick={() => (classifyOpen = true)}>
            Classify…
          </Button>
        </span>
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
      </header>

      <!-- Description -->
      <section aria-labelledby="desc-heading" class="border-t border-fg/70">
        <h2
          id="desc-heading"
          class="border-b border-fg/40 bg-surface/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
        >
          Description
        </h2>
        {#if editingDescription}
          <textarea
            bind:this={descEl}
            bind:value={descDraft}
            data-testid="task-description-input"
            rows="6"
            class="block w-full bg-bg px-3 py-2 text-sm text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            placeholder="Write a description… (Mod+Enter to save, Esc to cancel)"
            onkeydown={onDescriptionKeydown}
            onblur={() => void commitDescription()}
          ></textarea>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            data-testid="task-description"
            class="min-h-[3rem] cursor-text px-3 py-2 text-sm text-fg hover:bg-surface/40"
            title="Click to edit"
            onclick={() => void focusDescriptionEdit()}
          >
            {#if displayDescription === ''}
              <span class="text-muted">Click to add a description…</span>
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

      <!-- Image / PDF preview strip — sits between Description and Activity
           per spec. Filters its own list to known-previewable kinds; if the
           card has no image / PDF attachments the section renders nothing. -->
      <AttachmentsPreviewStrip cardId={taskId} version={attachmentsVersion} />

      <!-- Activity stream -->
      <section aria-labelledby="activity-heading" class="flex flex-col border-t border-fg/70">
        <h2
          id="activity-heading"
          class="border-b border-fg/40 bg-surface/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
        >
          Activity ({orderedActivity.length})
        </h2>
        {#if orderedActivity.length === 0}
          <p class="px-3 py-2 text-sm text-muted">No activity yet.</p>
        {:else}
          <ul
            data-testid="task-activity-list"
            class="flex max-h-[40vh] flex-col gap-0 divide-y divide-fg/15 overflow-y-auto bg-bg"
          >
            {#each orderedActivity as row (row.id)}
              <li class="px-3 py-1">
                <ActivityRowView
                  {row}
                  userNames={userNames}
                  cardTitles={cardTitles}
                  tagPaths={tagPaths}
                />
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Comment composer -->
      <section aria-labelledby="comment-heading" class="flex flex-col border-t border-fg/70">
        <h2
          id="comment-heading"
          class="border-b border-fg/40 bg-surface/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
        >
          Comment
        </h2>
        <div class="flex flex-col gap-2 px-3 py-2">
          <textarea
            bind:this={commentEl}
            bind:value={commentDraft}
            data-testid="task-comment-input"
            rows="3"
            class="w-full border border-fg/40 bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            placeholder="Add a comment… (Mod+Enter to post)"
            disabled={postingComment}
            onkeydown={onCommentKeydown}
          ></textarea>
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
        class="flex flex-col border border-fg/70 bg-bg"
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
                {@const path = tagPaths[tid] ?? `#${tid}`}
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

<ClassifyDialog
  bind:open={classifyOpen}
  cardId={taskId}
  onClassified={() => void refresh()}
/>

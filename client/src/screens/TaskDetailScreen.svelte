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
  import { onMount, tick } from 'svelte';
  import { getDispatcher } from '../dispatch/context';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { navigate } from '../routing/router.svelte';
  import { notify } from '../ui/toast.svelte';
  import Button from '../ui/Button.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import ActivityRowView from '../ui/widgets/ActivityRow.svelte';
  import TagChip from '../ui/widgets/TagChip.svelte';
  import AttributeSidePanel from '../ui/widgets/AttributeSidePanel.svelte';
  import { AttributeSchemaCache } from '../filter/attribute_schema.svelte';
  import type { FilterAttribute } from '../filter/attribute_schema.svelte';
  import type {
    ActivityRow,
    ActivitySelectInput,
    ActivitySelectOutput,
    AttributeUpdateInput,
    AttributeUpdateOutput,
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
  } from '../reg/types';
  import {
    activitySelect,
    appliedTagIds,
    applyTagPayload,
    attributeDefSelect,
    attributeUpdate,
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
      // Only show defs bound to the `task` card type (or unbound, which
      // server-side means "applies everywhere").
      const boundToTask =
        def.bound_to.length === 0 ||
        def.bound_to.some((b) => b.card_type_name === 'task');
      if (!boundToTask) continue;
      const fa = schemaCache.toFilterAttribute(def.name);
      if (fa !== null) out.push(fa);
    }
    return out;
  });

  /** refOptions for the side panel — pre-resolved Combobox option lists. */
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
    const fSchema = schemaCache.load();

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

  onMount(() => {
    void refresh(true);
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

  function toggleTags(): void {
    tagPickerOpen = !tagPickerOpen;
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
    if (task !== null && typeof task.parent_card_id === 'number') {
      navigate(`/project/${task.parent_card_id}`);
    } else {
      navigate('/projects');
    }
  }

  /* -------------------------------------------------------------------- */
  /* Keyboard shortcuts                                                   */
  /* -------------------------------------------------------------------- */

  useShortcut('task_detail', 'e', () => void focusTitleEdit(), 'Edit title');
  useShortcut('task_detail', 'c', () => void focusComment(), 'Focus comment');
  useShortcut('task_detail', 't', toggleTags, 'Toggle tag picker');

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
  class="grid h-full grid-cols-1 gap-6 p-6 md:grid-cols-[minmax(0,1fr)_280px]"
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
    <main class="flex min-w-0 flex-col gap-6">
      <!-- Header: back arrow + title (read-only / editing) -->
      <header class="flex items-start gap-2">
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
              class="w-full rounded-md border border-border bg-bg px-3 py-2 text-2xl font-semibold text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onkeydown={onTitleKeydown}
              onblur={() => void commitTitle()}
            />
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <h1
              data-testid="task-title"
              class="cursor-text truncate rounded-md px-1 py-0.5 text-2xl font-semibold text-fg hover:bg-surface"
              title="Click to edit (or press e)"
              onclick={() => void focusTitleEdit()}
            >
              {displayTitle}
            </h1>
          {/if}
          <p class="mt-1 px-1 font-mono text-xs text-muted">#{taskId}</p>
        </div>
      </header>

      <!-- Description -->
      <section aria-labelledby="desc-heading">
        <h2 id="desc-heading" class="mb-2 text-sm font-semibold text-muted">
          Description
        </h2>
        {#if editingDescription}
          <textarea
            bind:this={descEl}
            bind:value={descDraft}
            data-testid="task-description-input"
            rows="6"
            class="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            placeholder="Write a description… (Mod+Enter to save, Esc to cancel)"
            onkeydown={onDescriptionKeydown}
            onblur={() => void commitDescription()}
          ></textarea>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            data-testid="task-description"
            class="min-h-[3rem] cursor-text whitespace-pre-wrap rounded-md border border-transparent px-3 py-2 text-sm text-fg hover:border-border hover:bg-surface/50"
            title="Click to edit"
            onclick={() => void focusDescriptionEdit()}
          >
            {#if displayDescription === ''}
              <span class="text-muted">Click to add a description…</span>
            {:else}
              {displayDescription}
            {/if}
          </div>
        {/if}
      </section>

      <!-- Activity stream -->
      <section aria-labelledby="activity-heading" class="flex flex-col gap-1">
        <h2 id="activity-heading" class="mb-1 text-sm font-semibold text-muted">
          Activity ({orderedActivity.length})
        </h2>
        {#if orderedActivity.length === 0}
          <p class="text-sm text-muted">No activity yet.</p>
        {:else}
          <ul
            data-testid="task-activity-list"
            class="flex max-h-[40vh] flex-col gap-0 overflow-y-auto rounded-md border border-border bg-bg p-2"
          >
            {#each orderedActivity as row (row.id)}
              <li>
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
      <section
        aria-labelledby="comment-heading"
        class="flex flex-col gap-2 rounded-md border border-border bg-bg p-3"
      >
        <h2 id="comment-heading" class="text-sm font-semibold text-muted">
          Comment
        </h2>
        <textarea
          bind:this={commentEl}
          bind:value={commentDraft}
          data-testid="task-comment-input"
          rows="3"
          class="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
      </section>
    </main>

    <!-- Right rail ------------------------------------------------------- -->
    <aside class="flex flex-col gap-4">
      <AttributeSidePanel
        cardId={taskId}
        attributes={task.attributes}
        {schema}
        {refOptions}
        onChanged={onAttributeChanged}
      />

      <!-- Tags section -->
      <section
        aria-labelledby="tags-heading"
        class="flex flex-col gap-2 rounded-md border border-border bg-bg p-3"
      >
        <h2 id="tags-heading" class="text-sm font-semibold text-fg">Tags</h2>
        {#if appliedTags.length === 0}
          <p class="text-xs text-muted">No tags applied.</p>
        {:else}
          <div data-testid="task-tag-row" class="flex flex-wrap gap-1.5">
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
      </section>
    </aside>
  {/if}
</div>

<!--
  ProjectDetailScreen.

  Project header (inline-editable title + description) followed by the
  child-task list with FilterBar + quick-entry overlay. Click a task row
  to navigate to `/task/<id>`.

  Initial-batch contract (dispatcher coalesces into ONE HTTP call):

    1. `card.select_with_attributes`  (project itself, filtered by id)
    2. `card.select_with_attributes`  (tasks under the project)
    3. `user.select`                  (assignee labels)
    4. `card.select_with_attributes`  (milestones)
    5. `card.select_with_attributes`  (components)
    6. `card.select_with_attributes`  (tags)
    7. `attribute_def.select`         (FilterBar schema, cached)

  Keyboard:
    - `n`       open quick-entry overlay (creates a task under THIS project)
    - `j`/`k`   move selection across visible task rows
    - `Enter`   open selected task
    - `e`       enter title-edit mode for the project header
    - `Mod+Enter` save the active inline edit
    - `Esc`     cancel the active inline edit

  Ports `client/lib/ui/screens/project_detail_screen.dart` (516 LOC).
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getDispatcher } from '../dispatch/context';
  import { BatchAbortedError, SubRequestError } from '../dispatch/errors';
  import {
    AttributeSchemaCache,
    type FilterAttribute,
  } from '../filter/attribute_schema.svelte';
  import FilterBar from '../filter/FilterBar.svelte';
  import {
    predicateToJson,
    type Predicate,
  } from '../filter/predicate';
  import {
    defaultQuickChipsFor,
    type QuickChip,
  } from '../filter/quick_chips';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { useQuickEntry } from '../quick_entry/use_quick_entry.svelte';
  import QuickEntryOverlay from '../quick_entry/QuickEntryOverlay.svelte';
  import {
    attributeUpdate,
    cardSelectWithAttributes,
    userSelect,
  } from '../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWhereTree,
    CardWithAttrs,
    UserRow,
    UserSelectInput,
    UserSelectOutput,
  } from '../reg/types';
  import { navigate } from '../routing/router.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { notify } from '../ui/toast.svelte';
  import TaskRow from '../ui/widgets/TaskRow.svelte';
  import { cx } from '../util/class_names';
  import { applyPredicateAndSort, editingPayload } from './project_detail_helpers';

  /* ----------------------------------------------------------------- props */

  interface Props {
    params?: Record<string, string>;
  }
  let { params = {} }: Props = $props();
  // Snapshot the route param at mount time. The router unmounts +
  // remounts this screen when `:id` changes (different path), so a
  // reactive reference is unnecessary — the captured value is the live
  // value for the lifetime of this component instance.
  // svelte-ignore state_referenced_locally
  const projectId = Number(params['id'] ?? 0);

  setActiveScope('project_detail');
  const dispatcher = getDispatcher();
  const schemaCache = new AttributeSchemaCache(dispatcher);

  /* ----------------------------------------------------------------- state */

  let project = $state<CardWithAttrs | null>(null);
  let tasks = $state<CardWithAttrs[]>([]);
  let userNames = $state<Record<number, string>>({});
  let cardTitles = $state<Record<number, string>>({});
  let tagPaths = $state<Record<number, string>>({});
  let users = $state<UserRow[]>([]);
  let predicate = $state<Predicate | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedIndex = $state(0);

  // Inline-edit ephemera. Only one of {title,description} can be active
  // at a time; opening one closes the other.
  let editingTitle = $state(false);
  let editingDescription = $state(false);
  let titleDraft = $state('');
  let descDraft = $state('');
  let titleSaving = $state(false);
  let descSaving = $state(false);
  let titleInputEl: HTMLInputElement | null = $state(null);
  let descInputEl: HTMLTextAreaElement | null = $state(null);

  const qe = useQuickEntry({
    scope: 'project_detail',
    defaultCardType: 'task',
    parentCardId: projectId,
    onCreated: () => {
      void refresh();
    },
  });

  /* -------------------------------------------------------- initial batch */

  /**
   * Fire the screen's seven sub-requests in one render tick. The
   * dispatcher coalesces them into a single `POST /api/v1/batch`.
   *
   * Note: the project itself is fetched via a `card.select_with_attributes`
   * with `card_type_name='project'` and we pick the row whose id matches
   * client-side. The server has no built-in id-only predicate; this matches
   * the Dart screen's posture (small project counts in v1).
   */
  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const projectP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'project' },
      });
      const tasksInput: CardSelectWithAttributesInput = {
        cardTypeName: 'task',
        parentCardId: projectId,
        limit: 200,
      };
      if (predicate !== null) {
        tasksInput.tree = predicateToJson(predicate) as CardWhereTree;
      }
      const tasksP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: tasksInput,
      });
      const usersP = dispatcher.request<UserSelectInput, UserSelectOutput>({
        endpoint: userSelect.endpoint,
        action: userSelect.action,
      });
      const milestonesP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'milestone' },
      });
      const componentsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'component' },
      });
      const tagsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'tag' },
      });
      const schemaP = schemaCache.load();

      const [projOut, tasksOut, usersOut, milestonesOut, componentsOut, tagsOut] =
        await Promise.all([
          projectP,
          tasksP,
          usersP,
          milestonesP,
          componentsP,
          tagsP,
          schemaP,
        ]);

      const proj = projOut.rows.find((r) => r.id === projectId) ?? null;
      project = proj;
      tasks = tasksOut.rows;
      users = usersOut.rows;
      const namesNext: Record<number, string> = {};
      for (const u of usersOut.rows) namesNext[u.id] = u.display_name;
      userNames = namesNext;
      const titlesNext: Record<number, string> = {};
      for (const m of milestonesOut.rows) {
        const t = m.attributes['title'];
        if (typeof t === 'string') titlesNext[m.id] = t;
      }
      for (const c of componentsOut.rows) {
        const t = c.attributes['title'];
        if (typeof t === 'string') titlesNext[c.id] = t;
      }
      cardTitles = titlesNext;
      const tagsNext: Record<number, string> = {};
      for (const t of tagsOut.rows) {
        const p = t.attributes['path'];
        if (typeof p === 'string') tagsNext[t.id] = p;
      }
      tagPaths = tagsNext;
      loading = false;
      // Reset selection if the new visible range shrank.
      selectedIndex = 0;
    } catch (e) {
      if (e instanceof SubRequestError) {
        error = e.message;
      } else if (e instanceof BatchAbortedError) {
        error = e.reason;
      } else {
        error = e instanceof Error ? e.message : String(e);
      }
      loading = false;
    }
  }

  /* ----------------------------------------------------- derived: visible */

  /**
   * FilterBar attribute palette. Built from the schema cache once it
   * loads; per-attribute ref-options resolve via the in-memory tables we
   * just fetched (assignee, milestone_ref, component_ref, tags).
   */
  const filterAttributes = $derived.by((): FilterAttribute[] => {
    if (!schemaCache.loaded) return [];
    // Surface a stable subset that the server-side seed schema actually
    // populates on `task` cards. Other attribute types still flow through
    // the advanced editor.
    const wanted = ['status', 'assignee', 'milestone_ref', 'component_ref', 'tags'];
    const out: FilterAttribute[] = [];
    for (const name of wanted) {
      const fa = schemaCache.toFilterAttribute(name, (cardTypeName) => {
        if (cardTypeName === 'milestone' || cardTypeName === 'component') {
          return Object.entries(cardTitles).map(([id, label]) => ({
            value: Number(id),
            label,
          }));
        }
        if (cardTypeName === 'tag') {
          return Object.entries(tagPaths).map(([id, label]) => ({
            value: Number(id),
            label,
          }));
        }
        if (cardTypeName === 'user') {
          return users.map((u) => ({ value: u.id, label: u.display_name }));
        }
        return [];
      });
      if (fa !== null) out.push(fa);
    }
    return out;
  });

  /** Quick chips: derived per-attribute (enum → one chip per option). */
  const quickChips = $derived<QuickChip[]>(
    filterAttributes.flatMap((a) => defaultQuickChipsFor(a)),
  );

  /** Visible = predicate-filtered, sorted-by-id task list. */
  const visible = $derived<CardWithAttrs[]>(
    applyPredicateAndSort(tasks, predicate, 'id'),
  );

  const titleText = $derived.by((): string => {
    if (project === null) return `Project ${projectId}`;
    const t = project.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    return `Project ${projectId}`;
  });

  const descriptionText = $derived.by((): string => {
    if (project === null) return '';
    const d = project.attributes['description'];
    if (typeof d === 'string') return d;
    return '';
  });

  /* ------------------------------------------------------ inline editing */

  async function startEditTitle(): Promise<void> {
    if (project === null) return;
    if (editingTitle) return;
    editingDescription = false;
    titleDraft = titleText;
    editingTitle = true;
    await tick();
    titleInputEl?.focus();
    titleInputEl?.select();
  }

  function cancelEditTitle(): void {
    editingTitle = false;
    titleDraft = '';
  }

  async function commitTitle(): Promise<void> {
    if (project === null) return;
    if (titleSaving) return;
    const r = editingPayload(project.id, 'title', titleText, titleDraft);
    if (!r.changed) {
      cancelEditTitle();
      return;
    }
    titleSaving = true;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: r.payload,
      });
      editingTitle = false;
      titleDraft = '';
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Failed to save title: ${msg}` });
    } finally {
      titleSaving = false;
    }
  }

  async function startEditDescription(): Promise<void> {
    if (project === null) return;
    if (editingDescription) return;
    editingTitle = false;
    descDraft = descriptionText;
    editingDescription = true;
    await tick();
    descInputEl?.focus();
  }

  function cancelEditDescription(): void {
    editingDescription = false;
    descDraft = '';
  }

  async function commitDescription(): Promise<void> {
    if (project === null) return;
    if (descSaving) return;
    const r = editingPayload(
      project.id,
      'description',
      descriptionText,
      descDraft,
    );
    if (!r.changed) {
      cancelEditDescription();
      return;
    }
    descSaving = true;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: r.payload,
      });
      editingDescription = false;
      descDraft = '';
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Failed to save description: ${msg}` });
    } finally {
      descSaving = false;
    }
  }

  function onTitleInputKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEditTitle();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      void commitTitle();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      void commitTitle();
    }
  }

  function onDescInputKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEditDescription();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      void commitDescription();
    }
  }

  /* ----------------------------------------------------- keyboard helpers */

  function moveSelection(delta: number): void {
    if (visible.length === 0) {
      selectedIndex = 0;
      return;
    }
    const next = selectedIndex + delta;
    if (next < 0) selectedIndex = 0;
    else if (next > visible.length - 1) selectedIndex = visible.length - 1;
    else selectedIndex = next;
  }

  function openSelected(): void {
    const sel = visible[selectedIndex];
    if (sel === undefined) return;
    navigate(`/task/${sel.id}`);
  }

  // `n` is bound by useQuickEntry. Bind the rest here.
  useShortcut('project_detail', 'j', () => moveSelection(+1), 'Next task');
  useShortcut('project_detail', 'k', () => moveSelection(-1), 'Previous task');
  useShortcut('project_detail', 'Enter', openSelected, 'Open selected', {
    fireInInputs: false,
  });
  useShortcut(
    'project_detail',
    'e',
    () => {
      void startEditTitle();
    },
    'Edit project title',
    { fireInInputs: false },
  );

  onMount(() => {
    void refresh();
  });
</script>

<div class="flex h-full flex-col gap-4 p-4">
  {#if loading && project === null}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null && project === null}
    <div
      role="alert"
      data-testid="project-error"
      class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load project: {error}
      <button
        type="button"
        class="ml-3 underline"
        onclick={() => void refresh()}
      >
        Retry
      </button>
    </div>
  {:else if project === null}
    <div class="flex flex-1 items-center justify-center">
      <EmptyState
        title="Project not found"
        description="Project #{projectId} doesn't exist or has been deleted."
        action={{ label: 'Back to projects', onClick: () => navigate('/projects') }}
      />
    </div>
  {:else}
    <!-- ----------------------------------------------------- header -->
    <header class="flex flex-col gap-2 border-b border-border pb-3">
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          {#if editingTitle}
            <input
              bind:this={titleInputEl}
              bind:value={titleDraft}
              type="text"
              disabled={titleSaving}
              aria-label="Project title"
              class={cx(
                'w-full rounded-md border border-accent bg-bg px-2 py-1 text-xl font-semibold text-fg',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
              onkeydown={onTitleInputKey}
              onblur={() => void commitTitle()}
            />
          {:else}
            <button
              type="button"
              class={cx(
                'w-full rounded-md px-2 py-1 text-left text-xl font-semibold text-fg',
                'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
              title="Click or press 'e' to edit title"
              onclick={() => void startEditTitle()}
            >
              {titleText}
            </button>
          {/if}

          {#if editingDescription}
            <textarea
              bind:this={descInputEl}
              bind:value={descDraft}
              rows="3"
              disabled={descSaving}
              aria-label="Project description"
              class={cx(
                'w-full resize-y rounded-md border border-accent bg-bg px-2 py-1 text-sm text-fg',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
              onkeydown={onDescInputKey}
              onblur={() => void commitDescription()}
            ></textarea>
          {:else}
            <button
              type="button"
              class={cx(
                'w-full rounded-md px-2 py-1 text-left text-sm',
                descriptionText.length === 0
                  ? 'italic text-muted'
                  : 'whitespace-pre-wrap text-fg',
                'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
              title="Click to edit description"
              onclick={() => void startEditDescription()}
            >
              {descriptionText.length === 0 ? 'Add a description…' : descriptionText}
            </button>
          {/if}
        </div>

        <Button variant="primary" size="md" onclick={() => qe.open()}>
          {#snippet children()}+ New task{/snippet}
        </Button>
      </div>
    </header>

    <!-- ----------------------------------------------------- filter bar -->
    <FilterBar
      attributes={filterAttributes}
      bind:predicate
      scope="project_detail"
      {quickChips}
      onchange={(p) => {
        predicate = p;
      }}
    />

    {#if error !== null}
      <div
        role="alert"
        class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
      >
        {error}
      </div>
    {/if}

    <!-- ----------------------------------------------------- task list -->
    {#if visible.length === 0}
      <div class="flex flex-1 items-center justify-center">
        {#if tasks.length === 0}
          <EmptyState
            title="No tasks yet"
            description="Create the first task with the button above (or press n)."
            action={{ label: 'Create first task', onClick: () => qe.open() }}
          />
        {:else}
          <EmptyState
            title="No tasks match"
            description="Try clearing the filter."
          />
        {/if}
      </div>
    {:else}
      <ul
        class="flex flex-1 flex-col gap-2 overflow-y-auto"
        aria-label="Tasks"
        data-testid="project-tasks-list"
      >
        {#each visible as task, i (task.id)}
          <li>
            <TaskRow
              card={task}
              selected={i === selectedIndex}
              {userNames}
              {cardTitles}
              {tagPaths}
              onSelect={() => {
                selectedIndex = i;
              }}
              onOpen={() => navigate(`/task/${task.id}`)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<QuickEntryOverlay {...qe.props} />

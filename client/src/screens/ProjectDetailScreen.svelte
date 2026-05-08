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
  import { onMount, untrack } from 'svelte';
  import { getDispatcher } from '../dispatch/context';
  import { BatchAbortedError, SubRequestError } from '../dispatch/errors';
  import {
    AttributeSchemaCache,
    type FilterAttribute,
  } from '../filter/attribute_schema.svelte';
  import { buildTaskFilterPalette } from '../filter/task_palette';
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
    cardSelectWithAttributes,
    userSelect,
  } from '../reg/handlers';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWhereTree,
    CardWithAttrs,
    UserRow,
    UserSelectInput,
    UserSelectOutput,
  } from '../reg/types';
  import { navigate } from '../routing/router.svelte';
  import { setTaskNavList } from '../routing/task_nav_list.svelte';
  import { getFilter, setFilter } from './filter_state.svelte';
  import { projectScope } from '../shell/project_scope.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import ProjectPropertiesPanel from '../ui/widgets/ProjectPropertiesPanel.svelte';
  import TaskRow from '../ui/widgets/TaskRow.svelte';
  import { cx } from '../util/class_names';
  import { applyPredicateAndSort } from './project_detail_helpers';

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

  // Mirror the route into the nav-sidebar project picker. Visiting a
  // project detail (by click, deep link, or keyboard "Enter") should
  // pin the global scope so list screens land scoped to this project.
  if (projectId > 0) projectScope.setProject(projectId);

  setActiveScope('project_detail');
  const dispatcher = getDispatcher();
  const schemaCache = new AttributeSchemaCache(dispatcher);

  /* ----------------------------------------------------------------- state */

  let project = $state<CardWithAttrs | null>(null);
  let tasks = $state<CardWithAttrs[]>([]);
  let users = $state<UserRow[]>([]);
  let milestones = $state<CardWithAttrs[]>([]);
  let components = $state<CardWithAttrs[]>([]);
  let tagsRows = $state<CardWithAttrs[]>([]);
  // ProjectDetailScreen's projectId is fixed for the lifetime of this
  // component (the route remounts when :id changes), so a single read
  // at init is enough — no projectId-change effect needed.
  let predicate = $state<Predicate | null>(
    untrack(() => getFilter('project_detail', projectId)),
  );
  $effect(() => {
    setFilter('project_detail', projectId, predicate);
  });

  /** Derived lookup tables fed to TaskRow. */
  const userNames = $derived.by((): Record<number, string> => {
    const out: Record<number, string> = {};
    for (const u of users) out[u.id] = u.display_name;
    return out;
  });
  const cardTitles = $derived.by((): Record<number, string> => {
    const out: Record<number, string> = {};
    for (const r of milestones) {
      const t = r.attributes['title'];
      if (typeof t === 'string') out[r.id] = t;
    }
    for (const r of components) {
      const t = r.attributes['title'];
      if (typeof t === 'string') out[r.id] = t;
    }
    return out;
  });
  const tagPaths = $derived.by((): Record<number, string> => {
    const out: Record<number, string> = {};
    for (const r of tagsRows) {
      const p = r.attributes['path'];
      if (typeof p === 'string') out[r.id] = p;
    }
    return out;
  });
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedIndex = $state(0);

  // Properties slide-out (title / description / project-bound attributes).
  let propsOpen = $state(false);

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
      milestones = milestonesOut.rows;
      components = componentsOut.rows;
      tagsRows = tagsOut.rows;
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
   * FilterBar palette. Single source of truth: `filter/task_palette.ts`.
   * Same names / labels / option lists as Inbox, Grid, Kanban.
   */
  const filterAttributes = $derived<FilterAttribute[]>(
    buildTaskFilterPalette({
      schema: schemaCache,
      users,
      milestones,
      components,
      tags: tagsRows,
    }),
  );
  /** Status palette entry, surfaced so TaskRow can resolve the status
   *  enum label and render the same text as the FilterBar chip. */
  const statusAttribute = $derived(
    filterAttributes.find((a) => a.name === 'status'),
  );

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

  /** Capture the current visible task order as the nav-list and navigate. */
  function openTaskById(id: number): void {
    setTaskNavList({
      label: titleText,
      ids: visible.map((c) => c.id),
    });
    navigate(`/task/${id}`);
  }

  function openSelected(): void {
    const sel = visible[selectedIndex];
    if (sel === undefined) return;
    openTaskById(sel.id);
  }

  // `n` is bound by useQuickEntry. Bind the rest here.
  useShortcut('project_detail', ['j', 'ArrowDown'], () => moveSelection(+1), 'Down');
  useShortcut('project_detail', ['k', 'ArrowUp'], () => moveSelection(-1), 'Up');
  useShortcut('project_detail', 'Enter', openSelected, 'Open selected', {
    fireInInputs: false,
  });
  useShortcut(
    'project_detail',
    'e',
    () => {
      propsOpen = true;
    },
    'Edit project properties',
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
        <div class="flex min-w-0 flex-1 flex-col gap-1 px-2 py-1">
          <h1 class="truncate text-xl font-semibold text-fg">{titleText}</h1>
          {#if descriptionText.length === 0}
            <p class="text-sm italic text-muted">No description.</p>
          {:else}
            <p class="whitespace-pre-wrap text-sm text-fg">{descriptionText}</p>
          {/if}
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            onclick={() => {
              propsOpen = true;
            }}
          >
            {#snippet children()}Edit properties{/snippet}
          </Button>
          <Button variant="primary" size="md" onclick={() => qe.open()}>
            {#snippet children()}+ New task{/snippet}
          </Button>
        </div>
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
              statusOptions={statusAttribute?.options}
              onSelect={() => {
                selectedIndex = i;
              }}
              onOpen={() => openTaskById(task.id)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<QuickEntryOverlay {...qe.props} />

<ProjectPropertiesPanel
  bind:open={propsOpen}
  cardId={projectId}
  onSaved={() => void refresh()}
/>

<!--
  ProjectDetailScreen.

  Project header (inline-editable title + description) followed by the
  child-task list with FilterBar + quick-entry overlay. Click a task row
  to navigate to `/task/<id>`.

  Initial-batch contract (dispatcher coalesces into ONE HTTP call):

    1. `card.select_with_attributes`  (project itself, filtered by id)
    2. `card.select_with_attributes`  (tasks under the project)
    3. `card.select_with_attributes`  (persons; assignee labels)
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
  import { untrack } from 'svelte';
  import { getDispatcher } from '../dispatch/context';
  import { BatchAbortedError, SubRequestError } from '../dispatch/errors';
  import {
    sharedSchemaCache,
    type FilterAttribute,
  } from '../filter/attribute_schema.svelte';
  import { buildTaskFilterPalette } from '../filter/task_palette';
  import ScreenFilterBar from '../filter/ScreenFilterBar.svelte';
  import {
    predicateToJson,
    type Predicate,
  } from '../filter/predicate';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { useQuickEntry } from '../quick_entry/use_quick_entry.svelte';
  import QuickEntryOverlay from '../quick_entry/QuickEntryOverlay.svelte';
  import {
    cardSelectWithAttributes,
  } from '../reg/handlers';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWhereTree,
    CardWithAttrs,
    ID,
  } from '../reg/types';
  import { navigate } from '../routing/router.svelte';
  import { setTaskNavList } from '../routing/task_nav_list.svelte';
  import { getFilter } from './filter_state.svelte';
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
  const projectId: ID = ((): ID => {
    const raw = params['id'] ?? '';
    if (raw === '') return 0n;
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  })();
  /** Active screen slug from `/project/:id/screen/:slug`. Drives the
   *  preset cache scope so two pair-layout screens in the same
   *  project don't share state. */
  // svelte-ignore state_referenced_locally
  const slug: string = ((): string => {
    const v = params['slug'];
    return typeof v === 'string' && v !== '' ? v : 'project';
  })();

  // Mirror the route into the nav-sidebar project picker. Visiting a
  // project detail (by click, deep link, or keyboard "Enter") should
  // pin the global scope so list screens land scoped to this project.
  if (projectId > 0n) projectScope.setProject(projectId);

  setActiveScope('project_detail');
  const dispatcher = getDispatcher();
  const schemaCache = sharedSchemaCache(dispatcher);

  /* ----------------------------------------------------------------- state */

  let project = $state<CardWithAttrs | null>(null);
  let tasks = $state<CardWithAttrs[]>([]);
  let persons = $state<CardWithAttrs[]>([]);
  let milestones = $state<CardWithAttrs[]>([]);
  let components = $state<CardWithAttrs[]>([]);
  let tagsRows = $state<CardWithAttrs[]>([]);
  let statuses = $state<CardWithAttrs[]>([]);
  // ScreenFilterBar owns preset loading and predicate persistence —
  // we just keep a bindable predicate the visible-rows derivation
  // reads from.
  let predicate = $state<Predicate | null>(
    untrack(() => getFilter(slug, projectId)),
  );

  /** Derived lookup tables fed to TaskRow. */
  const personNames = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of persons) {
      const t = p.attributes['title'];
      if (typeof t === 'string') out[p.id.toString()] = t;
    }
    return out;
  });
  const cardTitles = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of milestones) {
      const t = r.attributes['title'];
      if (typeof t === 'string') out[r.id.toString()] = t;
    }
    for (const r of components) {
      const t = r.attributes['title'];
      if (typeof t === 'string') out[r.id.toString()] = t;
    }
    return out;
  });
  const tagPaths = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of tagsRows) {
      const p = r.attributes['path'];
      if (typeof p === 'string') out[r.id.toString()] = p;
    }
    return out;
  });
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedIndex = $state(0);

  // Properties slide-out (title / description / project-bound attributes).
  let propsOpen = $state(false);

  // Gate 6: candidateStatuses is the loaded status set. Getter form
  // keeps the rune reactive across the async fetch.
  const qe = useQuickEntry({
    scope: 'project_detail',
    defaultCardType: 'task',
    parentCardId: projectId,
    candidateStatuses: () => statuses,
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
        // Server's tree expects a group shape; bare leaves must be
        // wrapped in a single-child AND so the wire is always a group.
        const json = predicateToJson(predicate);
        if (predicate.kind === 'group') {
          tasksInput.tree = json as CardWhereTree;
        } else {
          tasksInput.tree = {
            connective: 'and',
            children: [json],
          } as unknown as CardWhereTree;
        }
      }
      const tasksP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: tasksInput,
      });
      const personsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'person' },
      });
      // Picker queries are scoped to this project — the value-cards
      // (milestones, components, tags) all sit directly under the
      // project in v1, so filtering by parentCardId gives the
      // in-project option set.
      const milestonesP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'milestone', parentCardId: projectId },
      });
      const componentsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'component', parentCardId: projectId },
      });
      const tagsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'tag', parentCardId: projectId },
      });
      const statusesP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'status', parentCardId: projectId },
      });
      const schemaP = schemaCache.load();

      const [projOut, tasksOut, personsOut, milestonesOut, componentsOut, tagsOut, statusesOut] =
        await Promise.all([
          projectP,
          tasksP,
          personsP,
          milestonesP,
          componentsP,
          tagsP,
          statusesP,
          schemaP,
        ]);

      const proj = projOut.rows.find((r) => r.id === projectId) ?? null;
      project = proj;
      tasks = tasksOut.rows;
      persons = personsOut.rows;
      milestones = milestonesOut.rows;
      components = componentsOut.rows;
      tagsRows = tagsOut.rows;
      statuses = statusesOut.rows;
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
      // Assignee → person cards. The palette resolves it via its
      // refResolver from this list.
      persons,
      milestones,
      components,
      tags: tagsRows,
      statuses,
    }),
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
  function openTaskById(id: ID): void {
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

  // Refresh on predicate change. Gated on `filterReady` so the first
  // request waits for ScreenFilterBar's default-filter probe — kills
  // the brief flash of unfiltered rows on cold load.
  let filterReady = $state(false);
  $effect(() => {
    void predicate;
    void filterReady;
    if (!filterReady) return;
    void refresh();
  });
</script>

<div class="flex h-full flex-col gap-4 p-4">
  <!--
    ScreenFilterBar lives at the top level (outside the conditional render
    below) so it mounts on the first render — *before* `project` loads.
    Its $effect drives the default-filter probe; the resolved `filterReady`
    binding then unblocks `refresh()` and the screen's data fetch. Mounting
    it only in the `{:else}` branch would deadlock: project never loads
    because filterReady never flips, because the FilterBar that owns it
    never mounts.
  -->
  <ScreenFilterBar
    screenSlug={slug}
    projectId={projectId}
    {dispatcher}
    {filterAttributes}
    bind:predicate
    bind:filterReady
  />

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
              {personNames}
              {cardTitles}
              {tagPaths}
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

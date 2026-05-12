<!--
  ProjectsScreen.

  Top-level list of every project, with `+ New project` quick-entry, a
  `<FilterBar>` for predicates, and substring search by title.

  Initial-batch contract (dispatcher coalesces all three into ONE HTTP
  `POST /api/v1/batch`):

    1. `card.select_with_attributes`  (card_type_name='project')
    2. `attribute_def.select`         (cached on `AttributeSchemaCache`)
    3. `user.select`                  (assignee labels for filter chips)

  Filter / search is purely client-side — `card.select_with_attributes`
  already returned every top-level project and the dataset is small.

  Keyboard:
    - `n`     open quick-entry overlay (bound by `useQuickEntry`)
    - `j`/`k` move selection across visible rows
    - `Enter` open selected project
    - `/`     focus the search input

  Ports `client/lib/ui/screens/projects_screen.dart` (418 LOC).
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getDispatcher } from '../dispatch/context';
  import { useBag } from '../dispatch/bag.svelte';
  import { sharedSchemaCache, type FilterAttribute } from '../filter/attribute_schema.svelte';
  import FilterBar from '../filter/FilterBar.svelte';
  import type { Predicate } from '../filter/predicate';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { projectScope } from '../shell/project_scope.svelte';
  import { useQuickEntry } from '../quick_entry/use_quick_entry.svelte';
  import QuickEntryOverlay from '../quick_entry/QuickEntryOverlay.svelte';
  import {
    cardSelectWithAttributes,
    userSelect,
  } from '../reg/handlers';
  import type {
    CardWithAttrs,
    ID,
    UserRow,
  } from '../reg/types';
  import { navigate } from '../routing/router.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import ProjectPropertiesPanel from '../ui/widgets/ProjectPropertiesPanel.svelte';
  import { cx } from '../util/class_names';
  import { searchAndFilter, move } from './projects_helpers';

  setActiveScope('projects');

  const dispatcher = getDispatcher();
  const schema = sharedSchemaCache(dispatcher);
  const bag = useBag(dispatcher);

  /* ---------------------------------------------------------------- state */

  let projects = $state<CardWithAttrs[]>([]);
  let users = $state<UserRow[]>([]);
  let loading = $state(true);
  let search = $state('');
  let predicate = $state<Predicate | null>(null);
  let selectedIndex = $state(0);
  let searchEl: HTMLInputElement | null = $state(null);

  // Slide-out editor for the project's own properties (title, description,
  // attributes). Opening it sets `editingProjectId` so the panel knows which
  // card to load; closing nulls it back out.
  let editingProjectId = $state<ID | null>(null);
  let editorOpen = $state(false);
  function editProject(id: ID): void {
    editingProjectId = id;
    editorOpen = true;
  }

  const qe = useQuickEntry({
    scope: 'projects',
    defaultCardType: 'project',
    onCreated: () => {
      projectScope.notifyProjectsChanged();
      refresh();
    },
  });

  /* -------------------------------------------------------- initial batch */

  // Per-call-site bindings. Each bind() returns a function that fires a
  // sub-request keyed to its handler; calling several in the same tick
  // coalesces into one batched POST. Errors flow through the global
  // dispatcher.onFault registry (toast / /login redirect) — the local
  // handler only handles the happy path. Bag lifecycle is tied to this
  // component, so late responses for unmounted instances are dropped.
  const loadProjects = bag.bind(cardSelectWithAttributes, 'projects.load', (r) => {
    if (r.ok) {
      projects = r.data.rows;
      selectedIndex = 0;
    }
    loading = false;
  });
  const loadUsers = bag.bind(userSelect, 'projects.users', (r) => {
    if (r.ok) users = r.data.rows;
  });

  function refresh(): void {
    loading = true;
    loadProjects({ cardTypeName: 'project' });
    loadUsers({});
    // `AttributeSchemaCache.load()` issues `attribute_def.select` on the
    // same tick (and short-circuits on subsequent screen mounts). It
    // still uses the legacy promise API; failures surface through the
    // same global fault registry.
    void schema.load();
  }

  /* ----------------------------------------------------- derived: visible */

  /** FilterBar attribute palette. Project cards in the seed schema only
   *  carry `title` + `description` — leave the palette empty so the user
   *  can still hand-author leaves via the advanced editor without us
   *  inventing attributes that don't exist in the data. */
  const filterAttributes = $derived<FilterAttribute[]>([]);

  /** Visible = filter + search applied to the loaded list. */
  const visible = $derived<CardWithAttrs[]>(
    searchAndFilter(projects, search, predicate),
  );

  /* ----------------------------------------------------- keyboard helpers */

  function moveSelection(delta: number): void {
    selectedIndex = move(visible.length, selectedIndex, delta);
  }

  function openSelected(): void {
    const sel = visible[selectedIndex];
    if (sel === undefined) return;
    navigate(`/project/${sel.id}`);
  }

  async function focusSearch(): Promise<void> {
    await tick();
    searchEl?.focus();
    searchEl?.select();
  }

  // `n` is bound by useQuickEntry. Bind the rest here.
  useShortcut('projects', 'j', () => moveSelection(+1), 'Next project');
  useShortcut('projects', 'k', () => moveSelection(-1), 'Previous project');
  useShortcut('projects', 'Enter', openSelected, 'Open selected', {
    fireInInputs: false,
  });
  useShortcut('projects', '/', () => void focusSearch(), 'Focus search', {
    fireInInputs: false,
  });

  /* --------------------------------------------------- render description */

  /**
   * Two-line description: the server-stored description attribute
   * truncated via a `line-clamp-2` Tailwind class on the rendered <p>.
   * Empty / missing strings fall through to undefined so the row simply
   * skips the paragraph.
   */
  function descriptionFor(p: CardWithAttrs): string | undefined {
    const v = p.attributes['description'];
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed;
  }

  function titleFor(p: CardWithAttrs): string {
    const t = p.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    return '(untitled)';
  }

  // Mark `users` as read so the unused-binding lint stays quiet — the
  // `user.select` fetch is part of the locked initial-batch contract
  // (see `projects_helpers.ts`) even though the MVP UI does not surface
  // assignee labels yet.
  $effect(() => {
    void users.length;
  });

  onMount(() => {
    refresh();
  });
</script>

<div class="flex h-full flex-col gap-3 p-4">
  <header class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Projects</h1>
    <Button variant="primary" size="md" onclick={() => qe.open()}>
      {#snippet children()}+ New project{/snippet}
    </Button>
  </header>

  <div class="flex flex-col gap-2">
    <FilterBar
      attributes={filterAttributes}
      bind:predicate
      onchange={(p) => {
        predicate = p;
      }}
    />

    <input
      type="search"
      bind:this={searchEl}
      bind:value={search}
      placeholder="Search projects… (press / to focus)"
      aria-label="Search projects"
      class={cx(
        'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm',
        'text-fg placeholder:text-muted',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    />
  </div>

  {#if loading && projects.length === 0}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if visible.length === 0}
    <div class="flex flex-1 items-center justify-center">
      {#if projects.length === 0}
        <EmptyState
          title="No projects yet"
          description="Create your first project to get started."
          action={{ label: 'Create first project', onClick: () => qe.open() }}
        />
      {:else}
        <EmptyState
          title="No projects match"
          description="Try clearing the filter or search."
        />
      {/if}
    </div>
  {:else}
    <ul class="flex flex-1 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
      {#each visible as project, i (project.id)}
        {@const desc = descriptionFor(project)}
        <li
          class={cx(
            'flex items-center gap-1 hover:bg-surface',
            i === selectedIndex && 'bg-surface',
          )}
        >
          <a
            href={`/project/${project.id}`}
            class={cx(
              'flex min-w-0 flex-1 flex-col gap-1 px-3 py-2 text-sm',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
            data-id={project.id}
            onclick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              navigate(`/project/${project.id}`);
            }}
            onfocus={() => {
              selectedIndex = i;
            }}
          >
            <span class="font-medium text-fg">{titleFor(project)}</span>
            {#if desc !== undefined}
              <p class="line-clamp-2 text-xs text-muted">{desc}</p>
            {/if}
            <span class="text-[10px] uppercase tracking-wide text-muted">
              open tasks: —
            </span>
          </a>
          <IconButton
            aria-label={`Edit project "${titleFor(project)}"`}
            title="Edit project properties"
            class="mr-2 shrink-0"
            onclick={() => editProject(project.id)}
          >
            {#snippet children()}
              <svg viewBox="0 0 16 16" class="h-4 w-4" aria-hidden="true">
                <path
                  d="M11 2 L14 5 L5 14 L2 14 L2 11 Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                  fill="none"
                />
              </svg>
            {/snippet}
          </IconButton>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<QuickEntryOverlay {...qe.props} />

<ProjectPropertiesPanel
  bind:open={editorOpen}
  cardId={editingProjectId}
  onSaved={() => {
    projectScope.notifyProjectsChanged();
    refresh();
  }}
/>

<style>
  /* Fallback line-clamp utility for environments where the Tailwind
     plugin is not picked up. Two lines + ellipsis. */
  :global(.line-clamp-2) {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>

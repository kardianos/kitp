<!--
  AdminScreensScreen — admin-only CRUD over `screen` + `filter` cards
  across every project.

  Complements <ScreenFilterBar>'s in-screen preset CRUD by surfacing every
  project's screen/filter cards in one place. Both surfaces hit the same
  handlers so the data layer stays the single source of truth.

  Layout: 3 panes, mirroring AdminAttributesScreen.
    LEFT  (~280px):   searchable project list + "+ New project".
    CENTER:           screens for the selected project, sorted by
                      sort_order then id. "+ Add screen" combobox uses
                      `missingScreenTypes(screens, SCREEN_TYPES)` so a
                      project can't end up with duplicate built-in layouts.
    RIGHT:            filters under the selected screen + "Default
                      filter:" combobox writing `default_filter` on
                      the screen card.

  Wire surface (no new endpoints):
    - card.select_with_attributes  (project / screen / filter)
    - card.insert + card.delete    (screen / filter)
    - attribute.update             (title / predicate / default_filter)

  Keyboard:
    /         focus left-pane search
    j / k     move project selection
    n         "+ New project" (bound by useQuickEntry)
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import { stringifyBigInt } from '../../dispatch/dispatcher';
  import { BatchAbortedError, SubRequestError } from '../../dispatch/errors';
  import { predicateToJson } from '../../filter/predicate';
  import {
    readColumnAttr,
    readDefaultFilterID,
    readLaneAttr,
    readPredicate,
    readScreenType,
    readTitle,
    SCREEN_TYPES,
    type ScreenType,
  } from '../../filter/screen_preset.svelte';
  import { setActiveScope, useShortcut } from '../../keys/shortcut';
  import { useQuickEntry } from '../../quick_entry/use_quick_entry.svelte';
  import QuickEntryOverlay from '../../quick_entry/QuickEntryOverlay.svelte';
  import {
    attributeUpdate,
    cardDelete,
    cardInsert,
    cardSelectWithAttributes,
  } from '../../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardDeleteInput,
    CardDeleteOutput,
    CardInsertInput,
    CardInsertOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Combobox from '../../ui/Combobox.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  import {
    errMsg,
    friendlyScreenLabel,
    missingScreenTypes,
    sortBySortOrder,
    validatePredicateJson,
  } from './admin_screens_helpers';
  import CardListPane from './CardListPane.svelte';

  setActiveScope('admin_screens');

  const dispatcher = getDispatcher();

  /* ----------------------------------------------------------------- state */

  let projects = $state<CardWithAttrs[]>([]);
  let screens = $state<CardWithAttrs[]>([]);
  let filters = $state<CardWithAttrs[]>([]);
  let search = $state('');
  let selectedProjectId = $state<ID | null>(null);
  let selectedScreenId = $state<ID | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let pendingAddScreenType = $state<ScreenType | null>(null);
  let searchEl: HTMLInputElement | null = $state(null);

  /* ------------------------------------------------------------ derivations */

  const filteredProjects = $derived.by((): CardWithAttrs[] => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return projects;
    return projects.filter((p) => readTitle(p).toLowerCase().includes(needle));
  });

  const selectedProject = $derived<CardWithAttrs | null>(
    selectedProjectId === null
      ? null
      : (projects.find((p) => p.id === selectedProjectId) ?? null),
  );

  const sortedScreens = $derived(sortBySortOrder(screens));

  const selectedScreen = $derived<CardWithAttrs | null>(
    selectedScreenId === null
      ? null
      : (screens.find((s) => s.id === selectedScreenId) ?? null),
  );

  /** Filters carry sort_order via the same admin convention; the wire
   *  already sorts by it but a fresh insert may not have one yet, so
   *  we re-sort defensively. */
  const sortedFilters = $derived(sortBySortOrder(filters));

  const addableScreenTypes = $derived(missingScreenTypes(screens, SCREEN_TYPES));

  const addScreenOptions = $derived.by(() =>
    addableScreenTypes.map((t) => ({ value: t, label: friendlyScreenLabel(t) })),
  );

  /** Combobox options for "Default filter:". Stringified ids because
   *  the Combobox uses `===` and bigint→string is unambiguous. */
  const filterOptions = $derived.by(() =>
    sortedFilters.map((f) => ({ value: f.id.toString(), label: readTitle(f) })),
  );

  const currentDefaultFilterValue = $derived.by<string | null>(() => {
    if (selectedScreen === null) return null;
    const id = readDefaultFilterID(selectedScreen);
    return id === null ? null : id.toString();
  });

  /* ------------------------------------------------------------ data fetch */

  /** Fetch a list of cards under a parent. `parentCardId` is omitted
   *  when null (top-level projects). */
  async function fetchCards(
    cardTypeName: string,
    parentCardId: ID | null,
  ): Promise<CardWithAttrs[]> {
    const data: CardSelectWithAttributesInput = { cardTypeName };
    if (parentCardId !== null) {
      data.parentCardId = parentCardId;
      data.order = [{ field: 'attributes.sort_order', direction: 'ASC' }];
    }
    const out = await dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data,
    });
    return out.rows;
  }

  async function loadProjects(): Promise<void> {
    loading = true;
    error = null;
    try {
      projects = await fetchCards('project', null);
      loading = false;
      if (selectedProjectId === null && projects.length > 0) {
        const first = projects[0];
        if (first !== undefined) selectedProjectId = first.id;
      }
    } catch (e) {
      loading = false;
      if (e instanceof SubRequestError) error = e.message;
      else if (e instanceof BatchAbortedError) error = e.reason;
      else error = e instanceof Error ? e.message : String(e);
    }
  }

  async function loadScreensFor(projectId: ID): Promise<void> {
    try {
      const rows = await fetchCards('screen', projectId);
      if (selectedProjectId !== projectId) return; // user switched mid-flight
      screens = rows;
      if (
        selectedScreenId === null ||
        !screens.some((s) => s.id === selectedScreenId)
      ) {
        const first = sortBySortOrder(screens)[0];
        selectedScreenId = first?.id ?? null;
      }
    } catch (e) {
      notify({ type: 'error', message: `Load screens failed: ${errMsg(e)}` });
    }
  }

  async function loadFiltersFor(screenId: ID): Promise<void> {
    try {
      const rows = await fetchCards('filter', screenId);
      if (selectedScreenId !== screenId) return;
      filters = rows;
    } catch (e) {
      notify({ type: 'error', message: `Load filters failed: ${errMsg(e)}` });
    }
  }

  // Reload screens when the project selection flips.
  $effect(() => {
    const pid = selectedProjectId;
    if (pid === null) {
      screens = [];
      selectedScreenId = null;
      filters = [];
      return;
    }
    void loadScreensFor(pid);
  });

  // Reload filters when the screen selection flips.
  $effect(() => {
    const sid = selectedScreenId;
    if (sid === null) {
      filters = [];
      return;
    }
    void loadFiltersFor(sid);
  });

  /* ---------------------------------------------------------- mutations */

  /** Thin wrapper around `attribute.update` + a toast on failure. */
  async function updateAttr(
    cardId: ID,
    attributeName: string,
    value: unknown,
    onOk: () => void | Promise<void>,
    failLabel: string,
  ): Promise<void> {
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: { cardId, attributeName, value },
      });
      await onOk();
    } catch (e) {
      notify({ type: 'error', message: `${failLabel}: ${errMsg(e)}` });
    }
  }

  async function deleteCard(
    cardId: ID,
    onOk: () => void | Promise<void>,
    failLabel: string,
  ): Promise<void> {
    try {
      const out = await dispatcher.request<CardDeleteInput, CardDeleteOutput>({
        endpoint: cardDelete.endpoint,
        action: cardDelete.action,
        data: { cardId },
      });
      if (!out.ok) {
        notify({ type: 'error', message: 'Delete refused.' });
        return;
      }
      await onOk();
    } catch (e) {
      notify({ type: 'error', message: `${failLabel}: ${errMsg(e)}` });
    }
  }

  async function insertCard(
    cardTypeName: string,
    parentCardId: ID,
    title: string,
    attributes: Record<string, unknown>,
    onOk: () => void | Promise<void>,
    failLabel: string,
  ): Promise<void> {
    try {
      await dispatcher.request<CardInsertInput, CardInsertOutput>({
        endpoint: cardInsert.endpoint,
        action: cardInsert.action,
        data: { cardTypeName, parentCardId, title, attributes },
      });
      await onOk();
    } catch (e) {
      notify({ type: 'error', message: `${failLabel}: ${errMsg(e)}` });
    }
  }

  async function addScreen(): Promise<void> {
    const project = selectedProject;
    const screenType = pendingAddScreenType;
    if (project === null || screenType === null) return;
    const title = friendlyScreenLabel(screenType);
    await insertCard(
      'screen',
      project.id,
      title,
      { layout: screenType, slug: screenType, sort_order: screens.length + 1 },
      async () => {
        pendingAddScreenType = null;
        await loadScreensFor(project.id);
        notify({ type: 'success', message: `Added "${title}" screen.` });
      },
      'Add screen failed',
    );
  }

  async function deleteScreen(s: CardWithAttrs): Promise<void> {
    const project = selectedProject;
    if (project === null) return;
    if (
      !window.confirm(
        `Delete the "${readTitle(s)}" screen? Filter cards under it will be removed too.`,
      )
    ) {
      return;
    }
    await deleteCard(
      s.id,
      async () => {
        if (selectedScreenId === s.id) selectedScreenId = null;
        await loadScreensFor(project.id);
        notify({ type: 'success', message: 'Screen deleted.' });
      },
      'Delete failed',
    );
  }

  async function setScreenDefaultFilter(filterId: ID | null): Promise<void> {
    const s = selectedScreen;
    if (s === null) return;
    await updateAttr(
      s.id,
      'default_filter',
      filterId,
      async () => {
        const project = selectedProject;
        if (project !== null) await loadScreensFor(project.id);
        notify({ type: 'success', message: 'Default filter updated.' });
      },
      'Update failed',
    );
  }

  async function addFilter(): Promise<void> {
    const s = selectedScreen;
    if (s === null) return;
    const title = window.prompt('New filter title:', '');
    if (title === null) return;
    const trimmed = title.trim();
    if (trimmed === '') return;
    await insertCard(
      'filter',
      s.id,
      trimmed,
      { sort_order: filters.length + 1 },
      async () => {
        await loadFiltersFor(s.id);
        notify({ type: 'success', message: `Added "${trimmed}".` });
      },
      'Add filter failed',
    );
  }

  async function renameFilter(f: CardWithAttrs, nextTitle: string): Promise<void> {
    const trimmed = nextTitle.trim();
    if (trimmed === '' || trimmed === readTitle(f)) return;
    await updateAttr(
      f.id,
      'title',
      trimmed,
      async () => {
        const sid = selectedScreenId;
        if (sid !== null) await loadFiltersFor(sid);
      },
      'Rename failed',
    );
  }

  async function editFilterPredicate(f: CardWithAttrs): Promise<void> {
    const cur = readPredicate(f);
    // stringifyBigInt (not raw JSON.stringify): predicate leaves carry
    // bigint card_ref values (assignee / milestone_ref / etc) and the
    // built-in serializer throws on those. The wire / storage format for
    // a saved predicate is JSON strings, which `readPredicate` revives
    // back to bigints on the way in.
    const seed = cur === null ? '' : stringifyBigInt(predicateToJson(cur));
    const next = window.prompt(
      `Predicate JSON for "${readTitle(f)}" (blank = no predicate):`,
      seed,
    );
    if (next === null) return;
    const validation = validatePredicateJson(next);
    if (!validation.ok) {
      notify({ type: 'error', message: validation.error });
      return;
    }
    const value =
      validation.predicate === null
        ? null
        : stringifyBigInt(predicateToJson(validation.predicate));
    await updateAttr(
      f.id,
      'predicate',
      value,
      async () => {
        const sid = selectedScreenId;
        if (sid !== null) await loadFiltersFor(sid);
        notify({ type: 'success', message: 'Predicate updated.' });
      },
      'Update failed',
    );
  }

  async function deleteFilter(f: CardWithAttrs): Promise<void> {
    if (!window.confirm(`Delete the "${readTitle(f)}" filter?`)) return;
    await deleteCard(
      f.id,
      async () => {
        const sid = selectedScreenId;
        if (sid !== null) await loadFiltersFor(sid);
        notify({ type: 'success', message: 'Filter deleted.' });
      },
      'Delete failed',
    );
  }

  /** Combobox options are built from SCREEN_TYPES, so anything the user
   *  picks is already a valid ScreenType — just accept it. */
  function pickScreenType(v: unknown): void {
    pendingAddScreenType = (v as ScreenType | null) ?? null;
  }

  function pickDefaultFilter(v: unknown): void {
    if (Array.isArray(v)) return;
    if (v === null || v === '') {
      void setScreenDefaultFilter(null);
      return;
    }
    if (typeof v !== 'string') return;
    try {
      void setScreenDefaultFilter(BigInt(v));
    } catch {
      /* ignore unparseable */
    }
  }

  /* ------------------------------------------------------ keyboard glue */

  async function focusSearch(): Promise<void> {
    await tick();
    searchEl?.focus();
    searchEl?.select();
  }

  function moveSelection(delta: number): void {
    const list = filteredProjects;
    if (list.length === 0) return;
    const cur = list.findIndex((p) => p.id === selectedProjectId);
    let next = cur + delta;
    if (cur === -1) next = delta > 0 ? 0 : list.length - 1;
    if (next < 0) next = 0;
    if (next > list.length - 1) next = list.length - 1;
    const target = list[next];
    if (target !== undefined) selectedProjectId = target.id;
  }

  useShortcut('admin_screens', '/', () => void focusSearch(), 'Focus search', {
    fireInInputs: false,
  });
  useShortcut('admin_screens', 'j', () => moveSelection(+1), 'Next project', {
    fireInInputs: false,
  });
  useShortcut('admin_screens', 'k', () => moveSelection(-1), 'Previous project', {
    fireInInputs: false,
  });

  const qe = useQuickEntry({
    scope: 'admin_screens',
    defaultCardType: 'project',
    onCreated: (id) => {
      void loadProjects().then(() => {
        selectedProjectId = id;
      });
    },
  });

  onMount(() => {
    void loadProjects();
  });
</script>

<div class="flex h-full flex-col">
  <header class="flex items-center justify-between border-b border-border px-4 py-2">
    <h1 class="text-lg font-semibold">Admin · Screens</h1>
  </header>

  {#if loading && projects.length === 0}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <div
      role="alert"
      class="m-4 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load: {error}
      <button type="button" class="ml-3 underline" onclick={() => void loadProjects()}>
        Retry
      </button>
    </div>
  {:else}
    <div class="grid flex-1 min-h-0 grid-cols-[280px_1fr_360px]">
      <!-- LEFT -->
      <CardListPane
        ariaLabel="Project list"
        border="right"
        items={filteredProjects}
        emptyHint="No projects match."
      >
        {#snippet header()}
          <div class="flex flex-col gap-2 border-b border-border p-2">
            <input
              type="search"
              bind:this={searchEl}
              bind:value={search}
              placeholder="Search projects (press /)"
              aria-label="Search projects"
              class={cx(
                'w-full rounded-md border border-border bg-bg px-2 py-1 text-sm',
                'text-fg placeholder:text-muted',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
            />
            <button
              type="button"
              data-testid="new-project-button"
              class={cx(
                'inline-flex h-8 select-none items-center justify-center rounded-md',
                'bg-accent px-2 text-sm font-medium text-accent-fg',
                'transition-colors hover:opacity-90',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
              onclick={() => qe.open()}
            >
              + New project
            </button>
          </div>
        {/snippet}
        {#snippet row(p)}
          <button
            type="button"
            data-testid={`project-row-${p.id}`}
            class={cx(
              'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm',
              'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              p.id === selectedProjectId ? 'bg-surface' : '',
            )}
            onclick={() => (selectedProjectId = p.id)}
          >
            <span class="truncate font-medium text-fg">{readTitle(p)}</span>
          </button>
        {/snippet}
      </CardListPane>

      <!-- CENTER -->
      <CardListPane
        ariaLabel="Screens for project"
        items={selectedProject === null ? [] : sortedScreens}
        emptyHint={selectedProject === null
          ? 'Pick a project on the left.'
          : 'No screens for this project yet.'}
      >
        {#snippet header()}
          {#if selectedProject !== null}
            <h2 class="border-b border-border px-3 py-2 text-base font-semibold">
              {readTitle(selectedProject)}
            </h2>
          {/if}
        {/snippet}
        {#snippet row(s)}
          {@const screenType = readScreenType(s) ?? ''}
          {@const defaultId = readDefaultFilterID(s)}
          <div
            data-testid={`screen-row-${s.id}`}
            class={cx(
              'mx-3 my-1 flex items-center justify-between gap-2 rounded border border-border px-3 py-2',
              s.id === selectedScreenId ? 'bg-surface' : 'bg-bg',
            )}
          >
            <button
              type="button"
              class="flex flex-1 items-center gap-2 text-left"
              onclick={() => (selectedScreenId = s.id)}
            >
              <span class="font-medium text-fg">{readTitle(s)}</span>
              {#if screenType !== ''}
                <Chip label={screenType} size="sm" />
              {/if}
              {#if defaultId !== null}
                {@const def = filters.find((f) => f.id === defaultId)}
                <span class="text-xs text-muted">
                  Default: {def ? readTitle(def) : `#${defaultId}`}
                </span>
              {/if}
            </button>
            <IconButton
              aria-label={`Delete ${readTitle(s)} screen`}
              size="sm"
              variant="danger"
              onclick={() => void deleteScreen(s)}
            >
              {#snippet children()}🗑{/snippet}
            </IconButton>
          </div>
        {/snippet}
        {#snippet footer()}
          {#if selectedProject !== null && addableScreenTypes.length > 0}
            <div
              class="m-3 flex items-center gap-2 rounded border border-dashed border-border p-2"
              data-testid="add-screen-controls"
            >
              <span class="text-sm text-muted">+ Add screen:</span>
              <span class="w-44">
                <Combobox
                  aria-label="Screen type"
                  options={addScreenOptions}
                  value={pendingAddScreenType}
                  searchable={false}
                  placeholder="screen type…"
                  onchange={pickScreenType}
                />
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={pendingAddScreenType === null}
                onclick={() => void addScreen()}
              >
                {#snippet children()}Add{/snippet}
              </Button>
            </div>
          {/if}
        {/snippet}
      </CardListPane>

      <!-- RIGHT -->
      <CardListPane
        ariaLabel="Filters for screen"
        border="left"
        items={selectedScreen === null ? [] : sortedFilters}
        emptyHint={selectedScreen === null
          ? 'Pick a screen to manage its filters.'
          : 'No filters yet.'}
      >
        {#snippet header()}
          {#if selectedScreen !== null}
            {@const screenType = readScreenType(selectedScreen) ?? ''}
            <div class="flex items-center gap-2 border-b border-border px-3 py-2">
              <h3 class="text-sm font-semibold">{readTitle(selectedScreen)}</h3>
              {#if screenType !== ''}
                <Chip label={screenType} size="sm" />
              {/if}
            </div>
            <div class="flex items-center gap-2 border-b border-border px-3 py-2">
              <span class="text-xs text-muted">Default filter:</span>
              <span class="flex-1">
                <Combobox
                  aria-label="Default filter"
                  options={filterOptions}
                  value={currentDefaultFilterValue}
                  searchable={filterOptions.length > 8}
                  placeholder="(none)"
                  onchange={pickDefaultFilter}
                />
              </span>
            </div>
          {/if}
        {/snippet}
        {#snippet row(f)}
          {@const titleStr = readTitle(f)}
          {@const colAttr = readColumnAttr(f)}
          {@const laneAttr = readLaneAttr(f)}
          {@const isDefault =
            selectedScreen !== null && readDefaultFilterID(selectedScreen) === f.id}
          <div
            data-testid={`filter-row-${f.id}`}
            class="flex flex-col gap-1 border-b border-border px-3 py-2 text-sm"
          >
            <div class="flex items-center gap-2">
              <input
                type="text"
                value={titleStr}
                placeholder="Title"
                class="flex-1 rounded border border-transparent bg-bg px-1 py-0.5 text-sm hover:border-border focus:border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onblur={(e) => void renameFilter(f, (e.target as HTMLInputElement).value)}
                onkeydown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === 'Escape') {
                    (e.target as HTMLInputElement).value = titleStr;
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              {#if isDefault}
                <Chip label="default" size="sm" />
              {/if}
            </div>
            {#if colAttr !== null || laneAttr !== null}
              <div class="flex flex-wrap gap-1 pl-1">
                {#if colAttr !== null}
                  <span class="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted">
                    col: {colAttr}
                  </span>
                {/if}
                {#if laneAttr !== null}
                  <span class="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted">
                    lane: {laneAttr}
                  </span>
                {/if}
              </div>
            {/if}
            <div class="flex items-center gap-2 pl-1">
              <button
                type="button"
                class="rounded border border-border bg-bg px-2 py-0.5 text-xs text-fg hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onclick={() => void editFilterPredicate(f)}
              >Edit predicate</button>
              <IconButton
                aria-label={`Delete ${titleStr}`}
                size="sm"
                variant="danger"
                onclick={() => void deleteFilter(f)}
              >
                {#snippet children()}🗑{/snippet}
              </IconButton>
            </div>
          </div>
        {/snippet}
        {#snippet footer()}
          {#if selectedScreen !== null}
            <div class="border-t border-border p-2">
              <Button variant="secondary" size="sm" onclick={() => void addFilter()}>
                {#snippet children()}+ Add filter{/snippet}
              </Button>
            </div>
          {/if}
        {/snippet}
      </CardListPane>
    </div>
  {/if}
</div>

<QuickEntryOverlay {...qe.props} />

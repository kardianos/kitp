<script lang="ts">
  /**
   * Per-screen filter bar with saved-preset CRUD.
   *
   * Wraps the lower-level <FilterBar> + <FilterPresetSelector> pair and
   * owns every interaction with the data layer:
   *   - fetches the project's `screen` card + its `filter` children
   *   - applies the screen's `default_filter` on first visit
   *   - persists the active preset id + predicate across navigations
   *   - lets the user save / rename / delete presets and pick which
   *     one is the screen's default — all by writing the same `filter`
   *     and `screen` cards (no new endpoints)
   *   - exposes the currently-active filter CARD (not just its
   *     predicate) so screens with extra knobs — kanban's column /
   *     lane axes today, anything else tomorrow — can pull their own
   *     attributes off it without this component knowing what they
   *     are.
   *
   * Screens reduce to `<ScreenFilterBar screenSlug="…" projectId={…}
   * {filterAttributes} bind:predicate bind:activeFilter
   * extraAttributes={…} onchange={refresh} />`.
   */
  import { tick, untrack } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';

  import { type Dispatcher, stringifyBigInt } from '../dispatch/dispatcher';
  import {
    getActivePreset,
    getFilter,
    hasFilter,
    setActivePreset,
    setFilter,
  } from '../screens/filter_state.svelte';
  import {
    attributeUpdate,
    cardDelete,
    cardInsert,
  } from '../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardDeleteInput,
    CardDeleteOutput,
    CardInsertInput,
    CardInsertOutput,
    CardWithAttrs,
    ID,
  } from '../reg/types';
  import { notify } from '../ui/toast.svelte';
  import FilterBar from './FilterBar.svelte';
  import ExportMenu from './ExportMenu.svelte';
  import FilterPresetSelector from './FilterPresetSelector.svelte';
  import type { FilterAttribute } from './attribute_schema.svelte';
  import { predicateToJson, type Predicate } from './predicate';
  import {
    loadScreenAndFilters,
    readDefaultFilterID,
    readGroupByAttr,
    readPredicate,
    readTitle,
  } from './screen_preset.svelte';
  import {
    getCachedSnippets,
    getSelectedSnippetIds,
    loadSnippets,
    readSnippetTitle,
    setSelectedSnippets,
  } from './snippet_store.svelte';
  import Combobox from '../ui/Combobox.svelte';

  interface Props {
    /**
     * Slug of the active screen (the `:slug` segment in
     * `/project/:id/screen/:slug`). Identifies the screen card to
     * resolve presets against and doubles as the filter-state cache
     * scope key. Slug is the canonical identifier — multiple screens
     * can share a layout (Inbox / Ideas / Archive all use `list`) but
     * each carries a unique slug per project.
     */
    screenSlug: string;
    /** Active project. `null` (all-projects view) disables presets — no
     *  per-project screen card exists to load. */
    projectId: ID | null;
    dispatcher: Pick<Dispatcher, 'request'>;
    /** FilterBar palette. */
    filterAttributes: FilterAttribute[];
    /** Active filter predicate (two-way bound). */
    predicate: Predicate | null;
    /** Active filter CARD (two-way bound). Screens that need screen-
     *  specific knobs (e.g. kanban's column_attr, the universal
     *  group_by_attr) read them off this card via the accessors in
     *  screen_preset. */
    activeFilter?: CardWithAttrs | null;
    /** Resolved screen card for (project, slug) (two-way bound). Carries
     *  the screen-definition attributes (layout, tag_prefix_columns, ...)
     *  that screens need but that don't live on the filter preset. Null
     *  until the screen probe resolves (or when projectId === null). */
    screen?: CardWithAttrs | null;
    /** Screen-specific attributes to embed in the filter card on
     *  "+ Save filter" (e.g. Kanban passes {column_attr, group_by_attr}).
     *  Keys must match attribute_def names bound to `filter`. */
    extraAttributes?: Record<string, unknown>;
    /** Fired when the predicate or active preset changes; the screen
     *  usually re-issues its data fetch from this. */
    onchange?: (p: Predicate | null) => void;
    /**
     * Optional hook fired when the user presses ArrowDown / ArrowUp on
     * the text search input. Forwarded to FilterBar → TextSearchBar.
     * Screens wire this to "focus the first row of the visible list"
     * so the keyboard flow goes search → list without a hand off the
     * keyboard.
     */
    onNavigateOut?: (direction: 'down' | 'up') => void;
    /**
     * True once the default-filter probe has finished (whether or not a
     * default was applied) — or immediately when `projectId === null`,
     * which has no per-project screen card to load. Screens that fire a
     * data fetch off `predicate` gate the first call on this so they
     * don't issue an unfiltered request followed by a filtered one and
     * flash stale rows. Two-way bound.
     */
    filterReady?: boolean;
    /**
     * Trailing snippet forwarded into FilterBar's top row (right-aligned).
     * Screens pack their row-count + spinner here so the dedicated header
     * strip can go away.
     */
    trailing?: import('svelte').Snippet;
  }

  let {
    screenSlug,
    projectId,
    dispatcher,
    filterAttributes,
    predicate = $bindable(),
    activeFilter = $bindable(null),
    screen: screenBinding = $bindable(null),
    extraAttributes = {},
    onchange,
    onNavigateOut,
    filterReady = $bindable(false),
    trailing,
  }: Props = $props();

  let screenCard = $state<CardWithAttrs | null>(null);
  let presets = $state<CardWithAttrs[]>([]);
  let activeId = $state<ID | null>(null);

  /** Resolve `activeFilter` from `presets` + `activeId` for the parent
   *  to consume via bind:. A plain `$derived` (no effect) — the parent's
   *  `bind:activeFilter` reads it directly. The previous effect-into-
   *  bindable mirror (FE-C1) is gone: there's no body that writes the
   *  bindable, so nothing for a parent re-render to feed back into. */
  const resolvedActive = $derived<CardWithAttrs | null>(
    activeId === null ? null : (presets.find((f) => f.id === activeId) ?? null),
  );

  // Fan the two derived/state values out to the bindable props the
  // parent reads. Each statement reads ONLY a `$derived`/`$state` and
  // writes ONLY a bindable prop this component never reads back, so
  // there is no cycle (the FE-C1 hazard was effects that mirror into a
  // bindable the same component re-reads, plus loaders that wrote a
  // signal they tracked — both removed below). Parents only consume
  // `activeFilter`/`screen` via `bind:`, so this is a pure one-way
  // fan-out with no feedback path.
  $effect(() => {
    activeFilter = resolvedActive;
    screenBinding = screenCard;
  });

  /** True when the active preset is also the screen's default. Drives
   *  whether the "Set as default" action shows up. */
  const activeIsDefault = $derived<boolean>(
    screenCard !== null &&
      activeId !== null &&
      readDefaultFilterID(screenCard) === activeId,
  );

  /**
   * "What to load" is a pure `$derived` of the two primitive inputs —
   * the only thing that should re-trigger a preset reload. The loader
   * effect below tracks ONLY this key, never the filter cache it reads,
   * which is the structural break for the FE-C1 cycle: previously the
   * loader read `getFilter`/`hasFilter` (the same `$state` cache the
   * persist write touched), so a persist could re-fire the loader and
   * the whole thing was held together by blanket `untrack`. Now the
   * cache is read once per key change as an explicit snapshot.
   */
  const loadKey = $derived(`${screenSlug}\0${projectId ?? '_none_'}`);

  /**
   * Load presets whenever the (project, screen) key changes. On first
   * visit for that pair (no filter_state cache entry yet), apply the
   * data-side default filter; subsequent visits restore the user's last
   * choice. The all-projects view (projectId === null) clears the
   * preset list — there's no per-project screen card to load.
   *
   * Persistence is NOT done here as an effect anymore: predicate writes
   * are persisted at their source (the change handlers below), so this
   * loader is a clean one-way producer — it reads `loadKey` (primitive)
   * + a one-time cache snapshot and writes only local view state.
   */
  $effect(() => {
    // Tracked dep: the load key only. Everything inside the snapshot
    // block is read non-reactively so a later cache write (a user
    // editing the filter) can't re-fire this loader and stomp their
    // in-progress edits. This is the one legitimate snapshot `untrack`
    // the review sanctions — read once at key change, never a feedback
    // path.
    void loadKey;
    const pid = projectId;
    const st = screenSlug;
    untrack(() => {
      // Reset the ready flag whenever the (project, screen) pair flips
      // so screens re-gate their refetch through the new probe.
      filterReady = false;
      const wasFirstVisit = !hasFilter(st, pid);
      predicate = getFilter(st, pid);
      activeId = getActivePreset(st, pid);
      if (pid === null) {
        // All-projects view has no per-project screen card; nothing to
        // probe, so the gate is open immediately.
        screenCard = null;
        presets = [];
        filterReady = true;
        return;
      }
      void loadScreenAndFilters(dispatcher, pid, st)
        .then((set) => {
          // Guard against late resolves after the user navigated away.
          if (projectId !== pid || screenSlug !== st) return;
          screenCard = set.screen;
          presets = set.filters;
          if (wasFirstVisit) {
            // First-visit filter selection — pick in this order:
            //   1. The screen's explicit default_filter (if set).
            //   2. The first available preset (when no default exists
            //      but the screen has *any* filter card). This is the
            //      common shape for screens created via the demo seed
            //      or admin UI before the admin has explicitly picked a
            //      default — without this, activeFilter stays null and
            //      layouts can't read attrs like group_by_attr or sort
            //      off the filter card the user has clearly intended
            //      to use.
            //   3. Fall back to a seeded `status notTerminal` predicate
            //      when the screen has zero filter cards at all.
            const chosen = set.defaultFilter ?? set.filters[0] ?? null;
            if (chosen !== null) {
              predicate = readPredicate(chosen);
              activeId = chosen.id;
              setFilter(st, pid, predicate);
              setActivePreset(st, pid, activeId);
              onchange?.(predicate);
            } else {
              // No filter cards at all → hide terminal-phase statuses
              // by default so the user lands on a useful view (matches
              // the FilterBar pill's "Show closed status" off state).
              // The pill flips the leaf on/off; we just seed the leaf
              // so the screen's first paint isn't drowned in Done /
              // Cancelled rows.
              const seeded: Predicate = {
                kind: 'leaf',
                attr: 'status',
                op: 'notTerminal',
              };
              predicate = seeded;
              setFilter(st, pid, seeded);
              onchange?.(seeded);
            }
          }
          // Open the gate. Screens that gated their first refresh on
          // filterReady will now fire with the correct predicate.
          filterReady = true;
        })
        .catch(() => {
          // The dispatcher fault registry has already surfaced the error
          // (toast / /login redirect). All that matters here is the gate
          // does not stay shut and strand the parent screen on its
          // spinner — open it with no presets so the user sees the
          // empty / fresh state and can retry from there.
          if (projectId !== pid || screenSlug !== st) return;
          screenCard = null;
          presets = [];
          filterReady = true;
        });
    });
  });

  /* ---------------------------------------------- named snippets ---------- */

  /** "What snippets to load" — a primitive key the loader effect tracks
   *  in place of reactively reading inside `loadSnippets`. */
  const snippetKey = $derived(projectId);

  /** Load (or rehydrate from cache) the project's snippet cards
   *  whenever the project flips. Errors fall through silently — the
   *  dispatcher's fault registry surfaces them — and the dropdown
   *  just stays empty. Tracks only the primitive `snippetKey`, so no
   *  `untrack` is needed: `loadSnippets` writes a shared cache this
   *  effect never reads. */
  $effect(() => {
    const pid = snippetKey;
    if (pid === null) return;
    void loadSnippets(dispatcher, pid).catch(() => {});
  });

  /** Snippets visible to this screen. Reactive: reads the shared
   *  rune-state cache so a save / delete in another component refreshes
   *  this list automatically. */
  const snippets = $derived(getCachedSnippets(projectId));

  /** Options for the multi-select Combobox. */
  const snippetOptions = $derived(
    snippets.map((s) => ({ value: s.id, label: readSnippetTitle(s) })),
  );

  /** Currently-checked snippet ids, derived from the predicate's
   *  top-level snippet leaves. */
  const selectedSnippetIds = $derived(getSelectedSnippetIds(predicate));

  /** User toggled the multi-select. Replace the top-level snippet
   *  leaves with the new set; persist + emit. */
  function onSnippetsChange(v: ID | ID[] | null): void {
    const ids = Array.isArray(v) ? v : [];
    predicate = setSelectedSnippets(predicate, ids);
    setFilter(screenSlug, projectId, predicate);
    onchange?.(predicate);
  }

  function onPresetPick(id: ID | null): void {
    activeId = id;
    setActivePreset(screenSlug, projectId, id);
    if (id === null) return;
    const f = presets.find((x) => x.id === id);
    if (f === undefined) return;
    predicate = readPredicate(f);
    setFilter(screenSlug, projectId, predicate);
    onchange?.(predicate);
  }

  function onFilterChange(p: Predicate | null): void {
    // The user edited the predicate by hand. The active preset is
    // still the one they're working *from* — its sort, group_by_attr,
    // column_attr, etc. are independent of the predicate and should
    // keep applying. We only flag the predicate as dirty (callers can
    // surface "modified" via `activeIsDirty` if they want); activeId
    // stays put so layouts that read attributes off `activeFilter`
    // (Grid's group headers, Kanban's column axis) don't lose their
    // configuration the moment the user touches a filter chip.
    //
    // Persistence happens here (at the predicate's source) rather than
    // in a tracking `$effect` — that effect read `predicate` and wrote
    // the same `$state` cache the loader read, the FE-C1 cycle. Writing
    // it explicitly on the one event that mutates the predicate keeps
    // the cache one-way.
    setFilter(screenSlug, projectId, p);
    onchange?.(p);
  }

  /* -------------------------------------------------------------- CRUD --- */

  /** Refetch the screen + its filter children. Used after every write. */
  async function reload(): Promise<void> {
    const pid = projectId;
    if (pid === null) return;
    const set = await loadScreenAndFilters(dispatcher, pid, screenSlug);
    if (projectId !== pid) return;
    screenCard = set.screen;
    presets = set.filters;
  }

  /** Save the current predicate + extraAttributes as a new filter card
   *  under the screen. We use window.prompt for now — a styled dialog
   *  is polish that can ride on top of the same call. */
  async function saveAsNew(): Promise<void> {
    if (screenCard === null) {
      notify({ type: 'error', message: 'No screen loaded; pick a project first.' });
      return;
    }
    const title = window.prompt('Save current filter as:', '');
    if (title === null) return;
    const trimmed = title.trim();
    if (trimmed === '') return;

    const attrs: Record<string, unknown> = {};
    if (predicate !== null) {
      // Predicate leaves may carry bigint card-ref values (assignee /
      // milestone_ref / component_ref / tags); plain JSON.stringify
      // throws on those, so route through the dispatcher's BigInt-aware
      // helper. The server reads `predicate` back as a JSON string.
      attrs.predicate = stringifyBigInt(predicateToJson(predicate));
    }
    for (const [k, v] of Object.entries(extraAttributes)) {
      if (v !== undefined && v !== null) attrs[k] = v;
    }
    try {
      const out = await dispatcher.request<CardInsertInput, CardInsertOutput>({
        endpoint: cardInsert.endpoint,
        action: cardInsert.action,
        data: {
          cardTypeName: 'filter',
          parentCardId: screenCard.id,
          title: trimmed,
          attributes: attrs,
        },
      });
      await reload();
      // Switch to the new preset so the user sees their save took.
      onPresetPick(out.id);
      notify({ type: 'success', message: `Saved "${trimmed}"` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Save failed: ${msg}` });
    }
  }

  async function renameActive(): Promise<void> {
    const f = resolvedActive;
    if (f === null) return;
    const next = window.prompt('Rename filter:', readTitle(f));
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === readTitle(f)) return;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: { cardId: f.id, attributeName: 'title', value: trimmed },
      });
      await reload();
      notify({ type: 'success', message: 'Renamed' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Rename failed: ${msg}` });
    }
  }

  async function deleteActive(): Promise<void> {
    const f = resolvedActive;
    if (f === null) return;
    if (!window.confirm(`Delete filter "${readTitle(f)}"?`)) return;
    try {
      const out = await dispatcher.request<CardDeleteInput, CardDeleteOutput>({
        endpoint: cardDelete.endpoint,
        action: cardDelete.action,
        data: { cardId: f.id },
      });
      if (!out.ok) {
        notify({ type: 'error', message: 'Delete refused.' });
        return;
      }
      // Drop the active preset and re-apply whatever the new default is.
      activeId = null;
      setActivePreset(screenSlug, projectId, null);
      await reload();
      notify({ type: 'success', message: 'Deleted' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Delete failed: ${msg}` });
    }
  }

  /** Options for the in-screen Group-by combobox. Built from the
   *  caller-supplied filter palette so it matches the per-screen
   *  task-relevant attribute set (no comm/imap/smtp noise). Multi-
   *  valued refs (tags) ARE included: the renderer expands such a row
   *  to one entry per element, so a task with multiple tags lands
   *  under every matching bucket. */
  const groupByOptions = $derived<{ value: string; label: string }[]>([
    { value: '', label: '(no grouping)' },
    ...filterAttributes.map((a) => ({ value: a.name, label: a.label })),
  ]);

  /** Current group_by_attr on the active filter, or '' for none. */
  const currentGroupBy = $derived<string>(
    resolvedActive === null ? '' : (readGroupByAttr(resolvedActive) ?? ''),
  );


  /**
   * Persist a new group_by_attr value onto the active filter card and
   * reload the preset list so the parent's `activeFilter` binding picks
   * up the change reactively. No-op when no filter is active (the
   * combobox itself is hidden in that case).
   */
  async function setGroupBy(value: string): Promise<void> {
    if (resolvedActive === null) return;
    const next = value === '' ? null : value;
    // Idempotent: skip the round-trip when the active filter already
    // carries this value. Combobox can fire onchange a second time
    // when its value prop re-syncs from the parent after the round
    // trip completes; without this guard we'd double-write and
    // double-reload for one user click.
    const current = readGroupByAttr(resolvedActive);
    if ((current ?? null) === next) return;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: {
          cardId: resolvedActive.id,
          attributeName: 'group_by_attr',
          value: next,
        },
      });
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Group-by update failed: ${msg}` });
    }
  }

  async function setActiveAsDefault(): Promise<void> {
    if (screenCard === null || activeId === null) return;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: {
          cardId: screenCard.id,
          attributeName: 'default_filter',
          value: activeId,
        },
      });
      await reload();
      notify({ type: 'success', message: 'Set as default' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Update failed: ${msg}` });
    }
  }

  /* ------------------------------------------------------ actions menu --- */
  /* The save / rename / delete / set-default actions used to render as a    */
  /* row of buttons. They've been folded into a single kebab popover so the  */
  /* filter row stays compact regardless of how many actions apply.          */

  let menuOpen = $state(false);
  let menuTrigger: HTMLButtonElement | null = $state(null);
  let menuPopup: HTMLDivElement | null = $state(null);
  let menuCleanup: (() => void) | null = null;

  async function openMenu(): Promise<void> {
    menuOpen = true;
    await tick();
    if (!menuTrigger || !menuPopup) return;
    menuCleanup?.();
    menuCleanup = autoUpdate(menuTrigger, menuPopup, () => {
      if (!menuTrigger || !menuPopup) return;
      void computePosition(menuTrigger, menuPopup, {
        placement: 'bottom-end',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!menuPopup) return;
        Object.assign(menuPopup.style, {
          left: `${x}px`,
          top: `${y}px`,
          opacity: '1',
          pointerEvents: 'auto',
        });
      });
    });
  }

  function closeMenu(): void {
    menuOpen = false;
    menuCleanup?.();
    menuCleanup = null;
  }

  function onMenuDocPointerDown(e: PointerEvent): void {
    if (!menuOpen) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (menuPopup?.contains(t)) return;
    if (menuTrigger?.contains(t)) return;
    closeMenu();
  }

  $effect(() => {
    if (menuOpen) {
      document.addEventListener('pointerdown', onMenuDocPointerDown, true);
      return () => {
        document.removeEventListener(
          'pointerdown',
          onMenuDocPointerDown,
          true,
        );
      };
    }
    return undefined;
  });

  $effect(() => {
    return () => {
      menuCleanup?.();
    };
  });
</script>

<div class="flex flex-col gap-2">
  <FilterBar
    attributes={filterAttributes}
    {snippets}
    bind:predicate
    onchange={onFilterChange}
    {...(onNavigateOut !== undefined ? { onNavigateOut } : {})}
    {...(trailing !== undefined ? { trailing } : {})}
  >
    {#snippet leading()}
      {#if projectId !== null}
        <ExportMenu {projectId} {predicate} />
        <FilterPresetSelector
          filters={presets}
          activeId={activeId}
          onchange={onPresetPick}
        />
        {#if snippetOptions.length > 0}
          <span
            class="inline-flex items-center gap-1.5 text-xs text-muted"
            data-testid="screen-named-filters"
          >
            <span class="uppercase tracking-wide">Named</span>
            <span class="inline-block min-w-[10rem]">
              <Combobox
                aria-label="Named filters"
                multiple
                options={snippetOptions}
                value={selectedSnippetIds}
                searchable={snippetOptions.length > 8}
                placeholder="(none)"
                onchange={onSnippetsChange}
              />
            </span>
          </span>
        {/if}
        {#if resolvedActive !== null}
          <span
            class="inline-flex items-center gap-1.5 text-xs text-muted"
            data-testid="screen-groupby"
          >
            <span class="uppercase tracking-wide">Group</span>
            <span class="inline-block min-w-[8rem]">
              <Combobox
                aria-label="Group rows by attribute"
                options={groupByOptions}
                value={currentGroupBy}
                searchable={groupByOptions.length > 8}
                placeholder="(no grouping)"
                onchange={(v) => {
                  if (typeof v === 'string') void setGroupBy(v);
                }}
              />
            </span>
          </span>
        {/if}
        <div class="relative inline-block">
          <button
            bind:this={menuTrigger}
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-bg text-muted hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="View actions"
            title="View actions"
            data-testid="view-actions-trigger"
            onclick={() => (menuOpen ? closeMenu() : void openMenu())}
          >
            <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true">
              <circle cx="6" cy="2" r="1" fill="currentColor" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
              <circle cx="6" cy="10" r="1" fill="currentColor" />
            </svg>
          </button>

          {#if menuOpen}
            <div
              bind:this={menuPopup}
              role="menu"
              class="kf-float-anchor-fade z-50 flex w-48 flex-col overflow-hidden rounded-md border border-border bg-bg py-1 text-sm shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                class="px-3 py-1.5 text-left text-fg hover:bg-surface focus:outline-none focus-visible:bg-surface"
                onclick={() => {
                  closeMenu();
                  void saveAsNew();
                }}
              >Save current as new view…</button>
              {#if activeId !== null}
                <button
                  type="button"
                  role="menuitem"
                  class="px-3 py-1.5 text-left text-fg hover:bg-surface focus:outline-none focus-visible:bg-surface"
                  onclick={() => {
                    closeMenu();
                    void renameActive();
                  }}
                >Rename view…</button>
                {#if !activeIsDefault}
                  <button
                    type="button"
                    role="menuitem"
                    class="px-3 py-1.5 text-left text-fg hover:bg-surface focus:outline-none focus-visible:bg-surface"
                    onclick={() => {
                      closeMenu();
                      void setActiveAsDefault();
                    }}
                  >Set as default</button>
                {/if}
                <div class="my-1 border-t border-border"></div>
                <button
                  type="button"
                  role="menuitem"
                  class="px-3 py-1.5 text-left text-danger hover:bg-surface focus:outline-none focus-visible:bg-surface"
                  onclick={() => {
                    closeMenu();
                    void deleteActive();
                  }}
                >Delete view…</button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/snippet}
  </FilterBar>
</div>

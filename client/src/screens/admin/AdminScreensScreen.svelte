<!--
  AdminScreensScreen — admin-only CRUD over `screen` + `filter` cards
  for the project pinned by the title-bar `<ProjectTitlePicker>`.

  Complements <ScreenFilterBar>'s in-screen preset CRUD by surfacing every
  project's screen/filter cards in one place. Both surfaces hit the same
  handlers so the data layer stays the single source of truth.

  Layout: 2 panes (the project selector lives in the title-bar picker).
    CENTER:  screens for the selected project, sorted by sort_order
             then id. Each row has inline editors for title / slug /
             hotkey / layout / flow plus a "+ Add screen" combobox at
             the foot.
    RIGHT:   filters under the selected screen + "Default filter:"
             combobox writing `default_filter` on the screen card.

  Wire surface (no new endpoints):
    - card.select_with_attributes  (screen / filter)
    - card.insert + card.delete    (screen / filter)
    - attribute.update             (title / slug / hotkey / layout /
                                    flow_ref / predicate / default_filter)
-->
<script lang="ts">
  import { getDispatcher } from '../../dispatch/context';
  import { stringifyBigInt } from '../../dispatch/dispatcher';
  import { BatchAbortedError, SubRequestError } from '../../dispatch/errors';
  import {
    sharedSchemaCache,
    type FilterAttribute,
  } from '../../filter/attribute_schema.svelte';
  import FilterTreeEditor from '../../filter/FilterTreeEditor.svelte';
  import { predicateToJson, type Predicate } from '../../filter/predicate';
  import { buildTaskFilterPalette } from '../../filter/task_palette';
  import {
    LAYOUTS,
    readColumnAttr,
    readDefaultFilterID,
    readFlowRef,
    readHotkey,
    readLaneAttr,
    readLayout,
    readPredicate,
    readSlug,
    readTitle,
    type Layout,
  } from '../../filter/screen_preset.svelte';
  import { setActiveScope } from '../../keys/shortcut';
  import { projectScope } from '../../shell/project_scope.svelte';
  import { projectsStore, watchProjects } from '../../shell/projects_store.svelte';
  import {
    attributeUpdate,
    cardDelete,
    cardInsert,
    cardSelectWithAttributes,
  } from '../../reg/handlers';
  import { flowList } from '../../reg/handlers_admin';
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
    FlowListInput,
    FlowListOutput,
    FlowRow,
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
    sortBySortOrder,
    uniqueSlug,
    validatePredicateJson,
    validateScreenHotkey,
    validateScreenSlug,
  } from './admin_screens_helpers';
  import CardListPane from './CardListPane.svelte';

  setActiveScope('admin_screens');

  const dispatcher = getDispatcher();
  const schemaCache = sharedSchemaCache(dispatcher);
  // The title-bar `ProjectTitlePicker` is the canonical project picker;
  // the LEFT pane on this screen mirrors `projectScope` so the two stay
  // in sync (clicking a row here pins the same scope the breadcrumb
  // exposes). Keep the shared cache warm in case the admin lands on
  // /admin/screens directly.
  $effect(watchProjects(dispatcher));

  /* ----------------------------------------------------------------- state */

  let screens = $state<CardWithAttrs[]>([]);
  let filters = $state<CardWithAttrs[]>([]);
  /** Flows available for the selected project. Drives the per-row "Flow"
   *  combobox; loaded by `loadFlowsFor` on every project switch. */
  let flows = $state<FlowRow[]>([]);
  /**
   * `selectedProjectId` is a $derived view of the global scope — the
   * title-bar `ProjectTitlePicker` is the sole project picker on this
   * screen, so anything reading "the selected project" pulls straight
   * from `projectScope` instead of carrying a parallel `$state`.
   */
  const selectedProjectId = $derived<ID | null>(projectScope.projectId);
  /** Shared project cache. Used for title lookups; the picker drives
   *  selection. */
  const projects = $derived(projectsStore.projects);
  let selectedScreenId = $state<ID | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let pendingAddLayout = $state<Layout | null>(null);

  /* ----- Visual predicate editor ---------------------------------------- */

  /**
   * Filter card currently being edited in the visual tree builder. `null`
   * when the modal is closed. We keep the card (not just its id) so the
   * modal can re-seed from `readPredicate(...)` without a second lookup.
   */
  let visualEditorFilter = $state<CardWithAttrs | null>(null);
  /** Modal open/close — Modal binds to it; we also flip it in onSave. */
  let visualEditorOpen = $state(false);
  /** True while the supporting card lists are in flight. */
  let paletteLoading = $state(false);

  /**
   * Supporting card lists for the palette. Reused across modal opens
   * within the same project; cleared on project switch via the effect
   * below. The dispatcher batches concurrent requests, so the modal's
   * one-shot fetch hits the server as a single HTTP round-trip.
   */
  let palettePersons = $state<CardWithAttrs[]>([]);
  let paletteMilestones = $state<CardWithAttrs[]>([]);
  let paletteComponents = $state<CardWithAttrs[]>([]);
  let paletteTags = $state<CardWithAttrs[]>([]);
  let paletteStatuses = $state<CardWithAttrs[]>([]);
  /** Track which project the palette inputs were loaded for so a switch
   *  invalidates the cache rather than showing stale options. */
  let paletteLoadedForProject = $state<ID | null>(null);

  /* ------------------------------------------------------------ derivations */

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

  /**
   * Always offer every layout — a project may want multiple screens of
   * the same layout (e.g. a primary inbox plus a comms list). The slug
   * is auto-disambiguated on insert so the ScreenHost resolver still
   * has a unique key.
   */
  const addScreenOptions = $derived.by(() =>
    LAYOUTS.map((t) => ({ value: t, label: friendlyScreenLabel(t) })),
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

  /** Layout combobox options shared by every row's "Layout" picker. */
  const layoutOptions = $derived.by(() =>
    LAYOUTS.map((t) => ({ value: t, label: friendlyScreenLabel(t) })),
  );

  /** Flow combobox options for the row pickers. An empty-string sentinel
   *  represents "no flow"; otherwise the bigint flow id stringified. */
  const flowOptions = $derived.by(() => [
    { value: '', label: '(none)' },
    ...flows.map((f) => ({ value: f.id.toString(), label: f.name })),
  ]);

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

  /**
   * The shared `projectsStore` drives the LEFT pane list. Track its
   * `loaded` flag through `loading` so the existing spinner / retry
   * affordances keep working without a parallel fetch.
   */
  $effect(() => {
    if (projectsStore.loaded) {
      loading = false;
      error = null;
    }
  });

  /** Re-trigger a fetch by bumping the projects version; the
   *  watchProjects effect re-loads. Used by the error-retry button. */
  function retryProjects(): void {
    loading = true;
    error = null;
    projectScope.notifyProjectsChanged();
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

  /**
   * Fetch the option lists feeding the visual filter builder (persons,
   * milestones, components, tags, statuses) plus the schema cache. We
   * fire them in parallel; the dispatcher folds them into one batch.
   * Idempotent per project: re-opening the modal on the same project
   * does not re-fetch.
   */
  async function loadPaletteFor(projectId: ID): Promise<void> {
    if (paletteLoadedForProject === projectId && !paletteLoading) return;
    paletteLoading = true;
    try {
      // Persons are global (not scoped to a project); the per-project
      // value-card lists hang one level under the project card.
      const personData: CardSelectWithAttributesInput = { cardTypeName: 'person' };
      const milestoneData: CardSelectWithAttributesInput = {
        cardTypeName: 'milestone',
        parentCardId: projectId,
      };
      const componentData: CardSelectWithAttributesInput = {
        cardTypeName: 'component',
        parentCardId: projectId,
      };
      const tagData: CardSelectWithAttributesInput = {
        cardTypeName: 'tag',
        parentCardId: projectId,
      };
      const statusData: CardSelectWithAttributesInput = {
        cardTypeName: 'status',
        parentCardId: projectId,
      };
      const req = (
        d: CardSelectWithAttributesInput,
      ): Promise<CardSelectWithAttributesOutput> =>
        dispatcher.request<
          CardSelectWithAttributesInput,
          CardSelectWithAttributesOutput
        >({
          endpoint: cardSelectWithAttributes.endpoint,
          action: cardSelectWithAttributes.action,
          data: d,
        });
      // Fire schemaCache.load() alongside the card fetches so the batch
      // dispatcher folds the attribute_def.select call into the same
      // round-trip. Its result is void; we keep the promise out of the
      // destructure.
      const schemaLoad = schemaCache.load();
      const [pOut, mOut, cOut, tOut, sOut] = await Promise.all([
        req(personData),
        req(milestoneData),
        req(componentData),
        req(tagData),
        req(statusData),
      ]);
      await schemaLoad;
      if (selectedProjectId !== projectId) return;
      palettePersons = pOut.rows;
      paletteMilestones = mOut.rows;
      paletteComponents = cOut.rows;
      paletteTags = tOut.rows;
      paletteStatuses = sOut.rows;
      paletteLoadedForProject = projectId;
    } catch (e) {
      notify({ type: 'error', message: `Load filter options failed: ${errMsg(e)}` });
    } finally {
      paletteLoading = false;
    }
  }

  /**
   * Load flows scoped to the picked project so the per-row Flow picker
   * resolves the screen's `flow_ref` to a name. AdminFlowsScreen owns
   * mutations; this screen reads only.
   */
  async function loadFlowsFor(projectId: ID): Promise<void> {
    try {
      const out = await dispatcher.request<FlowListInput, FlowListOutput>({
        endpoint: flowList.endpoint,
        action: flowList.action,
        data: { scopeCardId: projectId },
      });
      if (selectedProjectId !== projectId) return;
      flows = out.rows;
    } catch (e) {
      notify({ type: 'error', message: `Load flows failed: ${errMsg(e)}` });
    }
  }

  // Reload screens + flows when the project selection flips. Flows are
  // independent of the screen pick — we only need to refresh them on
  // project switch. Palette inputs are reloaded lazily on visual-editor
  // open; we invalidate them here so the next open re-fetches.
  $effect(() => {
    const pid = selectedProjectId;
    if (pid === null) {
      screens = [];
      selectedScreenId = null;
      filters = [];
      flows = [];
      paletteLoadedForProject = null;
      return;
    }
    void loadScreensFor(pid);
    void loadFlowsFor(pid);
    paletteLoadedForProject = null;
  });

  /**
   * Build the FilterAttribute palette from the loaded value-card lists.
   * Returns an empty array until the schema cache has loaded; the
   * `loadPaletteFor` await chain guarantees this is populated before the
   * modal opens.
   */
  const visualPalette = $derived<FilterAttribute[]>(
    buildTaskFilterPalette({
      schema: schemaCache,
      persons: palettePersons,
      milestones: paletteMilestones,
      components: paletteComponents,
      tags: paletteTags,
      statuses: paletteStatuses,
    }),
  );

  /** Predicate to seed the editor with on each open. */
  const visualEditorPredicate = $derived<Predicate | null>(
    visualEditorFilter === null ? null : readPredicate(visualEditorFilter),
  );

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
    const layout = pendingAddLayout;
    if (project === null || layout === null) return;
    const title = friendlyScreenLabel(layout);
    // Collect taken slugs (skip nulls) so a second `grid` screen lands
    // as `grid-2` instead of shadowing the first. The user can rename
    // immediately from the row's slug input.
    const taken = new Set<string>();
    for (const s of screens) {
      const sl = readSlug(s);
      if (sl !== null) taken.add(sl);
    }
    const slug = uniqueSlug(layout, taken);
    await insertCard(
      'screen',
      project.id,
      title,
      { layout, slug, sort_order: screens.length + 1 },
      async () => {
        pendingAddLayout = null;
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

  /**
   * Row-level field editors. Each persists via `attribute.update` and
   * refreshes the screens list so derived state (chord registrations
   * from AppShell, breadcrumb resolution, etc.) sees the new value on
   * the next render.
   */
  async function renameScreen(s: CardWithAttrs, nextTitle: string): Promise<void> {
    const trimmed = nextTitle.trim();
    if (trimmed === '' || trimmed === readTitle(s)) return;
    const project = selectedProject;
    if (project === null) return;
    await updateAttr(
      s.id,
      'title',
      trimmed,
      () => loadScreensFor(project.id),
      'Rename failed',
    );
  }

  async function updateScreenSlug(s: CardWithAttrs, nextSlug: string): Promise<void> {
    const trimmed = nextSlug.trim();
    if (trimmed === '' || trimmed === (readSlug(s) ?? '')) return;
    const v = validateScreenSlug(trimmed);
    if (!v.ok) {
      notify({ type: 'error', message: v.error });
      return;
    }
    const project = selectedProject;
    if (project === null) return;
    await updateAttr(
      s.id,
      'slug',
      trimmed,
      () => loadScreensFor(project.id),
      'Slug update failed',
    );
  }

  async function updateScreenHotkey(s: CardWithAttrs, nextHotkey: string): Promise<void> {
    const trimmed = nextHotkey.trim();
    const cur = readHotkey(s) ?? '';
    if (trimmed === cur) return;
    const v = validateScreenHotkey(trimmed);
    if (!v.ok) {
      notify({ type: 'error', message: v.error });
      return;
    }
    const project = selectedProject;
    if (project === null) return;
    // The server normalises "" away on write — null clears the chord.
    const value = trimmed === '' ? null : trimmed;
    await updateAttr(
      s.id,
      'hotkey',
      value,
      () => loadScreensFor(project.id),
      'Hotkey update failed',
    );
  }

  async function updateScreenLayout(s: CardWithAttrs, layout: Layout): Promise<void> {
    if (readLayout(s) === layout) return;
    const project = selectedProject;
    if (project === null) return;
    await updateAttr(
      s.id,
      'layout',
      layout,
      () => loadScreensFor(project.id),
      'Layout update failed',
    );
  }

  async function updateScreenFlow(
    s: CardWithAttrs,
    nextFlowId: ID | null,
  ): Promise<void> {
    if (readFlowRef(s) === nextFlowId) return;
    const project = selectedProject;
    if (project === null) return;
    // flow_ref's value_type is `number`; the write CTE only
    // canonicalises card_ref shapes, so a bigint here would land in
    // attribute_value as the JSON string `"123"` (dispatcher convention)
    // and projectstamp's `(value)::text::bigint` remap would break on
    // the next clone. Send it as a plain JS number so the JSONB shape
    // matches the seeded rows. Flow ids comfortably fit in Number.
    const value = nextFlowId === null ? null : Number(nextFlowId);
    await updateAttr(
      s.id,
      'flow_ref',
      value,
      () => loadScreensFor(project.id),
      'Flow update failed',
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

  /**
   * Open the visual filter builder for `f`. We lazy-load the palette
   * inputs (persons / milestones / components / tags / statuses + the
   * schema cache) for the selected project before flipping the modal
   * open so the editor renders with a populated attribute list rather
   * than the placeholder leaf you'd get from an empty palette.
   */
  async function openVisualEditor(f: CardWithAttrs): Promise<void> {
    const project = selectedProject;
    if (project === null) return;
    await loadPaletteFor(project.id);
    if (selectedProject !== project) return; // user switched mid-load
    visualEditorFilter = f;
    visualEditorOpen = true;
  }

  /**
   * Persist the predicate produced by FilterTreeEditor. Same wire path
   * as the JSON prompt: write the `predicate` attribute as a JSON-
   * encoded string (bigint-aware via `stringifyBigInt`) so card-ref
   * leaves round-trip cleanly.
   */
  async function saveVisualPredicate(p: Predicate | null): Promise<void> {
    const f = visualEditorFilter;
    if (f === null) return;
    visualEditorOpen = false;
    const value = p === null ? null : stringifyBigInt(predicateToJson(p));
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
    visualEditorFilter = null;
  }

  function cancelVisualEditor(): void {
    visualEditorOpen = false;
    visualEditorFilter = null;
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

  /** Combobox options are built from LAYOUTS, so anything the user
   *  picks is already a valid Layout — just accept it. */
  function pickLayout(v: unknown): void {
    pendingAddLayout = (v as Layout | null) ?? null;
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

  /** Combobox -> updateScreenLayout. LAYOUTS is closed so we cast safely. */
  function pickRowLayout(s: CardWithAttrs, v: unknown): void {
    if (typeof v !== 'string' || v === '') return;
    const t = v as Layout;
    if (!LAYOUTS.includes(t)) return;
    void updateScreenLayout(s, t);
  }

  /** Combobox -> updateScreenFlow. Empty string clears the binding. */
  function pickRowFlow(s: CardWithAttrs, v: unknown): void {
    if (Array.isArray(v)) return;
    if (v === null || v === '') {
      void updateScreenFlow(s, null);
      return;
    }
    if (typeof v !== 'string') return;
    try {
      void updateScreenFlow(s, BigInt(v));
    } catch {
      /* ignore unparseable */
    }
  }

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
      <button type="button" class="ml-3 underline" onclick={retryProjects}>
        Retry
      </button>
    </div>
  {:else if selectedProject === null}
    <!-- No project pinned. The title-bar picker is the only project
         picker on this screen; surface the affordance so admins don't
         hunt for it. -->
    <div class="flex flex-1 items-center justify-center p-6">
      <EmptyState
        title="Pick a project"
        description="Use the project picker in the breadcrumb above to choose which project's screens to manage."
      />
    </div>
  {:else}
    <div class="grid flex-1 min-h-0 grid-cols-[1fr_360px]">
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
          {@const titleStr = readTitle(s)}
          {@const slugStr = readSlug(s) ?? ''}
          {@const hotkeyStr = readHotkey(s) ?? ''}
          {@const layout = readLayout(s) ?? ''}
          {@const flowId = readFlowRef(s)}
          {@const defaultId = readDefaultFilterID(s)}
          <!-- onfocusin captures any focus inside the row (title, slug, etc.)
               so the right pane re-targets to the focused screen without
               needing a separate select gesture. -->
          <div
            data-testid={`screen-row-${s.id}`}
            class={cx(
              'mx-3 my-1 flex flex-col gap-2 rounded border border-border px-3 py-2',
              s.id === selectedScreenId ? 'bg-surface' : 'bg-bg',
            )}
            onfocusin={() => (selectedScreenId = s.id)}
          >
            <!-- Title row + delete -->
            <div class="flex items-center gap-2">
              <input
                type="text"
                value={titleStr}
                aria-label="Screen title"
                data-testid={`screen-title-${s.id}`}
                class="flex-1 rounded border border-transparent bg-bg px-1 py-0.5 text-sm font-medium text-fg hover:border-border focus:border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onblur={(e) =>
                  void renameScreen(s, (e.target as HTMLInputElement).value)}
                onkeydown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === 'Escape') {
                    (e.target as HTMLInputElement).value = titleStr;
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <IconButton
                aria-label={`Delete ${titleStr} screen`}
                size="sm"
                variant="danger"
                onclick={() => void deleteScreen(s)}
              >
                {#snippet children()}🗑{/snippet}
              </IconButton>
            </div>

            <!-- Slug + hotkey -->
            <div class="grid grid-cols-2 gap-2">
              <label class="flex flex-col gap-0.5 text-xs text-muted">
                <span>Slug</span>
                <input
                  type="text"
                  value={slugStr}
                  aria-label="Slug"
                  data-testid={`screen-slug-${s.id}`}
                  spellcheck="false"
                  class="rounded border border-border bg-bg px-1.5 py-0.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  onblur={(e) =>
                    void updateScreenSlug(s, (e.target as HTMLInputElement).value)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    else if (e.key === 'Escape') {
                      (e.target as HTMLInputElement).value = slugStr;
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
              </label>
              <label class="flex flex-col gap-0.5 text-xs text-muted">
                <span>Hotkey (g …)</span>
                <input
                  type="text"
                  value={hotkeyStr}
                  aria-label="Hotkey"
                  data-testid={`screen-hotkey-${s.id}`}
                  maxlength="1"
                  spellcheck="false"
                  class="w-16 rounded border border-border bg-bg px-1.5 py-0.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  onblur={(e) =>
                    void updateScreenHotkey(s, (e.target as HTMLInputElement).value)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    else if (e.key === 'Escape') {
                      (e.target as HTMLInputElement).value = hotkeyStr;
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
              </label>
            </div>

            <!-- Layout + flow -->
            <div class="grid grid-cols-2 gap-2">
              <label class="flex flex-col gap-0.5 text-xs text-muted">
                <span>Layout</span>
                <span data-testid={`screen-layout-${s.id}`}>
                  <Combobox
                    aria-label="Layout"
                    options={layoutOptions}
                    value={layout === '' ? null : layout}
                    searchable={false}
                    placeholder="layout…"
                    onchange={(v) => pickRowLayout(s, v)}
                  />
                </span>
              </label>
              <label class="flex flex-col gap-0.5 text-xs text-muted">
                <span>Flow</span>
                <span data-testid={`screen-flow-${s.id}`}>
                  <Combobox
                    aria-label="Flow"
                    options={flowOptions}
                    value={flowId === null ? '' : flowId.toString()}
                    searchable={flowOptions.length > 8}
                    placeholder="(none)"
                    onchange={(v) => pickRowFlow(s, v)}
                  />
                </span>
              </label>
            </div>

            {#if defaultId !== null}
              {@const def = filters.find((f) => f.id === defaultId)}
              <div class="text-xs text-muted">
                Default filter: {def ? readTitle(def) : `#${defaultId}`}
              </div>
            {/if}
          </div>
        {/snippet}
        {#snippet footer()}
          {#if selectedProject !== null}
            <div
              class="m-3 flex items-center gap-2 rounded border border-dashed border-border p-2"
              data-testid="add-screen-controls"
            >
              <span class="text-sm text-muted">+ Add screen:</span>
              <span class="w-44">
                <Combobox
                  aria-label="Layout"
                  options={addScreenOptions}
                  value={pendingAddLayout}
                  searchable={false}
                  placeholder="layout…"
                  onchange={pickLayout}
                />
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={pendingAddLayout === null}
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
            {@const layout = readLayout(selectedScreen) ?? ''}
            <div class="flex items-center gap-2 border-b border-border px-3 py-2">
              <h3 class="text-sm font-semibold">{readTitle(selectedScreen)}</h3>
              {#if layout !== ''}
                <Chip label={layout} size="sm" />
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
                class="rounded border border-border bg-bg px-2 py-0.5 text-xs text-fg hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                data-testid={`filter-visual-${f.id}`}
                disabled={paletteLoading}
                onclick={() => void openVisualEditor(f)}
              >Visual builder</button>
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

<!--
  Visual predicate builder. Mounted only while a filter is selected so
  FilterTreeEditor's open-edge effect always re-seeds from a fresh
  `predicate` (it seeds on the false→true flip). attributes come from
  the lazy-loaded palette — `openVisualEditor` awaits the fetch before
  flipping `open` so the editor never opens against an empty palette.
-->
{#if visualEditorFilter !== null}
  <FilterTreeEditor
    attributes={visualPalette}
    predicate={visualEditorPredicate}
    bind:open={visualEditorOpen}
    onSave={(p) => void saveVisualPredicate(p)}
    onCancel={cancelVisualEditor}
  />
{/if}

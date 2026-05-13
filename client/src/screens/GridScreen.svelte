<script lang="ts">
  /**
   * GridScreen — dense, sortable, filterable table over tasks.
   *
   * Dispatcher contract (one batch per gesture):
   *   1. card.select_with_attributes (tasks, with sort + tree predicate)
   *   2. card.select_with_attributes   (persons; assignee labels + filter)
   *   3. card.select_with_attributes    (milestones)
   *   4. card.select_with_attributes    (components)
   *   5. card.select_with_attributes    (tags)
   *   6. attribute_def.select           (filter schema; cached)
   *
   * Columns: ID, Title, Status, Assignee, Priority, Milestone, Component,
   * Tags, Created. Header click cycles sort (asc → desc → off); per-column
   * filter buttons open a Combobox / ValueInput for typed editing.
   *
   * Pure helpers (cycleSort / buildOrderClauses / applyFilterToTree) live
   * in `./grid_helpers.ts` so the vitest suite can exercise them under the
   * node-only runner.
   */

  import { getContext, tick, untrack } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';

  import type { AuthState } from '../auth/auth_state.svelte';
  import { getDispatcher } from '../dispatch/context.js';
  import {
    BatchAbortedError,
    SubRequestError,
  } from '../dispatch/errors.js';
  import ScreenFilterBar from '../filter/ScreenFilterBar.svelte';
  import {
    sharedSchemaCache,
    type FilterAttribute,
  } from '../filter/attribute_schema.svelte';
  import {
    buildTaskFilterPalette,
    resolveAttributeLabel,
  } from '../filter/task_palette';
  import {
    eq,
    in_,
    isFlatAndOfLeaves,
    type Predicate,
    type PredicateLeaf,
  } from '../filter/predicate.js';
  // `in_` is still used by the per-column filter commit path (multi-value
  // selections), but the Grid no longer ships with a default predicate.
  import { replaceLeafForAttr } from '../filter/quick_chips.js';
  import ValueInput from '../filter/ValueInput.svelte';
  import { setActiveScope, useShortcut } from '../keys/shortcut.js';
  import { projectScope } from '../shell/project_scope.svelte';
  import { useQuickEntry } from '../quick_entry/use_quick_entry.svelte.js';
  import QuickEntryOverlay from '../quick_entry/QuickEntryOverlay.svelte';
  import {
    cardSelectWithAttributes,
  } from '../reg/handlers.js';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
  } from '../reg/types.js';
  import { navigate } from '../routing/router.svelte.js';
  import { setTaskNavList } from '../routing/task_nav_list.svelte.js';
  import { getFilter } from './filter_state.svelte.js';
  import Button from '../ui/Button.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { notify } from '../ui/toast.svelte.js';
  import AttributeChip from '../ui/widgets/AttributeChip.svelte';
  import TagChip from '../ui/widgets/TagChip.svelte';
  import { cx } from '../util/class_names.js';

  import {
    applyFilterToTree,
    buildOrderClauses,
    cycleSort,
    type SortState,
  } from './grid_helpers.js';

  /* ------------------------------------------------------------------ props */

  interface Props {
    /** Optional project scope; null = grid spans every task in the system. */
    projectId?: ID;
    params?: Record<string, string>;
  }

  let { projectId, params = {} }: Props = $props();

  // Resolution order: explicit prop > `:id` route param > global project
  // scope picked from the sidebar. The global scope is the everyday case
  // (Inbox / Grid / Kanban share it); the prop / param paths cover deep
  // links like `/project/42/grid` that should ignore the sidebar choice.
  const scopedProjectId = $derived.by((): ID | undefined => {
    if (projectId !== undefined) return projectId;
    const v = params.id;
    if (typeof v === 'string' && v !== '') {
      try {
        return BigInt(v);
      } catch {
        /* fall through */
      }
    }
    return projectScope.projectId ?? undefined;
  });

  /* ----------------------------------------------------------------- columns */

  /**
   * Column descriptor. `field` is the wire `order.field` value (`null`
   * means non-sortable; today only Priority and Tags are non-sortable
   * because they are derived from the `tags` array).
   *
   * `attrName` is the matching `attribute_def.name`; we use it to look
   * up the per-column filter Combobox options. `null` means no filter
   * dropdown (ID, Created, Title etc).
   */
  interface ColumnDef {
    label: string;
    field: string | null;
    attrName: string | null;
    width: number;
  }

  const columns: ColumnDef[] = [
    { label: 'ID', field: null, attrName: null, width: 60 },
    { label: 'Title', field: 'attributes.title', attrName: null, width: 320 },
    {
      label: 'Assignee',
      field: 'attributes.assignee',
      attrName: 'assignee',
      width: 140,
    },
    { label: 'Priority', field: null, attrName: null, width: 110 },
    {
      label: 'Milestone',
      field: 'attributes.milestone_ref',
      attrName: 'milestone_ref',
      width: 130,
    },
    {
      label: 'Component',
      field: 'attributes.component_ref',
      attrName: 'component_ref',
      width: 130,
    },
    { label: 'Tags', field: null, attrName: null, width: 220 },
    { label: 'Created', field: 'created_at', attrName: null, width: 170 },
  ];

  const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
  const ROW_HEIGHT = 36;
  const PAGE_LIMIT = 200;

  /* ------------------------------------------------------------------ state */

  const dispatcher = getDispatcher();
  const authState = getContext<AuthState | undefined>('authState');
  const schemaCache = sharedSchemaCache(dispatcher);
  setActiveScope('grid');

  /**
   * Person-card id for the signed-in actor (assignee values are now
   * person-card ids, not user_account ids). Reads from OIDC `sub`; in the
   * demo seed user_account.id == person_card.id 1:1, so the cast works.
   * Fallback `2n` matches InboxScreen's `kCurrentUserId` for parity.
   */
  function parseMeId(): ID {
    const sub = authState?.claims?.sub;
    if (typeof sub === 'string' && sub.length > 0) {
      try {
        const n = BigInt(sub);
        if (n > 0n) return n;
      } catch {
        /* fall through */
      }
    }
    return 2n;
  }
  const meId = parseMeId();

  let rows = $state<CardWithAttrs[]>([]);
  let personRows = $state<CardWithAttrs[]>([]);
  let milestoneRows = $state<CardWithAttrs[]>([]);
  let componentRows = $state<CardWithAttrs[]>([]);
  let tagRows = $state<CardWithAttrs[]>([]);
  let statusRows = $state<CardWithAttrs[]>([]);

  /** Derived lookup tables fed to TaskRow / inline cells. */
  const personNames = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of personRows) {
      const t = p.attributes['title'];
      if (typeof t === 'string') out[p.id.toString()] = t;
    }
    return out;
  });
  const cardTitles = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of milestoneRows) {
      const t = r.attributes['title'] ?? r.attributes['name'];
      if (typeof t === 'string') out[r.id.toString()] = t;
    }
    for (const r of componentRows) {
      const t = r.attributes['title'] ?? r.attributes['name'];
      if (typeof t === 'string') out[r.id.toString()] = t;
    }
    return out;
  });
  const tagPaths = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of tagRows) {
      const p = r.attributes['path'];
      if (typeof p === 'string') out[r.id.toString()] = p;
    }
    return out;
  });
  let loading = $state(true);
  let loadingMore = $state(false);
  let exhausted = $state(false);
  let error = $state<string | null>(null);
  let sort = $state<SortState | null>(null);
  // Predicate starts from the persisted cache for this scope/project,
  // or null when there's nothing cached yet. On first visit we apply
  // the data-side default filter (see the effect below).
  let predicate = $state<Predicate | null>(
    untrack(() => getFilter('grid', projectScope.projectId)),
  );
  let selectedIndex = $state(0);
  let focusedColumn = $state<string | null>(null);

  let bodyEl: HTMLDivElement | null = $state(null);

  /* ------------------------------------------------------------ refresh fn */

  /**
   * Issue ONE batch with the active sort + predicate. Six sub-requests:
   * tasks + persons + milestones + components + tags + attribute_defs.
   */
  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    exhausted = false;

    const tree = applyFilterToTree(predicate, undefined);
    const order = buildOrderClauses(sort);

    const taskInput: CardSelectWithAttributesInput = {
      cardTypeName: 'task',
      limit: PAGE_LIMIT,
      offset: 0,
    };
    if (scopedProjectId !== undefined) taskInput.parentCardId = scopedProjectId;
    if (tree !== undefined) taskInput.tree = tree;
    if (order.length > 0) taskInput.order = order;

    const fTasks = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: taskInput,
    });
    const fPersons = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'person' },
    });
    // Picker queries inherit the active project scope. Milestones,
    // components, and tags sit one level under their project in v1, so
    // filtering by `parentCardId` is equivalent to "in this project."
    // The all-projects view leaves the filter unset so every option
    // shows up.
    const milestoneData: CardSelectWithAttributesInput = { cardTypeName: 'milestone' };
    const componentData: CardSelectWithAttributesInput = { cardTypeName: 'component' };
    const tagData: CardSelectWithAttributesInput = { cardTypeName: 'tag' };
    const statusData: CardSelectWithAttributesInput = { cardTypeName: 'status' };
    if (scopedProjectId !== undefined) {
      milestoneData.parentCardId = scopedProjectId;
      componentData.parentCardId = scopedProjectId;
      tagData.parentCardId = scopedProjectId;
      statusData.parentCardId = scopedProjectId;
    }
    const fMilestones = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: milestoneData,
    });
    const fComponents = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: componentData,
    });
    const fTags = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: tagData,
    });
    const fStatuses = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: statusData,
    });
    // `AttributeSchemaCache.load()` issues `attribute_def.select` on the
    // same tick (and short-circuits on subsequent screen mounts).
    const fSchema = schemaCache.load();

    try {
      const [tOut, pOut, mOut, cOut, tagOut, sOut] = await Promise.all([
        fTasks,
        fPersons,
        fMilestones,
        fComponents,
        fTags,
        fStatuses,
        fSchema,
      ]);
      rows = tOut.rows;
      personRows = pOut.rows;
      milestoneRows = mOut.rows;
      componentRows = cOut.rows;
      tagRows = tagOut.rows;
      statusRows = sOut.rows;
      exhausted = tOut.rows.length < PAGE_LIMIT;
      // Reset selection inside bounds.
      if (selectedIndex >= rows.length) {
        selectedIndex = Math.max(0, rows.length - 1);
      }
    } catch (e) {
      if (e instanceof SubRequestError) {
        error = e.message;
      } else if (e instanceof BatchAbortedError) {
        error = e.reason;
      } else {
        error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || exhausted || loading) return;
    loadingMore = true;
    try {
      const tree = applyFilterToTree(predicate, undefined);
      const order = buildOrderClauses(sort);
      const input: CardSelectWithAttributesInput = {
        cardTypeName: 'task',
        limit: PAGE_LIMIT,
        offset: rows.length,
      };
      if (scopedProjectId !== undefined) input.parentCardId = scopedProjectId;
      if (tree !== undefined) input.tree = tree;
      if (order.length > 0) input.order = order;
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: input,
      });
      rows = [...rows, ...out.rows];
      if (out.rows.length < PAGE_LIMIT) exhausted = true;
    } catch (e) {
      if (e instanceof SubRequestError) {
        notify({ type: 'error', message: `Load more failed: ${e.message}` });
      } else if (e instanceof BatchAbortedError) {
        notify({ type: 'error', message: `Load more failed: ${e.reason}` });
      } else {
        notify({
          type: 'error',
          message: `Load more failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } finally {
      loadingMore = false;
    }
  }

  // Re-fetch when sort or predicate changes. Gated on `filterReady`
  // so the first request waits for ScreenFilterBar's default-filter
  // probe — otherwise the screen fires an unfiltered fetch (predicate
  // null), then a filtered one when the probe resolves, and the user
  // sees a brief flash of the unfiltered rows.
  let filterReady = $state(false);
  $effect(() => {
    void predicate;
    void sort;
    void scopedProjectId;
    if (!filterReady) return;
    void refresh();
  });

  /* ----------------------------------------------------- filter attributes */

  /**
   * Per-attribute option resolver. Used by both the FilterBar and the
   * per-column filter dropdown so the same set of options is presented
   * regardless of where the user opens the picker.
   */
  function resolveOptionsFor(name: string): { value: unknown; label: string }[] {
    if (name === 'assignee') {
      return personRows.map((p) => {
        const t = p.attributes['title'];
        return {
          value: p.id,
          label: typeof t === 'string' && t.length > 0 ? t : `#${p.id}`,
        };
      });
    }
    if (name === 'milestone_ref') {
      return milestoneRows.map((m) => {
        const t = m.attributes['title'] ?? m.attributes['name'];
        return {
          value: m.id,
          label: typeof t === 'string' ? t : `#${m.id}`,
        };
      });
    }
    if (name === 'component_ref') {
      return componentRows.map((c) => {
        const t = c.attributes['title'] ?? c.attributes['name'];
        return {
          value: c.id,
          label: typeof t === 'string' ? t : `#${c.id}`,
        };
      });
    }
    if (name === 'tags') {
      return tagRows.map((t) => {
        const p = t.attributes['path'];
        return {
          value: t.id,
          label: typeof p === 'string' ? p : `#${t.id}`,
        };
      });
    }
    return [];
  }

  /**
   * FilterBar palette. Single source of truth: `filter/task_palette.ts`.
   * Same names / labels / option lists as Inbox, Kanban, ProjectDetail.
   */
  const filterAttributes = $derived<FilterAttribute[]>(
    buildTaskFilterPalette({
      schema: schemaCache,
      // Assignee → person cards. The palette resolves it via its
      // refResolver from this list.
      persons: personRows,
      milestones: milestoneRows,
      components: componentRows,
      tags: tagRows,
      statuses: statusRows,
    }),
  );

  /** Look up a `FilterAttribute` from the active palette by name. */
  function filterAttributeFor(name: string): FilterAttribute | null {
    return filterAttributes.find((a) => a.name === name) ?? null;
  }

  /* ----------------------------------------------------- per-column filter */

  type ColumnFilterState = {
    attrName: string;
    /** values selected so far; multi for in/notIn, single otherwise. */
    values: unknown[];
  };

  let colFilter = $state<ColumnFilterState | null>(null);
  let colFilterAnchor: HTMLElement | null = null;
  let colFilterPopup: HTMLDivElement | null = $state(null);
  let colFilterCleanup: (() => void) | null = null;

  async function openColumnFilter(
    attrName: string,
    anchor: HTMLElement,
  ): Promise<void> {
    const fa = filterAttributeFor(attrName);
    if (fa === null) return;
    // Pre-populate from existing predicate leaf.
    const existing = findLeafFor(predicate, attrName);
    colFilter = {
      attrName,
      values: existing?.values ? existing.values.slice() : [],
    };
    colFilterAnchor = anchor;
    await tick();
    setupColFilterFloat();
  }

  function closeColumnFilter(): void {
    colFilter = null;
    colFilterAnchor = null;
    colFilterCleanup?.();
    colFilterCleanup = null;
  }

  function setupColFilterFloat(): void {
    const a = colFilterAnchor;
    if (!a || !colFilterPopup) return;
    colFilterCleanup?.();
    colFilterCleanup = autoUpdate(a, colFilterPopup, () => {
      if (!a || !colFilterPopup) return;
      void computePosition(a, colFilterPopup, {
        placement: 'bottom-start',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!colFilterPopup) return;
        // Reveal only once positioned — see Combobox.svelte for the
        // rationale (avoids the (0,0) flash before computePosition).
        Object.assign(colFilterPopup.style, {
          left: `${x}px`,
          top: `${y}px`,
          visibility: 'visible',
        });
      });
    });
  }

  function commitColumnFilter(): void {
    if (colFilter === null) return;
    const state = colFilter;
    const fa = filterAttributeFor(state.attrName);
    if (fa === null) {
      closeColumnFilter();
      return;
    }
    if (state.values.length === 0) {
      // Clearing the column filter removes the leaf for this attribute.
      const stripped = stripLeafFor(predicate, state.attrName);
      predicate = stripped;
      closeColumnFilter();
      return;
    }
    const newLeaf: PredicateLeaf =
      state.values.length === 1 && state.values[0] !== undefined
        ? eq(state.attrName, state.values[0])
        : in_(state.attrName, state.values);
    if (predicate === null || isFlatAndOfLeaves(predicate)) {
      predicate = replaceLeafForAttr(predicate, newLeaf);
    } else {
      // Predicate has nested groups — refuse to mutate it via this entry
      // point so we don't silently destructure the user's advanced tree.
      notify({
        type: 'info',
        message: 'Use the Filter bar (Advanced) to edit nested predicates.',
      });
    }
    closeColumnFilter();
  }

  function findLeafFor(p: Predicate | null, attr: string): PredicateLeaf | null {
    if (p === null) return null;
    if (p.kind === 'leaf') return p.attr === attr ? p : null;
    if (p.connective !== 'and') return null;
    for (const c of p.children) {
      if (c.kind === 'leaf' && c.attr === attr) return c;
    }
    return null;
  }

  function stripLeafFor(p: Predicate | null, attr: string): Predicate | null {
    if (p === null) return null;
    if (p.kind === 'leaf') return p.attr === attr ? null : p;
    if (p.connective !== 'and') return p;
    const remaining = p.children.filter(
      (c) => !(c.kind === 'leaf' && c.attr === attr),
    );
    if (remaining.length === 0) return null;
    if (remaining.length === 1) return remaining[0] as Predicate;
    return { kind: 'group', connective: 'and', children: remaining };
  }

  function onColFilterDocPointerDown(e: PointerEvent): void {
    if (colFilter === null) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (colFilterPopup?.contains(t)) return;
    if (colFilterAnchor?.contains(t)) return;
    // Click outside acts as "apply" rather than "discard": if the user has
    // touched any values, commit them; otherwise just close. This avoids the
    // surprising case where the user picks options and looks away to lose them.
    commitColumnFilter();
  }

  $effect(() => {
    if (colFilter !== null) {
      document.addEventListener('pointerdown', onColFilterDocPointerDown, true);
      return () => {
        document.removeEventListener(
          'pointerdown',
          onColFilterDocPointerDown,
          true,
        );
      };
    }
    return undefined;
  });

  $effect(() => {
    return () => {
      colFilterCleanup?.();
    };
  });

  /* ------------------------------------------------------------------ sort */

  function onHeaderClick(col: ColumnDef): void {
    if (col.field === null) return;
    sort = cycleSort(sort, col.field);
  }

  function onHeaderFocus(col: ColumnDef): void {
    focusedColumn = col.field;
  }

  /* ------------------------------------------------------------- selection */

  function selectAt(idx: number): void {
    if (rows.length === 0) return;
    const next = Math.max(0, Math.min(rows.length - 1, idx));
    selectedIndex = next;
    // Scroll into view if needed.
    if (bodyEl) {
      const top = next * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      const viewTop = bodyEl.scrollTop;
      const viewBottom = viewTop + bodyEl.clientHeight;
      if (top < viewTop) bodyEl.scrollTop = top;
      else if (bottom > viewBottom) bodyEl.scrollTop = bottom - bodyEl.clientHeight;
    }
  }

  /** Capture the current grid order as the task nav-list and navigate. */
  function openTaskById(id: ID): void {
    setTaskNavList({
      label: scopedProjectId === undefined ? 'Grid' : `Grid — project ${scopedProjectId}`,
      ids: rows.map((r) => r.id),
    });
    navigate(`/task/${id}`);
  }

  function openSelected(): void {
    const r = rows[selectedIndex];
    if (r === undefined) return;
    openTaskById(r.id);
  }

  function openRow(row: CardWithAttrs): void {
    openTaskById(row.id);
  }

  /* ------------------------------------------------------------- shortcuts */

  // Gate 6: thread statusRows (the loaded status candidate set) into
  // the QuickEntry rune as a getter so the default-create-status chain
  // sees the latest list at submit time.
  const qe = useQuickEntry({
    scope: 'grid',
    defaultCardType: 'task',
    candidateStatuses: () => statusRows,
    onCreated: () => {
      void refresh();
    },
  });

  useShortcut('grid', ['j', 'ArrowDown'], () => selectAt(selectedIndex + 1), 'Down');
  useShortcut('grid', ['k', 'ArrowUp'], () => selectAt(selectedIndex - 1), 'Up');
  useShortcut('grid', 'Enter', openSelected, 'Open selected task');
  useShortcut(
    'grid',
    's',
    () => {
      if (focusedColumn !== null) {
        sort = cycleSort(sort, focusedColumn);
      }
    },
    'Cycle sort on focused column',
  );
  useShortcut(
    'grid',
    'f',
    () => {
      // Open the per-column filter on the focused header (when the column
      // is filterable). Falls through silently if there's no header focus.
      if (focusedColumn === null) return;
      const col = columns.find((c) => c.field === focusedColumn);
      if (col === undefined || col.attrName === null) return;
      const id = `grid-header-${col.label.toLowerCase()}-filter`;
      const el =
        typeof document !== 'undefined'
          ? (document.getElementById(id) as HTMLElement | null)
          : null;
      if (el !== null) void openColumnFilter(col.attrName, el);
    },
    'Open filter on focused column',
  );

  /* ------------------------------------------------------------ infinite scroll */

  function onBodyScroll(): void {
    if (bodyEl === null) return;
    const remaining =
      bodyEl.scrollHeight - (bodyEl.scrollTop + bodyEl.clientHeight);
    // Trigger load-more when within ~2 rows of the bottom.
    if (remaining < ROW_HEIGHT * 2) {
      void loadMore();
    }
  }

  /* ------------------------------------------------------------------ cells */

  function assigneeOf(row: CardWithAttrs): string | undefined {
    const id = row.attributes['assignee'];
    if (typeof id !== 'bigint') return undefined;
    const key = id.toString();
    return personNames[key] ?? `#${key}`;
  }

  function refTitle(row: CardWithAttrs, key: string): string | undefined {
    const id = row.attributes[key];
    if (typeof id !== 'bigint') return undefined;
    const k = id.toString();
    return cardTitles[k] ?? `#${k}`;
  }

  function tagsOf(row: CardWithAttrs): string[] {
    const ids = row.attributes['tags'];
    if (!Array.isArray(ids)) return [];
    const out: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'bigint') continue;
      const p = tagPaths[id.toString()];
      if (p === undefined) continue;
      if (p.startsWith('priority/')) continue; // priority lives in its own column
      out.push(p);
    }
    return out;
  }

  function priorityOf(row: CardWithAttrs): string | undefined {
    const ids = row.attributes['tags'];
    if (!Array.isArray(ids)) return undefined;
    for (const id of ids) {
      if (typeof id !== 'bigint') continue;
      const p = tagPaths[id.toString()];
      if (typeof p === 'string' && p.startsWith('priority/')) return p;
    }
    return undefined;
  }

  function createdOf(row: CardWithAttrs): string | undefined {
    const v = row.attributes['created_at'];
    if (typeof v === 'string' && v.length >= 10) return v.slice(0, 10);
    return undefined;
  }

  /* ------------------------------------------------------------- visible rows */

  // Simple virtualization: render up to PAGE_LIMIT rows. Browsers handle 200
  // rows of plain DOM well; full window virtualization is a follow-up.
  const visibleRows = $derived(rows.slice(0, PAGE_LIMIT));

  /* --------------------------------------------------------- col-filter UI */

  const colFilterAttribute = $derived.by((): FilterAttribute | null => {
    if (colFilter === null) return null;
    return filterAttributeFor(colFilter.attrName);
  });
</script>

<div class="flex h-full w-full flex-col">
  <div class="shrink-0 border-b border-border px-4 py-2">
    <ScreenFilterBar
      screenType="grid"
      projectId={scopedProjectId ?? null}
      {dispatcher}
      {filterAttributes}
      bind:predicate
      bind:filterReady
    >
      {#snippet trailing()}
        <span data-testid="grid-row-count">
          {rows.length}
          row{rows.length === 1 ? '' : 's'}
        </span>
        {#if loading}
          <Spinner size="sm" />
        {/if}
      {/snippet}
    </ScreenFilterBar>
  </div>

  {#if error !== null}
    <div
      role="alert"
      data-testid="grid-error"
      class="m-4 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load grid: {error}
    </div>
  {/if}

  {#if loading && rows.length === 0 && error === null}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if rows.length === 0 && error === null}
    <div class="flex flex-1 items-center justify-center">
      <EmptyState
        title="No matching rows"
        description="Adjust the filter above or press n to create a new task."
      />
    </div>
  {:else}
    <div class="flex-1 overflow-x-auto">
      <div style:width="{totalWidth}px" class="flex flex-col">
        <!-- Header row -->
        <div
          class="sticky top-0 z-10 flex border-b border-border bg-surface text-xs font-semibold"
          role="row"
        >
          {#each columns as col (col.label)}
            {@const sortActive = sort !== null && sort.field === col.field}
            {@const arrow = sortActive
              ? sort?.direction === 'asc'
                ? '↑'
                : '↓'
              : ''}
            <div
              class="flex shrink-0 items-center gap-1 px-2 py-2"
              style:width="{col.width}px"
              role="columnheader"
              aria-sort={sortActive
                ? sort?.direction === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none'}
            >
              <button
                type="button"
                data-testid="grid-header-{col.label.toLowerCase()}"
                class={cx(
                  'flex flex-1 items-center gap-1 truncate text-left',
                  col.field !== null
                    ? 'cursor-pointer hover:text-accent'
                    : 'cursor-default',
                  sortActive ? 'text-accent' : '',
                )}
                onclick={() => onHeaderClick(col)}
                onfocus={() => onHeaderFocus(col)}
                disabled={col.field === null}
              >
                <span class="truncate">{col.label}</span>
                {#if arrow !== ''}
                  <span aria-hidden="true">{arrow}</span>
                {/if}
              </button>
              {#if col.attrName !== null}
                <IconButton
                  aria-label="Filter {col.label}"
                  size="sm"
                  variant="ghost"
                  title="Filter {col.label}"
                  onclick={(e) => {
                    const btn = e.currentTarget as HTMLElement;
                    btn.id = `grid-header-${col.label.toLowerCase()}-filter`;
                    void openColumnFilter(col.attrName!, btn);
                  }}
                >
                  {#snippet children()}
                    <svg
                      viewBox="0 0 12 12"
                      class="h-3 w-3"
                      aria-hidden="true"
                    >
                      <path
                        d="M2 3 L10 3 L7 7 L7 10 L5 9 L5 7 Z"
                        stroke="currentColor"
                        stroke-width="1"
                        stroke-linejoin="round"
                        fill="none"
                      />
                    </svg>
                  {/snippet}
                </IconButton>
              {/if}
            </div>
          {/each}
        </div>

        <!-- Body -->
        <div
          bind:this={bodyEl}
          class="flex-1 overflow-y-auto"
          onscroll={onBodyScroll}
          role="rowgroup"
          data-testid="grid-body"
        >
          {#each visibleRows as row, i (row.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class={cx(
                'flex shrink-0 cursor-pointer border-b border-border text-sm',
                'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                i === selectedIndex ? 'bg-surface' : '',
              )}
              style:height="{ROW_HEIGHT}px"
              data-testid="grid-row"
              data-card-id={row.id}
              role="row"
              tabindex="0"
              onclick={() => {
                selectedIndex = i;
                openRow(row);
              }}
              onfocus={() => {
                selectedIndex = i;
              }}
            >
              <!-- ID -->
              <div
                class="flex shrink-0 items-center px-2 font-mono text-xs text-muted"
                style:width="{columns[0]!.width}px"
              >
                #{row.id}
              </div>
              <!-- Title -->
              <div
                class="flex shrink-0 items-center truncate px-2"
                style:width="{columns[1]!.width}px"
              >
                <span class="truncate">
                  {(() => {
                    const t = row.attributes['title'];
                    return typeof t === 'string' && t !== ''
                      ? t
                      : '(untitled)';
                  })()}
                </span>
              </div>
              <!-- Assignee -->
              <div
                class="flex shrink-0 items-center px-2"
                style:width="{columns[2]!.width}px"
              >
                {#if assigneeOf(row) !== undefined}
                  <AttributeChip label="assignee" value={assigneeOf(row)!} />
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </div>
              <!-- Priority -->
              <div
                class="flex shrink-0 items-center px-2"
                style:width="{columns[3]!.width}px"
              >
                {#if priorityOf(row) !== undefined}
                  <TagChip label={priorityOf(row)!} />
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </div>
              <!-- Milestone -->
              <div
                class="flex shrink-0 items-center px-2"
                style:width="{columns[4]!.width}px"
              >
                {#if refTitle(row, 'milestone_ref') !== undefined}
                  <AttributeChip
                    label="milestone"
                    value={refTitle(row, 'milestone_ref')!}
                  />
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </div>
              <!-- Component -->
              <div
                class="flex shrink-0 items-center px-2"
                style:width="{columns[5]!.width}px"
              >
                {#if refTitle(row, 'component_ref') !== undefined}
                  <AttributeChip
                    label="component"
                    value={refTitle(row, 'component_ref')!}
                  />
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </div>
              <!-- Tags -->
              <div
                class="flex shrink-0 items-center gap-1 overflow-hidden px-2"
                style:width="{columns[6]!.width}px"
              >
                {#each tagsOf(row) as t (t)}
                  <TagChip label={t} />
                {/each}
              </div>
              <!-- Created -->
              <div
                class="flex shrink-0 items-center px-2 text-xs text-muted"
                style:width="{columns[7]!.width}px"
              >
                {createdOf(row) ?? '—'}
              </div>
            </div>
          {/each}

          {#if !exhausted && rows.length > 0}
            <div
              class="flex items-center justify-center py-3"
              data-testid="grid-load-more-sentinel"
            >
              {#if loadingMore}
                <Spinner size="sm" />
              {:else}
                <Button size="sm" variant="ghost" onclick={() => void loadMore()}>
                  {#snippet children()}Load more{/snippet}
                </Button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

{#if colFilter !== null && colFilterAttribute !== null}
  {@const fa = colFilterAttribute}
  {@const isCombobox = fa.valueType.startsWith('ref:')}
  {@const multiple = colFilter.values.length > 1}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={colFilterPopup}
    class="z-50 flex w-72 flex-col gap-2 rounded-md border border-border bg-bg p-3 shadow-lg"
    role="dialog"
    aria-label="Filter {fa.label}"
    tabindex="-1"
    style="position: fixed; left: 0; top: 0; visibility: hidden;"
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeColumnFilter();
      } else if (
        e.key === 'Enter' &&
        (e.target as HTMLElement | null)?.tagName.toLowerCase() === 'button'
      ) {
        e.preventDefault();
        commitColumnFilter();
      }
    }}
  >
    <div class="text-xs font-semibold text-muted">Filter {fa.label}</div>
    {#if isCombobox}
      <Combobox
        aria-label="Filter {fa.label}"
        options={(fa.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
        }))}
        value={multiple
          ? colFilter.values
          : (colFilter.values[0] ?? null)}
        multiple={true}
        onchange={(v) => {
          if (colFilter === null) return;
          if (Array.isArray(v)) {
            colFilter.values = v.slice();
          } else if (v === null || v === undefined) {
            colFilter.values = [];
          } else {
            colFilter.values = [v];
          }
        }}
      />
    {:else}
      <ValueInput
        attribute={fa}
        value={colFilter.values[0]}
        onchange={(v) => {
          if (colFilter === null) return;
          if (v === null || v === undefined) {
            colFilter.values = [];
          } else {
            colFilter.values = [v];
          }
        }}
      />
    {/if}
    <div class="flex justify-end gap-2">
      <Button size="sm" variant="ghost" onclick={closeColumnFilter}>
        {#snippet children()}Cancel{/snippet}
      </Button>
      <Button size="sm" variant="ghost" onclick={() => {
        if (colFilter !== null) colFilter.values = [];
        commitColumnFilter();
      }}>
        {#snippet children()}Clear{/snippet}
      </Button>
      <Button size="sm" variant="primary" onclick={commitColumnFilter}>
        {#snippet children()}Apply{/snippet}
      </Button>
    </div>
  </div>
{/if}

<QuickEntryOverlay {...qe.props} />

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
  import { isAssignablePerson } from '../util/person';
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
  import TagChip from '../ui/widgets/TagChip.svelte';
  import { cx } from '../util/class_names.js';
  import BulkActionBar from './BulkActionBar.svelte';

  import {
    applyFilterToTree,
    buildOrderClauses,
    compareTagPrefixValue,
    cycleSort,
    effectiveSort,
    expandRowsForArrayGroup,
    isTagPrefixSortField,
    pickTagForPrefix,
    sortStatesFromFilter,
    stripTagPrefix,
    type SortState,
    tagPrefixFromSortField,
    tagPrefixSortField,
    walkGrouped,
  } from './grid_helpers.js';
  import {
    readExtraColumns,
    readGroupByAttr,
    readSort,
    readTagPrefixColumns,
  } from '../filter/screen_preset.svelte.js';

  /* ------------------------------------------------------------------ props */

  interface Props {
    /** Optional project scope; null = grid spans every task in the system. */
    projectId?: ID;
    params?: Record<string, string>;
  }

  let { projectId, params = {} }: Props = $props();

  /** Active screen slug from `/project/:id/screen/:slug`. Drives the
   *  preset cache scope so two grid-layout screens in the same project
   *  don't share state. */
  const slug = $derived.by((): string => {
    const v = params['slug'];
    return typeof v === 'string' && v !== '' ? v : 'grid';
  });

  // Resolution order: explicit prop > `:id` route param > global project
  // scope picked from the sidebar. The global scope is the everyday case;
  // ScreenHost mounts this layout under `/project/:id/screen/grid` and
  // syncs `:id` into `projectScope` so the param path and the sidebar
  // choice agree by construction.
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
   * Column descriptor. `kind` tags how the row cell should render;
   * `field` is the wire `order.field` value the server understands
   * (`null` means the column is non-sortable in any form, e.g. the
   * catch-all Tags column whose value is a JSONB array). Tag-prefix
   * columns carry a synthetic field (`tag_prefix:<prefix>`) that the
   * grid intercepts and applies as a client-side resort — the value
   * is derived from each row's tag-path lookup, which the server
   * can't usefully order against.
   *
   * `attrName` is the matching `attribute_def.name`; we use it to look
   * up the per-column filter Combobox options. `null` means no filter
   * dropdown (ID, Created, Title etc).
   *
   * `prefix` is set on `kind: 'tag_prefix'` columns and gives the
   * leading tag-path segment to break out (e.g. `priority` → the
   * column lights up for any tag whose path starts with `priority/`).
   */
  type ColumnKind =
    | 'id'
    | 'title'
    | 'assignee'
    | 'milestone'
    | 'component'
    | 'tags'
    | 'created'
    | 'last_activity'
    | 'tag_prefix'
    | 'attr';

  interface ColumnDef {
    kind: ColumnKind;
    label: string;
    field: string | null;
    attrName: string | null;
    width: number;
    prefix?: string;
    /**
     * Stable, unique-per-column key for `{#each}` blocks. Built so two
     * `kind: 'attr'` columns (e.g. due_date + a custom attribute) never
     * collide — Svelte's each_key_duplicate error fires otherwise.
     * Defaults to `kind` for the singletons; derived per-row for the
     * polymorphic kinds.
     */
    key: string;
  }

  function columnKey(c: Omit<ColumnDef, 'key'>): string {
    if (c.kind === 'tag_prefix') return `tp:${c.prefix ?? ''}`;
    if (c.kind === 'attr') return `attr:${c.attrName ?? ''}`;
    return c.kind;
  }

  function makeColumn(c: Omit<ColumnDef, 'key'>): ColumnDef {
    return { ...c, key: columnKey(c) };
  }

  const BASE_COLUMNS_BEFORE_PREFIX: ColumnDef[] = [
    makeColumn({ kind: 'id', label: 'ID', field: null, attrName: null, width: 60 }),
    makeColumn({ kind: 'title', label: 'Title', field: 'attributes.title', attrName: null, width: 320 }),
    makeColumn({
      kind: 'assignee',
      label: 'Assignee',
      field: 'attributes.assignee',
      attrName: 'assignee',
      width: 140,
    }),
  ];

  const BASE_COLUMNS_AFTER_PREFIX: ColumnDef[] = [
    makeColumn({
      kind: 'milestone',
      label: 'Milestone',
      field: 'attributes.milestone_ref',
      attrName: 'milestone_ref',
      width: 130,
    }),
    makeColumn({
      kind: 'component',
      label: 'Component',
      field: 'attributes.component_ref',
      attrName: 'component_ref',
      width: 130,
    }),
    makeColumn({ kind: 'tags', label: 'Tags', field: null, attrName: null, width: 220 }),
    makeColumn({ kind: 'created', label: 'Created', field: 'created_at', attrName: null, width: 110 }),
    makeColumn({ kind: 'last_activity', label: 'Last activity', field: 'last_activity_at', attrName: null, width: 130 }),
  ];

  function prefixColumnLabel(prefix: string): string {
    if (prefix.length === 0) return prefix;
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }

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
    for (const r of statusRows) {
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
  /** The full filter card we resolved through ScreenFilterBar — its
   *  persisted `sort` array seeds the initial order until the user
   *  header-clicks. Bound below in the markup. */
  let activeFilter = $state<CardWithAttrs | null>(null);
  /** The screen card itself (resolved via ScreenFilterBar). Carries
   *  screen-definition attributes that are shared across every filter
   *  preset on the screen — specifically `tag_prefix_columns`. Bound
   *  below in the markup. */
  let activeScreen = $state<CardWithAttrs | null>(null);
  /** Persisted sort projected to the grid's SortState shape. Recomputes
   *  whenever the active filter changes (filter swap, default filter
   *  resolves on first paint). */
  const filterSortStates = $derived(
    activeFilter === null ? [] : sortStatesFromFilter(readSort(activeFilter)),
  );
  /** Attribute the renderer should bucket rows by, or null for a flat
   *  list. Driven by the active filter card's `group_by_attr`. */
  const groupByAttr = $derived(
    activeFilter === null ? null : readGroupByAttr(activeFilter),
  );
  /** True when the group attribute is array-shaped (card_ref[] —
   *  today only `tags` qualifies). Array grouping needs client-side
   *  expansion (one synthetic row per element) because the server
   *  can't usefully `ORDER BY` a JSONB array value. */
  const isArrayGroup = $derived.by((): boolean => {
    if (groupByAttr === null) return false;
    const def = schemaCache.defByName(groupByAttr);
    return def?.value_type === 'card_ref[]';
  });
  /** Ephemeral direction for the group sort key (the first entry in
   *  the effective order when grouping is active). Reset to 'asc'
   *  whenever the group attr changes so the toggle starts predictable
   *  for a fresh column. */
  let groupDir = $state<'asc' | 'desc'>('asc');
  let lastGroupByAttr: string | null = null;
  $effect(() => {
    if (groupByAttr !== lastGroupByAttr) {
      groupDir = 'asc';
      lastGroupByAttr = groupByAttr;
    }
  });
  /** Server-side order under the unified pipeline. When grouping is
   *  active the group key is the first entry — that's what makes rows
   *  cluster — and the secondary keys come from the header-click sort
   *  (if any) or the filter's persisted sort. Dedup against the group
   *  key so we never emit the same field twice. */
  const effectiveOrder = $derived.by((): SortState[] => {
    const out: SortState[] = [];
    // Array groups (tags) are sorted client-side after row expansion,
    // so we omit the group key from the server order — `ORDER BY` on
    // a JSONB array yields the array's lexical encoding, not anything
    // useful per-element.
    const groupField =
      groupByAttr === null || isArrayGroup
        ? null
        : `attributes.${groupByAttr}`;
    if (groupField !== null) {
      out.push({ field: groupField, direction: groupDir });
    }
    const tail = effectiveSort(sort, filterSortStates);
    for (const t of tail) {
      if (t.field === groupField) continue;
      out.push(t);
    }
    return out;
  });

  /** Server slice of the effective order — what we hand to the wire
   *  `order[]` array. Tag-prefix synthetic fields are excluded because
   *  the server can't usefully sort by a derived tag-array element.
   */
  const serverOrder = $derived(
    effectiveOrder.filter((o) => !isTagPrefixSortField(o.field)),
  );
  /** Client slice — at most one tag-prefix sort key applied after the
   *  server returns. Multi-key client sort would compound poorly with
   *  the pagination shape (we only see the loaded page), so we keep
   *  it to a single override. */
  const clientTagPrefixSort = $derived.by((): SortState | null => {
    const found = effectiveOrder.find((o) => isTagPrefixSortField(o.field));
    return found ?? null;
  });
  // Predicate starts from the persisted cache for this scope/project,
  // or null when there's nothing cached yet. On first visit we apply
  // the data-side default filter (see the effect below).
  let predicate = $state<Predicate | null>(
    untrack(() => getFilter(slug, projectScope.projectId)),
  );
  let selectedIndex = $state(0);
  let focusedColumn = $state<string | null>(null);

  /* ----------------------------------------------------- bulk selection */
  // Card ids the user has checked for bulk operations. Keyed by
  // stringified id so `Set` membership works for `bigint`.
  let bulkSelected = $state<Set<string>>(new Set());
  // Index of the last interactively-toggled row; shift-click selects
  // the contiguous range from this anchor to the new row.
  let selectionAnchor: number | null = $state(null);

  function isBulkSelected(id: ID): boolean {
    return bulkSelected.has(id.toString());
  }

  function clearBulkSelection(): void {
    bulkSelected = new Set();
    selectionAnchor = null;
  }

  function toggleOne(idx: number, id: ID): void {
    const key = id.toString();
    const next = new Set(bulkSelected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    bulkSelected = next;
    selectionAnchor = idx;
  }

  /** Shift-click: select every row from the anchor (inclusive) to
   *  `idx` (inclusive). The anchor index is preserved so a follow-up
   *  shift-click extends the range from the same starting point. */
  function selectRangeTo(idx: number): void {
    if (selectionAnchor === null) {
      const r = rows[idx];
      if (r !== undefined) toggleOne(idx, r.id);
      return;
    }
    const lo = Math.min(selectionAnchor, idx);
    const hi = Math.max(selectionAnchor, idx);
    const next = new Set(bulkSelected);
    for (let i = lo; i <= hi; i++) {
      const r = rows[i];
      if (r !== undefined) next.add(r.id.toString());
    }
    bulkSelected = next;
  }

  /** Bulk-selected ids in the order they appear in the current
   *  filtered/sorted `rows` list. Filtering by current row identity
   *  drops stale ids whose card was removed by a refresh. */
  const bulkSelectedIds = $derived.by((): ID[] => {
    if (bulkSelected.size === 0) return [];
    const out: ID[] = [];
    for (const r of rows) {
      if (bulkSelected.has(r.id.toString())) out.push(r.id);
    }
    return out;
  });

  /** Header checkbox tri-state: 'none' | 'some' | 'all'. Drives both
   *  the visual indeterminate flag and the click behavior (clear vs.
   *  select-all-visible). */
  const headerCheckState = $derived.by((): 'none' | 'some' | 'all' => {
    if (rows.length === 0 || bulkSelected.size === 0) return 'none';
    let hits = 0;
    for (const r of rows) if (bulkSelected.has(r.id.toString())) hits += 1;
    if (hits === 0) return 'none';
    if (hits === rows.length) return 'all';
    return 'some';
  });

  function toggleHeaderCheck(): void {
    if (headerCheckState === 'all') {
      clearBulkSelection();
      return;
    }
    const next = new Set(bulkSelected);
    for (const r of rows) next.add(r.id.toString());
    bulkSelected = next;
    selectionAnchor = rows.length > 0 ? 0 : null;
  }

  const CHECKBOX_COL_WIDTH = 32;

  // The header checkbox needs its `.indeterminate` JS property set —
  // there's no equivalent HTML attribute, so we drive it via a ref.
  let headerCheckEl: HTMLInputElement | null = $state(null);
  $effect(() => {
    if (headerCheckEl !== null) {
      headerCheckEl.indeterminate = headerCheckState === 'some';
    }
  });

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
    const order = buildOrderClauses(serverOrder);

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
      const order = buildOrderClauses(serverOrder);
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
    void effectiveOrder;
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
      return personRows.filter(isAssignablePerson).map((p) => {
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
    // When the user clicks the header for the current group column,
    // they're asking to flip the group direction — the section header
    // does the same thing. Route both gestures through one handler so
    // they can't disagree (the cycleSort path would otherwise write a
    // secondary sort key that effectiveOrder then dedups away).
    if (groupByAttr !== null && col.field === `attributes.${groupByAttr}`) {
      toggleGroupDir();
      return;
    }
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
    attributePalette: () => filterAttributes,
    tagOptions: () =>
      tagRows.map((r) => {
        const p = r.attributes['path'];
        return {
          value: r.id,
          label: typeof p === 'string' && p !== '' ? p : `#${r.id}`,
        };
      }),
    onCreated: () => {
      void refresh();
    },
  });

  useShortcut('grid', ['j', 'ArrowDown'], () => selectAt(selectedIndex + 1), 'Down');
  useShortcut('grid', ['k', 'ArrowUp'], () => selectAt(selectedIndex - 1), 'Up');
  useShortcut('grid', 'Enter', openSelected, 'Open selected task');
  // Space toggles the bulk-select checkbox on the focused row.
  // Mirrors the spreadsheet / Gmail convention so the user can build
  // a bulk selection with j/k + Space without leaving the keyboard.
  useShortcut('grid', 'Space', () => {
    const r = rows[selectedIndex];
    if (r !== undefined) toggleOne(selectedIndex, r.id);
  }, 'Toggle selection on focused row');
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
  /* -------------------------------------------------- search ⇄ list nav -- */

  async function focusSearch(): Promise<void> {
    await tick();
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="text-search-input"]',
    );
    if (el !== null) {
      el.focus();
      el.select();
    }
  }
  useShortcut('grid', '/', () => void focusSearch(), 'Focus search', {
    fireInInputs: false,
  });

  /** Move focus from search to the first row in the grid body. Each
   *  row is a `<tr data-testid="grid-row" tabindex="0">` — the
   *  tabindex sits on the row element itself, not a child. */
  async function focusFirstRow(): Promise<void> {
    await tick();
    const row = document.querySelector<HTMLElement>(
      '[data-testid="grid-row"]',
    );
    if (row === null) return;
    selectAt(0);
    row.focus();
  }
  function onSearchNavigateOut(direction: 'down' | 'up'): void {
    if (direction === 'down') void focusFirstRow();
  }

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

  /** Tag paths to hide from the catch-all Tags column — they're already
   *  surfaced in dedicated prefix columns, so duplicating them would
   *  just spam chips. Computed from the active filter's prefix list. */
  const tagPathPrefixesHidden = $derived.by((): string[] => {
    return tagPrefixColumns.map((c) => c.prefix as string);
  });

  function pathHiddenByPrefix(path: string): boolean {
    for (const prefix of tagPathPrefixesHidden) {
      if (path === prefix) return true;
      if (path.startsWith(`${prefix}/`)) return true;
    }
    return false;
  }

  function tagsOf(row: CardWithAttrs): string[] {
    const ids = row.attributes['tags'];
    if (!Array.isArray(ids)) return [];
    const out: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'bigint') continue;
      const p = tagPaths[id.toString()];
      if (p === undefined) continue;
      if (pathHiddenByPrefix(p)) continue;
      out.push(p);
    }
    return out;
  }

  function prefixTagOf(row: CardWithAttrs, prefix: string): string | undefined {
    return pickTagForPrefix(row.attributes['tags'], tagPaths, prefix);
  }

  function createdOf(row: CardWithAttrs): string | undefined {
    // created_at lives at the top level of the wire row (NOT in
    // `attributes`) — the server sets it from the card.created_at
    // column. Earlier versions read row.attributes which silently
    // produced an empty column.
    const v = row.created_at;
    if (typeof v === 'string' && v.length >= 10) return v.slice(0, 10);
    return undefined;
  }

  function lastActivityOf(row: CardWithAttrs): string | undefined {
    // Virtual field — MAX(activity.created_at) for this card. Undefined
    // when the card has no activity rows yet (fresh insert).
    const v = row.last_activity_at;
    if (typeof v === 'string' && v.length >= 10) return v.slice(0, 10);
    return undefined;
  }

  /* ----------------------------------------------------------- columns (derived) */

  /** Tag-prefix columns derived from the active SCREEN's
   *  `tag_prefix_columns` attribute (it's a screen-definition property,
   *  shared across every filter preset on the screen). Each prefix
   *  produces one column positioned between Assignee and Milestone
   *  (the historical home of the hardcoded Priority column). The
   *  synthetic sort field `tag_prefix:<prefix>` flags the column as
   *  client-side-sortable; see {@link clientTagPrefixSort} for the
   *  resort that consumes it. */
  const tagPrefixColumns = $derived.by((): ColumnDef[] => {
    if (activeScreen === null) return [];
    const prefixes = readTagPrefixColumns(activeScreen);
    return prefixes.map((prefix) =>
      makeColumn({
        kind: 'tag_prefix' as const,
        label: prefixColumnLabel(prefix),
        field: tagPrefixSortField(prefix),
        attrName: null,
        width: 110,
        prefix,
      }),
    );
  });

  /** Extra attribute columns derived from the active SCREEN's
   *  `extra_columns` attribute. Each entry names an attribute_def
   *  (or one of the row-level virtual fields, which already have
   *  dedicated columns and are silently skipped here). Columns are
   *  inserted between Tags and Created so the Title / Assignee /
   *  Tag-prefix block on the left and the timestamp block on the
   *  right both stay anchored to their familiar positions. */
  const extraColumns = $derived.by((): ColumnDef[] => {
    if (activeScreen === null) return [];
    const names = readExtraColumns(activeScreen);
    const out: ColumnDef[] = [];
    for (const name of names) {
      // Skip names that already have a dedicated column — listing
      // 'created_at' / 'last_activity_at' in extra_columns is currently
      // a no-op (reserved for future toggling).
      if (
        name === 'created_at' ||
        name === 'last_activity_at' ||
        name === 'assignee' ||
        name === 'milestone_ref' ||
        name === 'component_ref' ||
        name === 'tags' ||
        name === 'title'
      ) {
        continue;
      }
      const fa = filterAttributes.find((a) => a.name === name);
      const label = fa?.label ?? name;
      out.push(
        makeColumn({
          kind: 'attr' as const,
          label,
          field: `attributes.${name}`,
          attrName: name,
          width: 130,
        }),
      );
    }
    return out;
  });

  const columns = $derived<ColumnDef[]>([
    ...BASE_COLUMNS_BEFORE_PREFIX,
    ...tagPrefixColumns,
    ...BASE_COLUMNS_AFTER_PREFIX.filter((c) => c.kind !== 'created' && c.kind !== 'last_activity'),
    ...extraColumns,
    ...BASE_COLUMNS_AFTER_PREFIX.filter((c) => c.kind === 'created' || c.kind === 'last_activity'),
  ]);

  const totalWidth = $derived(
    CHECKBOX_COL_WIDTH + columns.reduce((sum, c) => sum + c.width, 0),
  );

  /* ------------------------------------------------------------- visible rows */

  // Simple virtualization: render up to PAGE_LIMIT rows. Browsers handle 200
  // rows of plain DOM well; full window virtualization is a follow-up.
  const visibleRows = $derived.by((): CardWithAttrs[] => {
    const page = rows.slice(0, PAGE_LIMIT);
    if (clientTagPrefixSort === null) return page;
    const prefix = tagPrefixFromSortField(clientTagPrefixSort.field);
    if (prefix === null) return page;
    const dir = clientTagPrefixSort.direction;
    // Group + client-sort don't combine cleanly: the server already
    // ordered by the group key, and resorting the whole page would
    // shred bucket order. Skip the client resort while a group is
    // active — the header click still toggles a sort state, but the
    // visual order stays group-first. Users can clear grouping to
    // get the prefix-column sort.
    if (groupByAttr !== null) return page;
    return [...page].sort((a, b) => {
      const av = pickTagForPrefix(a.attributes['tags'], tagPaths, prefix);
      const bv = pickTagForPrefix(b.attributes['tags'], tagPaths, prefix);
      const cmp = compareTagPrefixValue(av, bv, prefix);
      return dir === 'asc' ? cmp : -cmp;
    });
  });

  /**
   * Walk visibleRows into a sequence of headers + rows when the active
   * filter sets `group_by_attr`. Server returns rows already ordered
   * by [group_attr, ...secondary keys], so we just walk and emit a
   * header whenever the group_attr value changes — no client-side
   * bucketing. `labelOf` resolves card_ref-valued keys to the same
   * display title the row cells use, so a milestone bucket reads
   * "API v2" instead of "#742".
   */
  /** Resolve a group key (the raw attribute value) to a display label.
   *  Card_ref values arrive as bigints; we look them up in the merged
   *  title map (milestones + components + statuses), the personNames
   *  map (assignee), and the tagPaths map (tags) before falling back
   *  to `#id`. */
  function labelForGroupKey(v: unknown): string {
    if (typeof v === 'bigint') {
      const k = v.toString();
      return cardTitles[k] ?? personNames[k] ?? tagPaths[k] ?? `#${k}`;
    }
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return String(v);
  }

  /** Input to walkGrouped. For scalar group attrs this is just the
   *  server-ordered visibleRows. For array group attrs (tags) we
   *  expand one synthetic row per element and resort client-side so
   *  a multi-tagged task appears under each of its tag buckets. */
  const rowsForGrouping = $derived(
    isArrayGroup && groupByAttr !== null
      ? expandRowsForArrayGroup(visibleRows, groupByAttr, groupDir)
      : visibleRows,
  );
  const groupedItems = $derived(
    walkGrouped(rowsForGrouping, groupByAttr, labelForGroupKey),
  );

  /** Friendly label for the grouping attribute. The FilterAttribute
   *  palette carries human labels (`Component` for `component_ref`);
   *  fall back to the raw attr name when the palette hasn't loaded or
   *  doesn't know it. */
  const groupByLabel = $derived.by((): string => {
    if (groupByAttr === null) return '';
    const fa = filterAttributes.find((a) => a.name === groupByAttr);
    return fa?.label ?? groupByAttr;
  });


  /** Toggle the group sort direction. Wired to both the section
   *  header and the group column's table header so the two gestures
   *  map to the same action. */
  function toggleGroupDir(): void {
    groupDir = groupDir === 'asc' ? 'desc' : 'asc';
  }

  /* --------------------------------------------------------- col-filter UI */

  const colFilterAttribute = $derived.by((): FilterAttribute | null => {
    if (colFilter === null) return null;
    return filterAttributeFor(colFilter.attrName);
  });
</script>

<div class="flex h-full w-full flex-col">
  <div class="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
    <div class="flex-1">
      <ScreenFilterBar
        screenSlug={slug}
        projectId={scopedProjectId ?? null}
        {dispatcher}
        {filterAttributes}
        bind:predicate
        bind:activeFilter
        bind:screen={activeScreen}
        bind:filterReady
        onNavigateOut={onSearchNavigateOut}
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
    <span data-testid="grid-new-issue">
      <Button size="sm" variant="secondary" onclick={() => qe.open()}>
        {#snippet children()}+ New issue{/snippet}
      </Button>
    </span>
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
          <!-- Bulk-select checkbox column (header). Tri-state: clears
               when all visible rows are checked, otherwise checks all
               visible rows. Indeterminate flag set imperatively so
               we can avoid wiring an extra rune. -->
          <div
            class="flex shrink-0 items-center justify-center"
            style:width="{CHECKBOX_COL_WIDTH}px"
            role="columnheader"
          >
            <input
              bind:this={headerCheckEl}
              type="checkbox"
              class="h-4 w-4 cursor-pointer rounded border-border text-accent focus:ring-2 focus:ring-accent"
              aria-label="Select all visible rows"
              data-testid="grid-bulk-select-all"
              checked={headerCheckState === 'all'}
              onchange={toggleHeaderCheck}
            />
          </div>
          {#each columns as col (col.key)}
            {@const isGroupCol =
              groupByAttr !== null && col.field === `attributes.${groupByAttr}`}
            {@const sortActive =
              isGroupCol || (sort !== null && sort.field === col.field)}
            {@const colDir = isGroupCol
              ? groupDir
              : (sort?.field === col.field ? sort.direction : null)}
            {@const arrow = colDir === 'asc' ? '↑' : colDir === 'desc' ? '↓' : ''}
            <div
              class="flex shrink-0 items-center gap-1 px-2 py-2"
              style:width="{col.width}px"
              role="columnheader"
              aria-sort={sortActive
                ? colDir === 'asc'
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
          {#each groupedItems as item, slot (item.kind === 'header' ? `h:${slot}:${item.key}` : `r:${item.idx}:${item.row.id}`)}
            {#if item.kind === 'header'}
              <!-- Group section header. Clicking toggles the group
                   sort direction — under the unified pipeline that
                   means flipping the first key in the server `order`
                   array, which reverses bucket order in the next
                   response. The same toggle is wired on the group
                   attribute's column header so users can drive it
                   from either affordance. `sticky top-0` is relative
                   to the body's scroll container; the table column
                   header sits outside it. -->
              <button
                type="button"
                class="sticky top-0 z-[5] flex w-full items-center gap-2 border-y border-accent/40 bg-accent/10 px-3 py-1.5 text-left text-xs font-semibold text-fg hover:bg-accent/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                style:width="{totalWidth}px"
                data-testid="grid-group-header"
                data-group-key={item.key}
                data-group-dir={groupDir}
                aria-label={`${groupByLabel}: ${item.label} (click to toggle ${groupDir === 'asc' ? 'descending' : 'ascending'})`}
                onclick={toggleGroupDir}
              >
                <span class="uppercase tracking-wide text-muted">{groupByLabel}</span>
                <span class="text-accent">{groupDir === 'asc' ? '↑' : '↓'}</span>
                <span>{item.label}</span>
              </button>
            {:else}
              {@const row = item.row}
              {@const i = item.idx}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class={cx(
                  'flex shrink-0 cursor-pointer border-b border-border text-sm',
                  'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  i === selectedIndex ? 'bg-surface' : '',
                  isBulkSelected(row.id) ? 'bg-accent/5' : '',
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
              <!-- Checkbox cell. Click handler stops propagation so
                   the row's open-task click doesn't fire. Shift-click
                   extends the range from the selection anchor. -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="flex shrink-0 items-center justify-center"
                style:width="{CHECKBOX_COL_WIDTH}px"
                onclick={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey) selectRangeTo(i);
                  else toggleOne(i, row.id);
                }}
              >
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer rounded border-border text-accent focus:ring-2 focus:ring-accent"
                  aria-label="Select row #{row.id}"
                  data-testid="grid-bulk-select-row"
                  checked={isBulkSelected(row.id)}
                  onclick={(e) => {
                    e.stopPropagation();
                    if (e.shiftKey) selectRangeTo(i);
                    else toggleOne(i, row.id);
                  }}
                />
              </div>
              {#each columns as col (col.key)}
                {#if col.kind === 'id'}
                  <div
                    class="flex shrink-0 items-center px-2 font-mono text-xs text-muted"
                    style:width="{col.width}px"
                  >
                    #{row.id}
                  </div>
                {:else if col.kind === 'title'}
                  <div
                    class="flex shrink-0 items-center truncate px-2"
                    style:width="{col.width}px"
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
                {:else if col.kind === 'assignee'}
                  <div
                    class="flex shrink-0 items-center truncate px-2 text-sm"
                    style:width="{col.width}px"
                  >
                    {#if assigneeOf(row) !== undefined}
                      <span class="truncate">{assigneeOf(row)!}</span>
                    {:else}
                      <span class="text-muted">—</span>
                    {/if}
                  </div>
                {:else if col.kind === 'tag_prefix'}
                  {@const tagPath = prefixTagOf(row, col.prefix!)}
                  <div
                    class="flex shrink-0 items-center px-2"
                    style:width="{col.width}px"
                  >
                    {#if tagPath !== undefined}
                      <TagChip label={stripTagPrefix(tagPath, col.prefix!)} />
                    {:else}
                      <span class="text-muted">—</span>
                    {/if}
                  </div>
                {:else if col.kind === 'milestone'}
                  <div
                    class="flex shrink-0 items-center truncate px-2 text-sm"
                    style:width="{col.width}px"
                  >
                    {#if refTitle(row, 'milestone_ref') !== undefined}
                      <span class="truncate">{refTitle(row, 'milestone_ref')!}</span>
                    {:else}
                      <span class="text-muted">—</span>
                    {/if}
                  </div>
                {:else if col.kind === 'component'}
                  <div
                    class="flex shrink-0 items-center truncate px-2 text-sm"
                    style:width="{col.width}px"
                  >
                    {#if refTitle(row, 'component_ref') !== undefined}
                      <span class="truncate">{refTitle(row, 'component_ref')!}</span>
                    {:else}
                      <span class="text-muted">—</span>
                    {/if}
                  </div>
                {:else if col.kind === 'tags'}
                  <div
                    class="flex shrink-0 items-center gap-1 overflow-hidden px-2"
                    style:width="{col.width}px"
                  >
                    {#each tagsOf(row) as t (t)}
                      <TagChip label={t} />
                    {/each}
                  </div>
                {:else if col.kind === 'created'}
                  <div
                    class="flex shrink-0 items-center px-2 text-xs text-muted"
                    style:width="{col.width}px"
                  >
                    {createdOf(row) ?? '—'}
                  </div>
                {:else if col.kind === 'last_activity'}
                  <div
                    class="flex shrink-0 items-center px-2 text-xs text-muted"
                    style:width="{col.width}px"
                  >
                    {lastActivityOf(row) ?? '—'}
                  </div>
                {:else if col.kind === 'attr' && col.attrName !== null}
                  {@const attr = filterAttributeFor(col.attrName)}
                  {@const raw = row.attributes[col.attrName]}
                  <div
                    class="flex shrink-0 items-center truncate px-2 text-sm"
                    style:width="{col.width}px"
                  >
                    {#if raw === null || raw === undefined || raw === ''}
                      <span class="text-muted">—</span>
                    {:else if attr !== null}
                      <span class="truncate">{resolveAttributeLabel(attr, raw)}</span>
                    {:else}
                      <span class="truncate">{String(raw)}</span>
                    {/if}
                  </div>
                {/if}
              {/each}
            </div>
            {/if}
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

<BulkActionBar
  selectedIds={bulkSelectedIds}
  attributePalette={filterAttributes}
  sourceProjectId={scopedProjectId ?? null}
  onClear={clearBulkSelection}
  onApplied={() => {
    clearBulkSelection();
    void refresh();
  }}
  onPurged={() => {
    clearBulkSelection();
    void refresh();
  }}
  onMoved={() => {
    clearBulkSelection();
    void refresh();
  }}
/>

{#if colFilter !== null && colFilterAttribute !== null}
  {@const fa = colFilterAttribute}
  {@const isCombobox = fa.valueType.startsWith('ref:')}
  {@const multiple = colFilter.values.length > 1}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={colFilterPopup}
    class="kf-float-anchor z-50 flex w-72 flex-col gap-2 rounded-md border border-border bg-bg p-3 shadow-lg"
    role="dialog"
    aria-label="Filter {fa.label}"
    tabindex="-1"
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

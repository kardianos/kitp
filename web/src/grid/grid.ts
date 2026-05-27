/**
 * Grid (table) control — a dense, sortable table over tasks.
 *
 * Renders the v1 column set (mock-inbox.md §Grid + screen-inventory §4):
 *   ID · Title · Status · Assignee · Priority · Milestone · Component · Tags ·
 *   Due · Created · Last activity
 *
 * Data flow (ALL declarative — no promises, no `await`, no `call(...)` in any
 * control body; the DataController owns every async outcome):
 *   - static query `tasks`      → card.select_with_attributes (card_type_name
 *     'task', parent = scope.projectId), carrying `order` from the sort state
 *     and `where` from the filter. Result → method 'landTasks' → 'grid.tasks'.
 *   - lookup queries `persons` / `statuses` / `milestones` / `components` /
 *     `tags` → card.select_with_attributes per card type, each landing a label
 *     map at a tree path the cells read for resolution (assignee/status/
 *     milestone/component names, tag chips).
 *
 * Sortable headers: clicking a sortable header cycles asc → desc → off
 * (`cycleSort`) and re-issues the tasks query with the new `order`
 * (`buildOrderClauses` over `effectiveSort`). The grid bumps a single
 * `grid.queryVersion` tree leaf to refire the `{ signal }`-triggered tasks
 * query — a ONE-WAY write outside any tracked effect, so the cascade-safety
 * rules hold (the query effect reads only the version leaf; the input resolver
 * peeks sort/filter/scope at fire time).
 *
 * Rows render through the recycling `virtualList`: the table BODY is the scroll
 * viewport, the sticky header sits OUTSIDE it (so it never scrolls), and a fixed
 * pool of row nodes is content-swapped on scroll (no per-row churn → no flash).
 * Because a pooled node is reassigned to a different task on scroll, NO transient
 * per-row state lives on the node — every cell (id/title/status/assignee/…),
 * `data-card-id`, and the resolved card_ref labels are read from the task + the
 * lookup tree paths inside `update(el, task, i)` and re-applied each call. The
 * TagChip control renders one chip per tag in the Tags column. A late-landing
 * lookup re-resolves the visible window because the virtualList's `data()` reads
 * the lookups `tick` leaf (so the single effect re-windows + re-renders).
 *
 * Structural hooks for tests + the later styling pass (NO visual CSS this pass
 * — a concurrent design agent owns styles.css / tokens.css):
 *   - header cells:  `data-grid-header`, `data-sort-field`, `data-sort-dir`
 *   - body rows:     `data-grid-row`, `data-card-id`
 *   - body cells:    `data-grid-col="<field>"` + a `.grid-<kind>` class per kind
 *
 * Deferred (noted as TODO; the lifted helpers make these slot in later):
 *   - per-column filter comboboxes (the ScreenFilterBar Pickers drive filtering
 *     for v1),
 *   - tag-prefix synthetic columns (`tag_prefix:<prefix>`),
 *   - `extra_columns` screen config + column reordering,
 *   - grouping (group_by_attr walk) + bulk selection + infinite scroll.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { QueryBinding } from '../core/data.js';
import type { ApiFault } from '../core/dispatch.js';
import { signal } from '../core/signal.js';
import { virtualList } from '../core/virtual-list.js';
import { navigate, taskUrl } from '../shell/router.js';
import { publishTaskNav } from '../shell/task-nav.js';
import { SPEC } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import type { CardWherePredicate } from '../projects/project-helpers.js';
import {
  type Predicate,
  type PredicateLeaf,
  type WireNode,
  isFlatAndOfLeaves,
  toWhereLeaves,
  toWire,
  leaf as makeLeaf,
  topLevelLeafForAttr,
  upsertTopLevelLeaf,
  removeTopLevelLeaf,
} from '../filter/predicate.js';
import { Popover } from '../ui/popover.js';
import {
  buildGridColumns,
  tagPrefixValue,
  buildOrderClauses,
  cycleSort,
  effectiveSort,
  sortStatesFromFilter,
  type FilterSortEntry,
  tagPathLeaf,
  walkGrouped,
  type ColumnDef,
  type GroupAttr,
  type GroupItem,
  type SortState,
} from './grid-helpers.js';
import type { RefAxis } from '../filter/vocabulary.js';
import type { AttrSchema } from '../filter/attribute-schema.js';
import type { RefPicker } from '../ui/ref-picker.js';
import type { DatePicker } from '../ui/datepicker.js';

/**
 * Fixed virtual-list row height (px). Matches the compact grid row: one line of
 * 13px data text at 1.3 leading + 2 × --pad-compact-y (0.375rem = 6px) padding,
 * rounded to a clean rhythm. Mirror this in `.grid__row { height }` in
 * styles.css — the virtualList positions rows by this exact px value, so the
 * CSS row height MUST equal it or rows overlap / gap.
 */
const GRID_ROW_HEIGHT = 34;

/** Tree paths the selection model lives at (tree-backed → recycling-safe). */
const SELECTION_PATH = ['grid', 'selection'];
const SELECTION_VERSION_PATH = ['grid', 'selectionVersion'];

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry types.                                */
/* -------------------------------------------------------------------------- */

export interface GridConfig extends BaseControlConfig {
  type: 'Grid';
  /** Tree path the loaded task rows live at. Default 'grid.tasks'. */
  tasksPath?: string;
  /** Mount an OWN ScreenFilterBar above the table (standalone use only).
   *  Default false: under ScreenHost the shared bar is provided once, so the
   *  Grid does not mount its own — otherwise the screen shows two bars. */
  filterBar?: boolean;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    Grid: GridConfig;
  }
}

/** A card_ref label lookup: stringified id → display label. */
type LabelMap = Record<string, string>;

/* -------------------------------------------------------------------------- */
/* Grid control.                                                               */
/* -------------------------------------------------------------------------- */

export class Grid extends Control<GridConfig> {
  /**
   * The DATA-DRIVEN column set (#17): ID/Title + ref columns from the schema
   * axes + tag-prefix + Tags + the screen's extra_columns + Created/Last-
   * activity. Computed from `screen.refAxes` / `screen.attrSchema` /
   * `screen.extraColumns` / `screen.tagPrefixColumns`; the table rebuilds when
   * the column KEY changes (rare — once when the schema + screen config land).
   */
  private columns: ColumnDef[] = [];
  /** The current column key (`key|key|…`) so a rebuild only fires on a real change. */
  private columnsKey = '';
  /** The header row element (children rebuilt on a column change). */
  private headerEl: HTMLElement | null = null;
  /** The persistent select-all header cell (kept across column rebuilds). */
  private selectAllCell: HTMLElement | null = null;
  /** Per-column header sort handles, keyed by col.key (sortable columns only). */
  private headerCells = new Map<string, { cell: HTMLElement; arrow: HTMLElement; field: string }>();
  /** Per-column filter funnels (ref columns) + the popovers, rebuilt with the header. */
  private headerFilters: Array<{ funnel: HTMLElement; attr: string }> = [];
  private headerPopovers: Popover[] = [];
  /** The body (virtualList viewport) + the live list handle (recreated on rebuild). */
  private bodyEl: HTMLElement | null = null;
  private vlHandle: { dispose: () => void } | null = null;
  /** The table element — its inline `--grid-cols` is computed from this.columns
   *  + per-column widths (#28), so the CSS grid tracks match the dynamic set. */
  private tableEl: HTMLElement | null = null;
  /** Width drag-in-flight (key + px), flushed to columnConfig.widths on pointerup. */
  private pendingResize: { key: string; px: number } | null = null;

  /**
   * In-flight inline cell edit (#30): the editor child lives inside `cell`,
   * which is a POOLED virtualList cell. fillCell guards against clobbering it
   * while the card under that cell is unchanged, and tears it down if the row
   * recycles to a different card before the edit commits.
   */
  private editing: { cardId: string; key: string; cell: HTMLElement; child: Control | null } | null = null;

  /** Active header-click sort; null = server default (ORDER BY c.id). */
  private sort: SortState | null = null;

  /**
   * Active group-by attr (resolved from the GROUP picker's `screen.group`
   * value), or null for a flat list. Drives BOTH the wire `order[]` (the group
   * key is prepended so rows arrive bucketed) and the body's flat
   * header+row item model the virtualList renders.
   */
  private group: GroupAttr | null = null;

  /**
   * Direction of the group sort key (asc/desc of the group attr). A group-header
   * click flips it — which flips the first wire `order[]` key's direction, so
   * the next response reverses bucket order; within-group row order stays the
   * column sort. Reset to 'asc' whenever the group attr itself changes.
   */
  private groupDir: 'asc' | 'desc' = 'asc';

  private get tasksPath(): string[] {
    return (this.config.tasksPath ?? 'grid.tasks').split('.');
  }

  /**
   * CLASS-STATIC query table. The instance config is merged on top.
   *
   * The tasks query carries `order` (from the sort state) and `where` (from the
   * filter) — both resolved at fire time from tree leaves the grid maintains.
   * It re-fires whenever `grid.queryVersion` changes (scope switch, header sort,
   * filter edit all bump it). The five lookup queries refire on project switch
   * and land label maps the cells read.
   */
  static override queries: readonly QueryBinding[] = [
    {
      name: 'tasks',
      spec: SPEC.selectWithAttributes,
      // One trigger leaf the grid bumps for scope / sort / filter changes.
      when: { signal: 'grid.queryVersion' },
      input: {
        cardTypeName: { lit: 'task' },
        parentCardId: { from: 'scope.projectId' },
        order: { from: 'grid.order' },
        where: { from: 'grid.where' },
        tree: { from: 'grid.tree' },
      },
      // Stay idle until a project scope resolves — no cross-project flash on
      // the initial (scope=null) fire. The { signal } trigger refires once a
      // project is picked (the grid bumps queryVersion on scope change too).
      skipWhenNull: ['parentCardId'],
      result: { method: 'landTasks' },
      onError: 'self',
    },
    {
      name: 'persons',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'person' } },
      result: { method: 'landPersons' },
      onError: 'self',
    },
    {
      name: 'statuses',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'status' }, parentCardId: { from: 'scope.projectId' } },
      skipWhenNull: ['parentCardId'],
      result: { method: 'landStatuses' },
      onError: 'self',
    },
    {
      name: 'milestones',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'milestone' }, parentCardId: { from: 'scope.projectId' } },
      skipWhenNull: ['parentCardId'],
      result: { method: 'landMilestones' },
      onError: 'self',
    },
    {
      name: 'components',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'component' }, parentCardId: { from: 'scope.projectId' } },
      skipWhenNull: ['parentCardId'],
      result: { method: 'landComponents' },
      onError: 'self',
    },
    {
      name: 'tags',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'tag' }, parentCardId: { from: 'scope.projectId' } },
      skipWhenNull: ['parentCardId'],
      result: { method: 'landTags' },
      onError: 'self',
    },
  ];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'grid';
    el.dataset.control = 'Grid';
    el.tabIndex = -1;
    return el;
  }

  protected render(): void {
    this.registerResultHandlers();

    // Seed the query-driver leaves BEFORE the data layer wires (mount() wires
    // after render). order/where start empty; queryVersion starts at 0. These
    // are plain seeds — the Object.is gate makes re-seeding a no-op.
    this.ctx.tree.at(['grid', 'order']).set([]);
    this.ctx.tree.at(['grid', 'where']).set(undefined);
    this.ctx.tree.at(['grid', 'tree']).set(undefined);
    const versionNode = this.ctx.tree.at(['grid', 'queryVersion']);
    if (versionNode.peek<number>() === undefined) versionNode.set(0);
    // groupVersion: a body-only re-walk trigger the group effect + group-dir
    // flip bump; the virtualList's data() reads it so the flat item model
    // re-derives without re-issuing the tasks query.
    const groupVersionNode = this.ctx.tree.at(['grid', 'groupVersion']);
    if (groupVersionNode.peek<number>() === undefined) groupVersionNode.set(0);

    // Bulk-selection model: a Set<string> of stringified card ids in the TREE
    // (so the recycling row `update` reads it to render each row's checked
    // state — NEVER node-resident state). The version leaf is bumped on every
    // selection change so the virtualList re-windows + the BulkActionBar's
    // count/visibility effect re-runs. Seed both BEFORE the data layer wires.
    const selectionNode = this.ctx.tree.at(SELECTION_PATH);
    if (!(selectionNode.peek() instanceof Set)) selectionNode.set(new Set<string>());
    const selectionVersionNode = this.ctx.tree.at(SELECTION_VERSION_PATH);
    if (selectionVersionNode.peek<number>() === undefined) selectionVersionNode.set(0);

    /* ------------------------------ filter bar ----------------------------- */
    // Default: rely on the shared ScreenFilterBar that ScreenHost mounts above
    // the body (same as Kanban). Only mount an own bar for standalone use.
    if (this.config.filterBar === true) {
      const barHost = document.createElement('div');
      barHost.className = 'grid__filterbar';
      this.el.append(barHost);
      this.spawn('ScreenFilterBar', { type: 'ScreenFilterBar' }, barHost);
    }

    /* -------------------------------- fault -------------------------------- */
    const fault = document.createElement('div');
    fault.className = 'grid__fault';
    fault.style.display = 'none';
    this.el.append(fault);

    // The "Columns" chooser (show/hide + reorder) now lives on the filter bar's
    // View row via the GridColumns viewAction (viewActionsForLayout('grid')); it
    // writes the same `screen.columnConfig` leaf the `grid.columns` effect below
    // watches, so the table still rebuilds on a change — no in-body toolbar.

    /* ------------------------------- table --------------------------------- */
    // The table is a column: a NON-scrolling sticky header, then the body which
    // is the virtualList scroll VIEWPORT (the recycling pool lives inside it).
    const table = document.createElement('div');
    this.tableEl = table;
    table.className = 'grid__table';
    table.dataset.gridTable = '';
    table.setAttribute('role', 'table');

    // Data-driven columns (#17): compute the initial set, then build the header
    // (a persistent select-all cell + the per-column cells rebuilt on change).
    this.columns = this.computeColumns();
    this.columnsKey = columnKey(this.columns);
    const header = document.createElement('div');
    header.className = 'grid__header';
    header.dataset.gridHeaderRow = '';
    header.setAttribute('role', 'row');
    this.headerEl = header;
    this.selectAllCell = this.buildSelectAllCell();
    header.append(this.selectAllCell);
    this.renderHeaderCells();
    table.append(header);

    // The body is the scroll viewport handed to virtualList. It must be a
    // sized, positioned, overflow:auto box — the CSS gives it flex:1 +
    // min-height:0 so it fills the remaining table height (layout fix #6 makes
    // the whole grid column reach the viewport bottom). It scrolls BOTH axes:
    // the virtualList recycles rows vertically; horizontal overflow (issue #15)
    // appears when the columns are wider than the viewport. `.scroll-x` +
    // `.scroll-y` give it the visible styled scrollbars on both axes.
    const body = document.createElement('div');
    body.className = 'grid__body scroll-y scroll-x';
    body.dataset.gridBody = '';
    body.setAttribute('role', 'rowgroup');
    this.bodyEl = body;
    table.append(body);

    // Keep the (outside-the-scroller) header column-aligned with the body under
    // HORIZONTAL scroll: a plain DOM scroll listener pans the header by the
    // body's scrollLeft. DOM-only — it writes no tracked signal, so the signal
    // cascade rules hold (it never re-triggers an effect). `listen` ties the
    // listener lifetime to this control's teardown.
    this.listen(body, 'scroll', () => {
      header.style.transform = `translateX(${-body.scrollLeft}px)`;
    });

    const empty = document.createElement('div');
    empty.className = 'grid__empty muted';
    empty.dataset.gridEmpty = '';
    empty.textContent = 'No tasks match this filter.';
    empty.style.display = 'none';
    table.append(empty);

    this.el.append(table);

    /* --------------------------- bulk-action bar --------------------------- */
    // The selection-driven bulk surface. It reads the SAME grid.selection /
    // grid.selectionVersion leaves the rows write, so it stays in lock-step;
    // it owns the assign / move / purge writes + the clear gesture. Mounted as
    // a child (parent owns teardown).
    const bulkHost = document.createElement('div');
    bulkHost.className = 'grid__bulkbar';
    this.el.append(bulkHost);
    this.spawn('BulkActionBar', { type: 'BulkActionBar' }, bulkHost);

    /* ------------------------------ reactivity ----------------------------- */
    const tasksNode = this.ctx.tree.at(this.tasksPath);

    // Inline self-represented load fault (onError: 'self' on the reads).
    this.effect(() => {
      const f = this.fault.get();
      if (!f) {
        fault.style.display = 'none';
        fault.textContent = '';
        return;
      }
      fault.style.display = '';
      fault.textContent = `Failed to load grid: ${describeFault(f)}`;
    }, 'grid.fault');

    // Empty-state toggle reads only the tasks leaf (cascade-safe).
    this.effect(() => {
      const rows = (tasksNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
      empty.style.display = rows.length === 0 ? '' : 'none';
    }, 'grid.empty');

    // Rows render through the recycling virtualList: `body` is the scroll
    // viewport, a fixed pool of row nodes is content-swapped on scroll (no
    // churn → no flash). The list renders a FLAT `GroupItem` sequence — either
    // plain rows (no grouping) or `[{kind:'group'}, {kind:'row'}, …]` when a
    // group-by attr is active (see walkGrouped). Both shapes are one
    // fixed-height slot each, so virtualization + recycling are intact; the
    // single pooled-node `update` discriminates header vs data row.
    //
    // `data()` reads the tasks leaf reactively AND the lookups `tick` + the
    // group `version` leaves so a late-landing lookup re-resolves cell + group
    // labels, and a GROUP picker change re-windows. `create(el)` builds the
    // (overlapping) header + data-row shells ONCE per pooled node; the
    // `update` toggles which is shown. NO key: a row's CONTENT changes while
    // its id + slot index stay fixed when a card_ref lookup lands late (the
    // tick bumps), so update() runs for every visible slot on each render.
    this.createVirtualList();
    this.onDestroy(() => this.vlHandle?.dispose());
    this.onDestroy(() => {
      for (const p of this.headerPopovers) p.destroy();
    });

    // Single header-sort effect (replaces per-column effects so a column rebuild
    // can't leak them): repaints every header cell's arrow on a sort / group-dir
    // change. Reads the sort signal + group version; writes only DOM.
    this.effect(() => {
      this.sortSignal.get();
      this.ctx.tree.at(['grid', 'groupVersion']).get();
      this.paintHeaderSort();
    }, 'grid.headerSort');

    // Repaint the per-column filter funnels' active state whenever the predicate
    // changes (from a funnel, a quick chip, the Advanced editor, …). One-way.
    this.effect(() => {
      this.ctx.tree.at(['screen', 'predicate']).get();
      this.paintHeaderFilters();
    }, 'grid.headerFilters');

    // Rebuild the columns when the data-driven inputs land / change (#17): the
    // schema axes the bar publishes + the screen's extra_columns / tag_prefix_
    // columns the ScreenHost lands. Reads those leaves; rebuilds header + list
    // only when the column KEY actually changes. One-way — cascade-safe.
    this.effect(() => {
      this.ctx.tree.at(['screen', 'refAxes']).get();
      this.ctx.tree.at(['screen', 'attrSchema']).get();
      this.ctx.tree.at(['screen', 'extraColumns']).get();
      this.ctx.tree.at(['screen', 'tagPrefixColumns']).get();
      this.ctx.tree.at(['screen', 'columnConfig']).get(); // hide/reorder/widths
      this.rebuildColumns();
      this.applyGridCols(); // dynamic grid tracks (also picks up width-only changes)
    }, 'grid.columns');

    /* -------------------- one-way query-version drivers -------------------- */
    // Bump the tasks query version whenever scope or the filter search change.
    // These effects read ONLY the leaf they watch and write ONLY the version /
    // where leaves (never back into a watched dep) — one-way loads, cascade-safe.
    this.effect(() => {
      this.ctx.tree.at(['scope', 'projectId']).get(); // subscribe
      this.bumpQuery();
    }, 'grid.scopeWatch');

    // Search + the structured Advanced predicate both narrow the task query.
    // This effect reads BOTH leaves and projects them to the `where[]` / `tree`
    // query inputs, then bumps the query version. One-way: reads search +
    // predicate, writes only where/tree/version (never a watched dep) — the same
    // cascade-safe shape as the legacy applySearch.
    this.effect(() => {
      const search = this.ctx.tree.at(['screen', 'search']).get<string>() ?? '';
      const predicate = this.ctx.tree.at(['screen', 'predicate']).get<Predicate | null>() ?? null;
      this.applyFilter(search, predicate);
      this.bumpQuery();
    }, 'grid.filterWatch');

    // The view's "Sort by" (`screen.sort`, from the filter builder) → the wire
    // `order[]`. A header click still overrides it (effectiveSort). One-way:
    // reads screen.sort, writes only grid.order + the query version.
    this.effect(() => {
      this.ctx.tree.at(['screen', 'sort']).get(); // subscribe
      this.applyOrder();
      this.bumpQuery();
    }, 'grid.sortWatch');

    // GROUP picker → group-by attr. Reads the RESOLVED `screen.groupAxis`
    // ({attr, lookup} | null) the ScreenFilterBar derives from the data-driven
    // schema (replacing the retired hardcoded group-value switch), and writes
    // the group state + the wire `order[]` (group key prepended so rows arrive
    // bucketed) + bumps the query version. One-way: never reads back a dep it
    // writes — same cascade-safe shape as the sort/filter watchers.
    this.effect(() => {
      const next = this.ctx.tree.at(['screen', 'groupAxis']).get<GroupAttr | null>() ?? null;
      // A fresh group column resets the direction so the toggle is predictable.
      if ((next?.attr ?? null) !== (this.group?.attr ?? null)) this.groupDir = 'asc';
      this.group = next;
      this.applyOrder();
      this.bumpGroup();
      this.bumpQuery();
    }, 'grid.groupWatch');

    // Refetch when a task is created anywhere (quick-entry bumps
    // `tasks.createdNonce`), so a newly-added task shows up without a manual
    // re-search (#3). One-way: reads the nonce, bumps the query version (a
    // different leaf the tasks query watches) — cascade-safe.
    this.effect(() => {
      const nonce = this.ctx.tree.at(['tasks', 'createdNonce']).get<number>() ?? 0;
      if (nonce > 0) this.bumpQuery();
    }, 'grid.refreshOnCreate');
  }

  /* ----------------------------- result sinks --------------------------- */

  /** Register the decode → tree-write sinks for the tasks + lookup queries. */
  private registerResultHandlers(): void {
    this.handler('landTasks', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      this.ctx.tree.at(this.tasksPath).set(rows);
    });

    // Each lookup lands a stringified-id → label map at grid.lookups.<name>,
    // then bumps a single `tick` leaf so the row reconciler re-resolves cells.
    const landLabels = (name: string, labelOf: (r: CardWithAttrs) => string) => (out: unknown) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const map: LabelMap = {};
      for (const r of rows) map[r.id.toString()] = labelOf(r);
      this.ctx.tree.at(['grid', 'lookups', name]).set(map);
      this.tickLookups();
    };

    this.handler('landPersons', landLabels('persons', titleAttr));
    this.handler('landStatuses', landLabels('statuses', titleOrName));
    this.handler('landMilestones', landLabels('milestones', titleOrName));
    this.handler('landComponents', landLabels('components', titleOrName));
    this.handler('landTags', landLabels('tags', (r) => {
      const p = r.attributes['path'];
      return typeof p === 'string' && p.length > 0 ? p : `#${r.id.toString()}`;
    }));
  }

  /** Bump the lookup tick so the virtualList's effect re-runs (re-windowing +
   *  re-resolving the visible cells' card_ref labels). */
  private tickLookups(): void {
    const node = this.ctx.tree.at(['grid', 'lookups', 'tick']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /* ------------------------------ selection ------------------------------- */

  /**
   * The selection model is a `Set<string>` of stringified card ids living in
   * the TREE (`grid.selection`). It is the SINGLE source of truth: the row
   * `update` reads it to render each pooled node's checkbox (recycling-safe —
   * no per-node selection state), the header select-all reads it, and the
   * BulkActionBar reads it for its count + the operations. Every mutation bumps
   * `grid.selectionVersion` (a one-way write outside any tracked effect, so the
   * cascade rules hold) which re-windows the virtualList + repaints the header.
   */
  private selection(): Set<string> {
    const s = this.ctx.tree.at(SELECTION_PATH).peek<Set<string>>();
    return s instanceof Set ? s : new Set<string>();
  }

  /** Is a card id currently selected? (Peek — callers read it inside fillRow.) */
  private isSelected(id: bigint): boolean {
    return this.selection().has(id.toString());
  }

  /** Replace the selection set + bump the version. One-way, cascade-safe. */
  private setSelection(next: Set<string>): void {
    this.ctx.tree.at(SELECTION_PATH).set(next);
    const node = this.ctx.tree.at(SELECTION_VERSION_PATH);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /** Toggle one row's selection by its live `data-card-id` (never node state). */
  private toggleRowSelection(el: HTMLElement): void {
    const idStr = el.dataset.cardId;
    if (idStr === undefined || idStr === '') return;
    const next = new Set(this.selection());
    if (next.has(idStr)) next.delete(idStr);
    else next.add(idStr);
    this.setSelection(next);
  }

  /** All loaded task ids (stringified) — the select-all universe. */
  private allTaskIds(): string[] {
    const tasks = (this.ctx.tree.at(this.tasksPath).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    return tasks.map((t) => t.id.toString());
  }

  /** Header tri-state over the loaded tasks: 'none' | 'some' | 'all'. */
  private selectAllState(): 'none' | 'some' | 'all' {
    const ids = this.allTaskIds();
    if (ids.length === 0) return 'none';
    const sel = this.selection();
    let hits = 0;
    for (const id of ids) if (sel.has(id)) hits += 1;
    if (hits === 0) return 'none';
    return hits === ids.length ? 'all' : 'some';
  }

  /** Select every loaded task, or clear when already all-selected. */
  private toggleSelectAll(): void {
    if (this.selectAllState() === 'all') {
      this.setSelection(new Set<string>());
      return;
    }
    const next = new Set(this.selection());
    for (const id of this.allTaskIds()) next.add(id);
    this.setSelection(next);
  }

  /* ------------------------------- header ------------------------------- */

  /** The full data-driven column set from the schema + screen config (#17),
   *  BEFORE the user's per-screen hide/reorder (the Columns menu edits that). */
  private rawColumns(): ColumnDef[] {
    const refAxes = (this.ctx.tree.at(['screen', 'refAxes']).peek<RefAxis[]>() ?? []) as RefAxis[];
    const schema = (this.ctx.tree.at(['screen', 'attrSchema']).peek<AttrSchema[]>() ?? []) as AttrSchema[];
    const extra = (this.ctx.tree.at(['screen', 'extraColumns']).peek<string[]>() ?? []) as string[];
    const tagPrefixes = (this.ctx.tree.at(['screen', 'tagPrefixColumns']).peek<string[]>() ?? []) as string[];
    return buildGridColumns(refAxes, schema, extra, tagPrefixes);
  }

  /** Read the user's per-screen column config (hidden keys + order + widths). */
  private columnConfig(): { hidden: string[]; order: string[]; widths: Record<string, number> } {
    const c =
      this.ctx.tree
        .at(['screen', 'columnConfig'])
        .peek<{ hidden?: string[]; order?: string[]; widths?: Record<string, number> }>() ?? {};
    return { hidden: c.hidden ?? [], order: c.order ?? [], widths: c.widths ?? {} };
  }

  /** Default CSS grid track for a column kind (a width / minmax for flex cols). */
  private defaultTrack(col: ColumnDef): string {
    switch (col.kind) {
      case 'id':
        return '4.5rem';
      case 'title':
        return 'minmax(12rem, 2fr)';
      case 'tags':
        return 'minmax(9rem, 1fr)';
      case 'ref':
        return '9rem';
      case 'tag_prefix':
        return '6.5rem';
      case 'date':
        return '7rem';
      case 'created':
      case 'last_activity':
        return '7.5rem';
      default:
        return '8rem';
    }
  }

  /** Compute the `grid-template-columns` value: a fixed select track + one track
   *  per column (a persisted px width, or the kind default). `liveKey`/`livePx`
   *  override one column's track during a resize drag (no leaf write per move). */
  private colsString(liveKey?: string, livePx?: number): string {
    const widths = this.columnConfig().widths;
    const tracks = this.columns.map((c) => {
      if (c.key === liveKey && livePx !== undefined) return `${Math.max(48, Math.round(livePx))}px`;
      const w = widths[c.key];
      return typeof w === 'number' ? `${Math.max(48, w)}px` : this.defaultTrack(c);
    });
    return ['2.25rem', ...tracks].join(' ');
  }

  /** Set the table's inline `--grid-cols` (guarded — the minimal test DOM shim
   *  has no CSSStyleDeclaration.setProperty). */
  private setGridCols(value: string): void {
    const style = this.tableEl?.style as { setProperty?: (k: string, v: string) => void } | undefined;
    if (style !== undefined && typeof style.setProperty === 'function') {
      style.setProperty('--grid-cols', value);
    }
  }

  /** Set the table's inline `--grid-cols` from the current columns + widths (#28). */
  private applyGridCols(): void {
    this.setGridCols(this.colsString());
  }

  /** Begin a header-edge resize drag for `col`. */
  private startColumnResize(e: PointerEvent, col: ColumnDef): void {
    e.preventDefault();
    e.stopPropagation();
    const cell = this.headerCells.get(col.key)?.cell ?? null;
    const startW = cell?.getBoundingClientRect?.().width ?? 120;
    const startX = e.clientX;
    const onMove = (ev: PointerEvent): void => {
      const px = Math.max(48, Math.round(startW + (ev.clientX - startX)));
      this.pendingResize = { key: col.key, px };
      this.setGridCols(this.colsString(col.key, px));
    };
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (this.pendingResize !== null) {
        const cfg = this.columnConfig();
        const widths = { ...cfg.widths, [this.pendingResize.key]: this.pendingResize.px };
        this.pendingResize = null;
        this.ctx.tree.at(['screen', 'columnConfig']).set({ ...cfg, widths });
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  /** The VISIBLE, ordered column set = rawColumns minus hidden, sorted by the
   *  user's order (configured keys first, the rest trailing in natural order). */
  private computeColumns(): ColumnDef[] {
    const all = this.rawColumns();
    const { hidden, order } = this.columnConfig();
    const hide = new Set(hidden);
    const visible = all.filter((c) => !hide.has(c.key));
    if (order.length === 0) return visible;
    const rank = (k: string): number => {
      const i = order.indexOf(k);
      return i >= 0 ? i : order.length + all.findIndex((c) => c.key === k);
    };
    return visible.slice().sort((a, b) => rank(a.key) - rank(b.key));
  }

  /** Rebuild the header cells + the recycling list when the column key changes. */
  private rebuildColumns(): void {
    const next = this.computeColumns();
    const key = columnKey(next);
    if (key === this.columnsKey) return;
    this.columns = next;
    this.columnsKey = key;
    this.renderHeaderCells();
    this.createVirtualList();
  }

  /** (Re)build the per-column header cells, REUSING the persistent select-all
   *  cell (so its tri-state effect stays intact across a column rebuild). */
  private renderHeaderCells(): void {
    const head = this.headerEl;
    if (head === null) return;
    this.headerCells.clear();
    this.headerFilters = [];
    for (const p of this.headerPopovers) p.destroy();
    this.headerPopovers = [];
    const cells: HTMLElement[] = [];
    for (const col of this.columns) {
      const { cell, arrow } = this.buildHeaderCell(col);
      cells.push(cell);
      if (col.field !== null) this.headerCells.set(col.key, { cell, arrow, field: col.field });
    }
    // Re-attach the SAME select-all cell + the fresh column cells in one pass.
    if (this.selectAllCell !== null) head.replaceChildren(this.selectAllCell, ...cells);
    else head.replaceChildren(...cells);
    this.paintHeaderSort();
    this.paintHeaderFilters();
  }

  /** Repaint every sortable header cell's arrow from the active sort / group dir. */
  private paintHeaderSort(): void {
    const active = this.sortSignal.peek();
    for (const { cell, arrow, field } of this.headerCells.values()) {
      const isGroupCol = this.group !== null && field === `attributes.${this.group.attr}`;
      const dir = isGroupCol ? this.groupDir : active && active.field === field ? active.direction : null;
      cell.dataset.sortField = field;
      if (dir === null) {
        delete cell.dataset.sortDir;
        arrow.textContent = '';
        cell.setAttribute('aria-sort', 'none');
      } else {
        cell.dataset.sortDir = dir;
        arrow.textContent = dir === 'asc' ? '↑' : '↓';
        cell.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
      }
    }
  }

  /** (Re)create the recycling virtualList over the current columns. */
  private createVirtualList(): void {
    if (this.bodyEl === null) return;
    this.vlHandle?.dispose();
    this.vlHandle = virtualList<GroupItem<CardWithAttrs>>({
      container: this.bodyEl,
      rowHeight: GRID_ROW_HEIGHT,
      data: () => {
        // Read the lookups tick so the list re-renders when a label map lands;
        // the group version so a GROUP / group-dir change re-walks; the selection
        // version so a toggle re-paints the visible checkboxes.
        this.ctx.tree.at(['grid', 'lookups', 'tick']).get();
        this.ctx.tree.at(['grid', 'groupVersion']).get();
        this.ctx.tree.at(SELECTION_VERSION_PATH).get();
        return this.buildItems();
      },
      create: (el) => this.buildRowShell(el),
      update: (el, item) => this.fillItem(el, item),
      name: 'grid.rows',
    });
  }

  /**
   * The leading select-all/none header cell. Tri-state checkbox: checked when
   * every loaded task is selected, indeterminate on a partial selection, off
   * when none. Clicking selects ALL loaded tasks, or clears when already all.
   * Reflects the selection version reactively (recycling-safe — reads the tree
   * set, never node state).
   */
  private buildSelectAllCell(): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'grid__cell grid__head grid-select';
    cell.dataset.gridHeader = '';
    cell.dataset.gridCol = 'select';
    cell.setAttribute('role', 'columnheader');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'grid__select-box';
    box.dataset.gridSelectAll = '';
    box.setAttribute('aria-label', 'Select all rows');
    this.listen(box, 'click', (ev) => {
      ev.stopPropagation();
      this.toggleSelectAll();
    });
    cell.append(box);

    // Repaint the tri-state on every selection change (reads the version leaf).
    this.effect(() => {
      this.ctx.tree.at(SELECTION_VERSION_PATH).get(); // subscribe
      const state = this.selectAllState();
      box.checked = state === 'all';
      box.indeterminate = state === 'some';
    }, 'grid.selectAll');

    return cell;
  }

  /** Build one column header cell. Returns the cell + its arrow span; the sort
   *  arrows are painted by the single `grid.headerSort` effect (so a column
   *  rebuild can't leak per-column effects). */
  private buildHeaderCell(col: ColumnDef): { cell: HTMLElement; arrow: HTMLElement } {
    const cell = document.createElement('div');
    cell.className = `grid__cell grid__head grid-${col.kind}`;
    cell.dataset.gridHeader = '';
    cell.dataset.gridCol = col.field ?? col.key;
    cell.setAttribute('role', 'columnheader');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grid__sort';
    btn.dataset.gridSortButton = '';
    const sortable = col.field !== null;
    btn.disabled = !sortable;

    const label = document.createElement('span');
    label.className = 'grid__head-label';
    label.textContent = col.label;
    btn.append(label);

    const arrow = document.createElement('span');
    arrow.className = 'grid__sort-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    btn.append(arrow);

    cell.append(btn);
    if (sortable) this.listen(btn, 'click', () => this.onHeaderClick(col));

    // Resize grabber on the column's right edge (#28) — drag to set a px width
    // persisted to columnConfig.widths.
    const resize = document.createElement('span');
    resize.className = 'grid__col-resize';
    resize.dataset.gridColResize = col.key;
    resize.setAttribute('aria-hidden', 'true');
    this.listen(resize, 'pointerdown', (e) => this.startColumnResize(e as PointerEvent, col));
    cell.append(resize);

    // Per-column filter funnel — ref columns with an enumerable option list
    // (status / assignee / milestone / component). Toggling values edits a
    // top-level `attr in […]` leaf in `screen.predicate`, which the filter
    // watcher turns into the query `where[]` (the grid refetches).
    if (col.kind === 'ref' && col.targetCardType !== undefined && col.attrName !== null) {
      const funnel = document.createElement('button');
      funnel.type = 'button';
      funnel.className = 'grid__col-filter';
      funnel.dataset.gridColFilter = col.attrName;
      funnel.setAttribute('aria-label', `Filter ${col.label}`);
      funnel.title = `Filter ${col.label}`;
      funnel.textContent = '⏷';
      cell.append(funnel);
      this.headerFilters.push({ funnel, attr: col.attrName });
      this.buildColumnFilterPopover(col, funnel);
    }
    return { cell, arrow };
  }

  /** Anchor a multi-select option Popover to a column's filter funnel. */
  private buildColumnFilterPopover(col: ColumnDef, funnel: HTMLElement): void {
    const pop = new Popover(funnel, {
      placement: 'bottom-start',
      width: 'anchor',
      clampHeight: true,
      onClose: () => funnel.setAttribute('aria-expanded', 'false'),
    });
    pop.element.classList.add('grid__col-filter-panel');
    this.headerPopovers.push(pop);
    this.listen(funnel, 'click', (e) => {
      e.stopPropagation();
      if (pop.isOpen) {
        pop.close();
        return;
      }
      this.renderColumnFilterMenu(col, pop.element);
      funnel.setAttribute('aria-expanded', 'true');
      pop.open();
    });
  }

  /** (Re)render a column filter menu: option checkboxes reflecting the live leaf. */
  private renderColumnFilterMenu(col: ColumnDef, panel: HTMLElement): void {
    const attr = col.attrName ?? '';
    const target = col.targetCardType ?? '';
    const options = (this.ctx.tree.at(['screen', 'predicateOptions']).peek<Record<string, Array<{ value: string; label: string }>>>() ?? {})[target] ?? [];
    const selected = new Set(this.columnFilterValues(attr));
    const list = document.createElement('ul');
    list.className = 'grid__col-filter-list';
    list.setAttribute('role', 'listbox');
    if (options.length === 0) {
      const li = document.createElement('li');
      li.className = 'grid__col-filter-empty muted';
      li.textContent = 'No options';
      list.append(li);
    } else {
      for (const opt of options) {
        const li = document.createElement('li');
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'grid__col-filter-option';
        item.dataset.gridColFilterOption = opt.value;
        const checked = selected.has(opt.value);
        item.setAttribute('aria-selected', checked ? 'true' : 'false');
        if (checked) item.classList.add('grid__col-filter-option--checked');
        item.textContent = `${checked ? '✓ ' : ''}${opt.label}`;
        this.listen(item, 'click', () => {
          this.toggleColumnFilter(attr, opt.value);
          this.renderColumnFilterMenu(col, panel); // repaint checks in place
        });
        li.append(item);
        list.append(li);
      }
    }
    panel.replaceChildren(list);
  }

  /** The selected values for a column's `attr in/eq` leaf in screen.predicate. */
  private columnFilterValues(attr: string): string[] {
    const predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    const leaf = topLevelLeafForAttr(predicate, attr);
    if (leaf === null || (leaf.op !== 'eq' && leaf.op !== 'in')) return [];
    return (leaf.values ?? []).map((v) => String(v));
  }

  /** Toggle one value in a column's filter leaf + write screen.predicate. */
  private toggleColumnFilter(attr: string, value: string): void {
    const cur = this.columnFilterValues(attr);
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    const predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    let updated: Predicate | null;
    if (next.length === 0) {
      updated = removeTopLevelLeaf(predicate, attr);
    } else {
      const newLeaf: PredicateLeaf =
        next.length === 1 ? makeLeaf(attr, 'eq', [next[0]]) : makeLeaf(attr, 'in', next);
      updated = upsertTopLevelLeaf(predicate, newLeaf);
    }
    this.ctx.tree.at(['screen', 'predicate']).set(updated);
  }

  /** Mark each funnel active when its column has a filter leaf (effect-driven). */
  private paintHeaderFilters(): void {
    for (const { funnel, attr } of this.headerFilters) {
      const active = this.columnFilterValues(attr).length > 0;
      funnel.classList.toggle('grid__col-filter--active', active);
    }
  }

  /** Header click: cycle the sort and re-issue the tasks query with the new order. */
  private onHeaderClick(col: ColumnDef): void {
    if (col.field === null) return;
    // Clicking the column the grid is grouped by is the same gesture as
    // clicking its section header: flip the GROUP direction (which flips the
    // first wire `order[]` key, reversing bucket order in the next response).
    // Route both through one path so cycleSort can't write a secondary key
    // that applyOrder would then dedup away.
    if (this.group !== null && col.field === `attributes.${this.group.attr}`) {
      this.toggleGroupDir();
      return;
    }
    const next = cycleSort(this.sort, col.field);
    this.sort = next;
    this.sortSignal.set(next); // repaint header arrows (read in the header effect)
    this.applyOrder();
    this.bumpQuery();
  }

  /**
   * Flip the group sort direction (asc ⇄ desc of the group key). Re-issues the
   * tasks query with the flipped first `order[]` key so the next response
   * reverses bucket order; within-group order keeps the column sort. Wired to
   * both the group-section header click and the group column's table header.
   */
  private toggleGroupDir(): void {
    if (this.group === null) return;
    this.groupDir = this.groupDir === 'asc' ? 'desc' : 'asc';
    this.applyOrder();
    this.bumpGroup(); // repaint header arrows (group column reads the version)
    this.bumpQuery();
  }

  /**
   * Project the effective sort + the active group key to the wire `order[]`.
   * When grouping is active the group attr is the FIRST key (that's what makes
   * rows cluster), at `groupDir`; the header-click sort follows as the
   * within-group order. Dedup the group field so it's never emitted twice.
   */
  private applyOrder(): void {
    const out: SortState[] = [];
    const groupField = this.group !== null ? `attributes.${this.group.attr}` : null;
    if (groupField !== null) out.push({ field: groupField, direction: this.groupDir });
    // The view's persisted sort (`screen.sort`, set by the filter builder's
    // "Sort by") is the default order; a header click overrides it (effectiveSort).
    const filterSort = sortStatesFromFilter(this.readScreenSort());
    for (const s of effectiveSort(this.sort, filterSort)) {
      if (s.field === groupField) continue;
      out.push(s);
    }
    this.ctx.tree.at(['grid', 'order']).set(buildOrderClauses(out));
  }

  /** The view's persisted sort entries from `screen.sort` (peek; the dedicated
   *  effect owns the subscription). Tolerates the `{ attr, dir }` builder shape. */
  private readScreenSort(): FilterSortEntry[] {
    const raw = this.ctx.tree.at(['screen', 'sort']).peek<unknown>();
    if (!Array.isArray(raw)) return [];
    const out: FilterSortEntry[] = [];
    for (const e of raw) {
      if (e !== null && typeof e === 'object') {
        const o = e as Record<string, unknown>;
        const attr = typeof o['attr'] === 'string' ? o['attr'] : '';
        if (attr !== '') out.push({ attr, dir: o['dir'] === 'desc' ? 'desc' : 'asc' });
      }
    }
    return out;
  }

  /** Reactive mirror of `this.sort` so every header cell repaints on a change. */
  private readonly sortSignal = signal<SortState | null>(null, 'grid.sort');

  /* -------------------------------- rows -------------------------------- */

  /**
   * Build a pooled node ONCE (virtualList `create`), never per item. Default
   * shape is a DATA ROW (`.grid__row` + one empty cell per column); a pooled
   * node recycles between a row and a GROUP HEADER as it scrolls, so `fillItem`
   * reconfigures the node IN PLACE when its kind changes (clearing cells →
   * header content, or vice-versa). Keeping `[data-grid-row]` present ONLY in
   * row mode means parked / header slots correctly drop out of the visible-row
   * set. The click listener (wired once) flips the group direction; it's inert
   * unless the node is currently a group header.
   */
  private buildRowShell(el: HTMLElement): void {
    this.makeRowMode(el);
    // Click on a DATA row opens its task detail (`/task/:id`); click on a GROUP
    // header flips the group direction (same gesture as the group column's
    // table header). Wired ONCE; reads the live mode + `data-card-id` (set per
    // fill, never stale). navigate() is a one-way History write outside any
    // tracked effect — cascade-safe.
    this.listen(el, 'click', () => {
      if (el.dataset.gridGroupHeader !== undefined) {
        this.toggleGroupDir();
        return;
      }
      this.openRow(el);
    });
    // Keyboard open: Enter or `o` on the focused row navigates into the task;
    // Space toggles the row's bulk selection (the spreadsheet / Gmail idiom, so
    // a selection can be built with arrow-keys + Space without the mouse).
    this.listen(el, 'keydown', (ev) => {
      if (el.dataset.gridRow === undefined) return;
      const k = (ev as KeyboardEvent).key;
      if (k === 'Enter' || k === 'o') {
        ev.preventDefault();
        this.openRow(el);
      } else if (k === ' ' || k === 'Spacebar' || k === 'Space') {
        ev.preventDefault();
        this.toggleRowSelection(el);
      }
    });
  }

  /** Navigate into a row's task detail (`/task/:id`), reading the live card id.
   *  Publishes the current row order first so task-detail prev/next nav (#18)
   *  walks the same sequence the grid shows. */
  private openRow(el: HTMLElement): void {
    const idStr = el.dataset.cardId;
    if (idStr === undefined || idStr === '') return;
    const tasks = (this.ctx.tree.at(['grid', 'tasks']).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    publishTaskNav(this.ctx.tree, tasks.map((t) => t.id));
    navigate(taskUrl(idStr));
  }

  /** Reset a pooled node to ROW mode: the `.grid__row` cell grid (a leading
   *  select cell + one cell per column). Rebuilds the cell shells only when the
   *  node was previously a header (mode transition). The +1 child is the select
   *  cell; the row's checkbox click handler is wired ONCE here (it reads the
   *  live data-card-id, never stale node state). */
  private makeRowMode(el: HTMLElement): void {
    if (el.dataset.gridRow !== undefined && el.children.length === this.columns.length + 1) return;
    delete el.dataset.gridGroupHeader;
    el.className = 'grid__row';
    el.dataset.gridRow = '';
    el.setAttribute('role', 'row');
    el.tabIndex = 0;
    el.replaceChildren();

    // Leading select cell: a checkbox whose checked state is read from the tree
    // set in fillRow (recycling-safe). The click stops propagation so it never
    // opens the row's task detail, and toggles by the row's live card id.
    const selCell = document.createElement('div');
    selCell.className = 'grid__cell grid-select';
    selCell.dataset.gridCol = 'select';
    selCell.setAttribute('role', 'cell');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'grid__select-box';
    box.dataset.gridSelectRow = '';
    this.listen(box, 'click', (ev) => {
      ev.stopPropagation();
      this.toggleRowSelection(el);
    });
    selCell.append(box);
    el.append(selCell);

    for (const col of this.columns) {
      const cell = document.createElement('div');
      cell.className = `grid__cell grid-${col.kind}`;
      cell.dataset.gridCol = col.field ?? col.key;
      cell.setAttribute('role', 'cell');
      // Inline edit (#30): double-click an editable cell to edit in place. The
      // col is captured per pooled cell; the card id is read live off the row.
      if (isEditableCol(col)) {
        cell.classList.add('grid__cell--editable');
        this.listen(cell, 'dblclick', (ev) => {
          ev.stopPropagation();
          const cardId = el.dataset.cardId;
          if (cardId !== undefined && cardId !== '') this.beginCellEdit(cardId, col, cell);
        });
      }
      el.append(cell);
    }
  }

  /** Reconfigure a pooled node to GROUP-HEADER mode: a single full-width header
   *  with an arrow (group dir), label, and `· count`. Rebuilds only on the
   *  transition out of row mode; subsequent header fills reuse the children. */
  private makeHeaderMode(el: HTMLElement): void {
    if (el.dataset.gridGroupHeader !== undefined) return;
    delete el.dataset.gridRow;
    delete el.dataset.cardId;
    el.className = 'grid__group-header';
    el.dataset.gridGroupHeader = '';
    el.setAttribute('role', 'row');
    el.tabIndex = 0;
    el.replaceChildren();
    const arrow = document.createElement('span');
    arrow.className = 'grid__group-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'grid__group-label';
    const count = document.createElement('span');
    count.className = 'grid__group-count muted';
    el.append(arrow, label, count);
  }

  /** Discriminate a flat GroupItem onto a pooled node: header content for a
   *  `group` item, the data-row cells for a `row` item. */
  private fillItem(el: HTMLElement, item: GroupItem<CardWithAttrs>): void {
    if (item.kind === 'group') {
      this.makeHeaderMode(el);
      el.dataset.groupKey = item.key;
      el.dataset.groupDir = this.groupDir;
      const [arrow, label, count] = el.children as unknown as HTMLElement[];
      if (arrow) arrow.textContent = this.groupDir === 'asc' ? '↑' : '↓';
      if (label) label.textContent = item.label;
      if (count) count.textContent = `· ${item.count}`;
    } else {
      this.makeRowMode(el);
      this.fillRow(el, item.row);
    }
  }

  /**
   * Swap a pooled row's content for `row`. Sets `data-card-id` from the task
   * (NOT node state) and repopulates every cell, re-resolving card_ref labels
   * from the lookup tree paths. Called every time the slot shows a different
   * task (and whenever the lookups tick re-renders the window). Cells are
   * cleared + rebuilt in place — the cell shells from `makeRowMode` persist.
   */
  private fillRow(el: HTMLElement, row: CardWithAttrs): void {
    el.dataset.cardId = row.id.toString();
    const cells = el.children;
    // Cell 0 is the leading select cell — render its checked state from the
    // TREE set (recycling-safe: a pooled node shows a different task on scroll,
    // so the checkbox is re-read here every fill, never carried on the node).
    const selCell = cells[0] as HTMLElement | undefined;
    if (selCell) {
      const box = selCell.children[0] as (HTMLElement & { checked?: boolean }) | undefined;
      if (box) box.checked = this.isSelected(row.id);
      // Mark the row's selected state for styling + tests.
      if (this.isSelected(row.id)) el.dataset.selected = '';
      else delete el.dataset.selected;
    }
    // Data cells follow the select cell (offset by 1).
    for (let i = 0; i < this.columns.length; i++) {
      const cell = cells[i + 1] as HTMLElement | undefined;
      if (!cell) continue;
      this.fillCell(cell, row, this.columns[i]!);
    }
  }

  /**
   * Build the flat item sequence the virtualList renders. No group → plain rows
   * (unchanged behaviour). A group attr active → walk the (server-ordered)
   * tasks into `[{kind:'group'}, {kind:'row'}, …]` via walkGrouped, resolving
   * card_ref group keys to their display label through the matching lookup map.
   */
  private buildItems(): GroupItem<CardWithAttrs>[] {
    const tasks = (this.ctx.tree.at(this.tasksPath).get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    const g = this.group;
    if (g === null) return walkGrouped(tasks, null, () => '');
    return walkGrouped(tasks, g.attr, (key) => this.labelForGroupKey(key, g.lookup));
  }

  /** Resolve a group key to its display label: a card_ref bigint goes through
   *  the group attr's lookup map; scalars are their own label. */
  private labelForGroupKey(key: unknown, lookup: string | null): string {
    if (typeof key === 'bigint' && lookup !== null) {
      const map = (this.ctx.tree.at(['grid', 'lookups', lookup]).peek<LabelMap>() ?? {}) as LabelMap;
      const k = key.toString();
      return map[k] ?? `#${k}`;
    }
    return String(key);
  }

  /** Repopulate one cell for a task + column, resolving ref labels from lookups. */
  private fillCell(cell: HTMLElement, row: CardWithAttrs, col: ColumnDef): void {
    // Inline-edit guard (#30): if this pooled cell holds the active editor and
    // still shows the same card+column, leave the editor in place. If the row
    // recycled to a different card/column, end the edit before re-rendering.
    if (this.editing !== null && this.editing.cell === cell) {
      if (this.editing.cardId === row.id.toString() && this.editing.key === col.key) return;
      this.cancelCellEdit();
    }
    // Clear prior content (this slot may have shown another task before).
    cell.replaceChildren();
    switch (col.kind) {
      case 'id':
        cell.textContent = `#${row.id.toString()}`;
        break;
      case 'title':
        cell.textContent = strAttr(row, 'title') ?? '(untitled)';
        break;
      case 'ref':
        // A single card_ref attr: resolve its id via the target type's lookup.
        this.setRefCell(cell, row, col.attrName ?? '', col.lookup ?? '');
        break;
      case 'tag_prefix': {
        // Synthetic column: the tag value after `<prefix>/` (e.g. priority/high
        // → "high"), shown as a tone pill; em-dash when no matching tag.
        const value = this.tagPrefixCell(row, col.prefix ?? '');
        if (value === null) {
          dash(cell);
        } else {
          const pill = document.createElement('span');
          pill.className = 'grid__pill';
          pill.dataset.priority = value;
          pill.textContent = value;
          cell.append(pill);
        }
        break;
      }
      case 'tags':
        this.setTagsCell(cell, row);
        break;
      case 'date':
        cell.textContent = dateAttr(row.attributes[col.attrName ?? '']) ?? '—';
        break;
      case 'attr': {
        // A scalar attribute (text / number) rendered as its string value.
        const v = row.attributes[col.attrName ?? ''];
        if (v === null || v === undefined || v === '') dash(cell);
        else cell.textContent = typeof v === 'bigint' ? v.toString() : String(v);
        break;
      }
      case 'created':
        cell.textContent = dateAttr(topLevel(row, 'created_at')) ?? '—';
        break;
      case 'last_activity':
        cell.textContent = dateAttr(topLevel(row, 'last_activity_at')) ?? '—';
        break;
    }
  }

  /** Find a loaded task row by its stringified id, or null. */
  private taskById(cardId: string): CardWithAttrs | null {
    const tasks = (this.ctx.tree.at(this.tasksPath).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    return tasks.find((t) => t.id.toString() === cardId) ?? null;
  }

  /**
   * Begin an inline edit of one cell (#30): swap the read-mode cell content for
   * the kind-appropriate editor (RefPicker for `ref`, DatePicker for `date`,
   * plain input for scalar `attr`). Selection commits via the editor's callback;
   * the input commits on Enter/blur and cancels on Escape.
   */
  private beginCellEdit(cardId: string, col: ColumnDef, cell: HTMLElement): void {
    // Only one edit at a time; finish (revert) any prior one first.
    this.cancelCellEdit();
    const attr = col.attrName;
    if (attr === null || attr === undefined) return;
    const row = this.taskById(cardId);
    if (row === null) return;
    const cur = row.attributes[attr];

    cell.replaceChildren();
    cell.classList.add('grid__cell--editing');
    let child: Control | null = null;
    const commit = (value: unknown): void => this.commitCellEdit(cardId, attr, value);

    if (col.kind === 'ref') {
      const map = (this.ctx.tree.at(['grid', 'lookups', col.lookup ?? '']).peek<LabelMap>() ?? {}) as LabelMap;
      const value = typeof cur === 'bigint' ? cur : null;
      const rp = this.spawn(
        'RefPicker',
        {
          type: 'RefPicker',
          cardType: col.targetCardType ?? 'card',
          value,
          ...(value !== null && map[value.toString()] ? { currentLabel: map[value.toString()] } : {}),
          'aria-label': col.label,
          onChange: (v: bigint | null) => commit(v),
        },
        cell,
      ) as RefPicker;
      child = rp;
      queueMicrotask(() => {
        if (this.isAlive() && this.editing?.child === rp) rp.open();
      });
    } else if (col.kind === 'date') {
      const dp = this.spawn(
        'DatePicker',
        {
          type: 'DatePicker',
          value: typeof cur === 'string' ? cur : null,
          onChange: (v: string | null) => commit(v),
        },
        cell,
      ) as DatePicker;
      child = dp;
      queueMicrotask(() => {
        if (this.isAlive() && this.editing?.child === dp) dp.openMenu();
      });
    } else {
      const input = document.createElement('input');
      input.className = 'grid__cell-input';
      input.type = typeof cur === 'number' ? 'number' : 'text';
      input.value = cur === null || cur === undefined ? '' : typeof cur === 'bigint' ? cur.toString() : String(cur);
      this.listen(input, 'keydown', (ev) => {
        const e = ev as KeyboardEvent;
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(typeof cur === 'number' ? Number(input.value) : input.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.cancelCellEdit();
        }
      });
      this.listen(input, 'blur', () => {
        if (this.editing?.cell === cell) commit(typeof cur === 'number' ? Number(input.value) : input.value);
      });
      cell.append(input);
      queueMicrotask(() => {
        if (this.isAlive() && this.editing?.cell === cell) input.focus();
      });
    }
    this.editing = { cardId, key: col.key, cell, child };
  }

  /**
   * Commit an inline edit: optimistically patch the loaded row, fire
   * `attribute.update`, and refetch on error to revert to server truth. A
   * no-op when the value is unchanged.
   */
  private commitCellEdit(cardId: string, attr: string, value: unknown): void {
    const editing = this.editing;
    if (editing === null || editing.cardId !== cardId) return;
    this.cancelCellEdit();

    const node = this.ctx.tree.at(this.tasksPath);
    const tasks = (node.peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    const row = tasks.find((t) => t.id.toString() === cardId);
    if (row === undefined || sameAttrValue(row.attributes[attr], value)) return;

    node.set(
      tasks.map((t) =>
        t.id.toString() === cardId ? { ...t, attributes: { ...t.attributes, [attr]: value } } : t,
      ),
    );
    this.ctx.api.callByName(
      'attribute.update',
      { cardId: BigInt(cardId), attributeName: attr, value },
      () => {},
      { alive: () => this.isAlive(), onErr: () => this.bumpQuery() },
    );
  }

  /** Tear down the active inline editor and restore the cell to read mode. */
  private cancelCellEdit(): void {
    const editing = this.editing;
    if (editing === null) return;
    this.editing = null;
    if (editing.child !== null) this.destroyChild(editing.child);
    editing.cell.classList.remove('grid__cell--editing');
    const col = this.columns.find((c) => c.key === editing.key);
    const row = this.taskById(editing.cardId);
    if (col !== undefined && row !== null) this.fillCell(editing.cell, row, col);
    else editing.cell.replaceChildren();
  }

  /** Resolve a card_ref attribute id to its label via a lookup map; '—' if unset. */
  private setRefCell(cell: HTMLElement, row: CardWithAttrs, attr: string, lookup: string): void {
    const id = row.attributes[attr];
    if (typeof id !== 'bigint') {
      dash(cell);
      return;
    }
    const map = (this.ctx.tree.at(['grid', 'lookups', lookup]).peek<LabelMap>() ?? {}) as LabelMap;
    const key = id.toString();
    const span = document.createElement('span');
    span.className = 'grid__ref';
    span.textContent = map[key] ?? `#${key}`;
    cell.append(span);
  }

  /** The value for a `tag_prefix` column: resolve the row's tag ids to paths via
   *  the tags lookup, then the segment after `<prefix>/` (null when none match). */
  private tagPrefixCell(row: CardWithAttrs, prefix: string): string | null {
    const ids = row.attributes['tags'];
    if (!Array.isArray(ids) || ids.length === 0 || prefix === '') return null;
    const map = (this.ctx.tree.at(['grid', 'lookups', 'tags']).peek<LabelMap>() ?? {}) as LabelMap;
    const paths: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'bigint') continue;
      const p = map[id.toString()];
      if (p !== undefined) paths.push(p);
    }
    return tagPrefixValue(paths, prefix);
  }

  /**
   * Render one tag chip per tag in the row's `tags` card_ref[] array, as plain
   * DOM mirroring the TagChip control's structure (`data-tag-chip` /
   * `.tag-chip__label`, full path as the tooltip + `data-tag-path`). We do NOT
   * spawn a TagChip Control per chip here: the row node is recycled, so a
   * spawned child Control would either leak (never destroyed) or need bespoke
   * teardown per fillRow. Plain DOM is rebuilt in place each fill — same markup,
   * no lifecycle to manage on a recycled node.
   */
  private setTagsCell(cell: HTMLElement, row: CardWithAttrs): void {
    const ids = row.attributes['tags'];
    if (!Array.isArray(ids) || ids.length === 0) {
      dash(cell);
      return;
    }
    const map = (this.ctx.tree.at(['grid', 'lookups', 'tags']).peek<LabelMap>() ?? {}) as LabelMap;
    let rendered = 0;
    for (const id of ids) {
      if (typeof id !== 'bigint') continue;
      const path = map[id.toString()];
      if (path === undefined) continue;
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.dataset.tagChip = '';
      chip.dataset.tagPath = path;
      if (path.length > 0) chip.title = path;
      const label = document.createElement('span');
      label.className = 'tag-chip__label';
      label.textContent = tagPathLeaf(path);
      chip.append(label);
      cell.append(chip);
      rendered += 1;
    }
    if (rendered === 0) dash(cell);
  }

  /* ----------------------------- query driver --------------------------- */

  /**
   * Project the active search + the Advanced structured predicate to the tasks
   * query's `where[]` / `tree` leaves. The two NARROW the query together:
   *
   *   - The title-search leaf is always a flat `contains` over `title`.
   *   - When the predicate is a flat AND of leaves (the common case the
   *     PredicateFilter builds), its leaves AND straight into `where[]` alongside
   *     the search leaf — no `tree` needed.
   *   - When the predicate is a structured tree (OR / NOT / nesting), `where[]`
   *     carries only the search leaf and the full predicate goes to the v2 `tree`
   *     field; the server ANDs `where` and `tree` together.
   *
   * `where` / `tree` are set to `undefined` when empty so the encoder omits them.
   */
  private applyFilter(search: string, predicate: Predicate | null): void {
    const needle = search.trim();
    const searchLeaf: CardWherePredicate | null =
      needle.length > 0 ? { attr: 'title', op: 'contains', value: needle } : null;

    let where: CardWherePredicate[] | undefined;
    let tree: WireNode | undefined;

    if (predicate === null) {
      where = searchLeaf ? [searchLeaf] : undefined;
    } else if (isFlatAndOfLeaves(predicate)) {
      // Flat AND → compose its leaves with the search leaf in `where[]`.
      const leaves = toWhereLeaves(predicate) ?? [];
      const combined = searchLeaf ? [searchLeaf, ...leaves] : leaves;
      where = combined.length > 0 ? combined : undefined;
    } else {
      // Structured tree (OR / NOT / nested) → `tree`; search stays in `where[]`.
      where = searchLeaf ? [searchLeaf] : undefined;
      tree = toWire(predicate);
    }

    this.ctx.tree.at(['grid', 'where']).set(where);
    this.ctx.tree.at(['grid', 'tree']).set(tree);
  }

  /** Bump the tasks-query version leaf so the `{ signal }` trigger refires. A
   *  plain write outside any tracked effect — one-way, cascade-safe. */
  private bumpQuery(): void {
    const node = this.ctx.tree.at(['grid', 'queryVersion']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /** Bump the group version leaf so the body's virtualList re-walks the items
   *  (group attr / direction change) WITHOUT re-issuing the tasks query — and
   *  the group column header repaints its arrow. One-way, cascade-safe. */
  private bumpGroup(): void {
    const node = this.ctx.tree.at(['grid', 'groupVersion']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /**
   * Screen-tier hotkeys. `n` opens the global quick-entry overlay scoped to the
   * current project (raised as the `quickCreateOpen` bus intent the AppShell's
   * QuickEntry listens for).
   */
  override hotkeys(): readonly import('../core/hotkeys.js').HotkeyBinding[] {
    return [
      { binding: 'n', label: 'New task', run: () => this.ctx.bus?.emit('quickCreateOpen') },
      ...(this.config.hotkeys ?? []),
    ];
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

/** Read a top-level (non-attribute) field off a wire row defensively. The shared
 *  decode doesn't carry `created_at` / `last_activity_at` yet; a richer decode
 *  would, and this reads them the moment they're present. */
/** Stable identity for a column set (so a rebuild only fires on a real change). */
function columnKey(cols: readonly ColumnDef[]): string {
  return cols.map((c) => c.key).join('|');
}

function topLevel(row: CardWithAttrs, key: string): unknown {
  return (row as unknown as Record<string, unknown>)[key];
}

/** Columns whose value is a single editable attribute (#30 inline edit).
 *  ID/Title/tags/tag_prefix/created/last_activity are read-only here. */
function isEditableCol(col: ColumnDef): boolean {
  return (col.kind === 'ref' || col.kind === 'date' || col.kind === 'attr') && !!col.attrName;
}

/** Value equality for inline-edit no-op detection (bigint-aware). */
function sameAttrValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') return String(a) === String(b);
  return false;
}

function strAttr(row: CardWithAttrs, key: string): string | undefined {
  const v = row.attributes[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function titleAttr(r: CardWithAttrs): string {
  const t = r.attributes['title'];
  return typeof t === 'string' && t.length > 0 ? t : `#${r.id.toString()}`;
}

function titleOrName(r: CardWithAttrs): string {
  const t = r.attributes['title'] ?? r.attributes['name'];
  return typeof t === 'string' && t.length > 0 ? t : `#${r.id.toString()}`;
}

/** Format a date-ish value to YYYY-MM-DD; undefined when not a usable string. */
function dateAttr(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length >= 10) return v.slice(0, 10);
  return undefined;
}

/** Render the muted em-dash placeholder cell content. */
function dash(cell: HTMLElement): void {
  const span = document.createElement('span');
  span.className = 'grid__dash muted';
  span.textContent = '—';
  cell.append(span);
}

function describeFault(f: ApiFault): string {
  switch (f.kind) {
    case 'sub_error':
      return `${f.code}: ${f.message}`;
    case 'http':
      return `http ${f.status}`;
    case 'network':
      return `network: ${f.message}`;
    case 'decode':
      return `decode: ${f.message}`;
    case 'aborted':
      return `aborted: ${f.reason}`;
  }
}

export function registerGrid(): void {
  Control.register('Grid', Grid);
}

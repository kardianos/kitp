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
import { SPEC } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import type { CardWherePredicate } from '../projects/project-helpers.js';
import {
  type Predicate,
  type WireNode,
  isFlatAndOfLeaves,
  toWhereLeaves,
  toWire,
} from '../filter/predicate.js';
import {
  GRID_COLUMNS,
  buildOrderClauses,
  cycleSort,
  effectiveSort,
  tagPathLeaf,
  type ColumnDef,
  type SortState,
} from './grid-helpers.js';

/**
 * Fixed virtual-list row height (px). Matches the compact grid row: one line of
 * 13px data text at 1.3 leading + 2 × --pad-compact-y (0.375rem = 6px) padding,
 * rounded to a clean rhythm. Mirror this in `.grid__row { height }` in
 * styles.css — the virtualList positions rows by this exact px value, so the
 * CSS row height MUST equal it or rows overlap / gap.
 */
const GRID_ROW_HEIGHT = 34;

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
  /** Active header-click sort; null = server default (ORDER BY c.id). */
  private sort: SortState | null = null;

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

    /* ------------------------------- table --------------------------------- */
    // The table is a column: a NON-scrolling sticky header, then the body which
    // is the virtualList scroll VIEWPORT (the recycling pool lives inside it).
    const table = document.createElement('div');
    table.className = 'grid__table';
    table.dataset.gridTable = '';
    table.setAttribute('role', 'table');

    const header = this.buildHeader();
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
    // churn → no flash). `data()` reads the tasks leaf reactively AND the
    // lookups `tick` leaf so a late-landing lookup re-windows + re-resolves the
    // visible cells. `create(el)` builds the empty cell shells ONCE per pooled
    // node; `update(el, task, i)` swaps EVERY cell's content + re-resolves
    // labels + sets `data-card-id` from the task — never from node state,
    // because nodes recycle to different tasks on scroll. The key-skip fast
    // NO key: a row's CONTENT changes while its task id + slot index stay fixed
    // when a card_ref lookup lands late (the tick bumps). The key-skip fast path
    // is only safe when content is a pure function of item identity; here it
    // isn't, so update() runs for every visible slot on each render and the
    // late-landing label always repaints the visible cells.
    const vl = virtualList<CardWithAttrs>({
      container: body,
      rowHeight: GRID_ROW_HEIGHT,
      data: () => {
        // Read the lookups tick so the single effect re-renders when a label
        // map lands; update() peeks the same leaves when it resolves cells.
        this.ctx.tree.at(['grid', 'lookups', 'tick']).get();
        return (tasksNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
      },
      create: (el) => this.buildRowShell(el),
      update: (el, row) => this.fillRow(el, row),
      name: 'grid.rows',
    });
    this.onDestroy(() => vl.dispose());

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

  /* ------------------------------- header ------------------------------- */

  private buildHeader(): HTMLElement {
    const head = document.createElement('div');
    head.className = 'grid__header';
    head.dataset.gridHeaderRow = '';
    head.setAttribute('role', 'row');

    for (const col of GRID_COLUMNS) {
      head.append(this.buildHeaderCell(col));
    }
    return head;
  }

  private buildHeaderCell(col: ColumnDef): HTMLElement {
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

    if (sortable) {
      // Reflect the current sort state on this header (data hooks + arrow), and
      // re-render reactively so a sort change on ANY column repaints all arrows.
      this.effect(() => {
        const active = this.sortSignal.get();
        const dir = active && active.field === col.field ? active.direction : null;
        if (dir === null) {
          delete cell.dataset.sortDir;
          cell.dataset.sortField = String(col.field);
          arrow.textContent = '';
          cell.setAttribute('aria-sort', 'none');
        } else {
          cell.dataset.sortField = String(col.field);
          cell.dataset.sortDir = dir;
          arrow.textContent = dir === 'asc' ? '↑' : '↓';
          cell.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
        }
      }, `grid.header.${col.key}`);

      this.listen(btn, 'click', () => this.onHeaderClick(col));
    }

    return cell;
  }

  /** Header click: cycle the sort and re-issue the tasks query with the new order. */
  private onHeaderClick(col: ColumnDef): void {
    if (col.field === null) return;
    const next = cycleSort(this.sort, col.field);
    this.sort = next;
    this.sortSignal.set(next); // repaint header arrows (read in the header effect)
    // Project the effective sort to the wire `order[]` and stash it for the
    // tasks query's input resolver to peek, then bump the version to refire.
    const order = buildOrderClauses(effectiveSort(next, []));
    this.ctx.tree.at(['grid', 'order']).set(order);
    this.bumpQuery();
  }

  /** Reactive mirror of `this.sort` so every header cell repaints on a change. */
  private readonly sortSignal = signal<SortState | null>(null, 'grid.sort');

  /* -------------------------------- rows -------------------------------- */

  /**
   * Build the empty cell shells for ONE pooled row node — runs ONCE per pool
   * slot (virtualList `create`), never per task. Each cell carries its column's
   * `data-grid-col` + class so the column template lines up; `fillRow` swaps the
   * cell CONTENT for whatever task the slot later shows. The row's
   * `data-card-id` is NOT set here (the slot has no task yet) — `fillRow` sets
   * it per task, because the node recycles to a different card on scroll.
   */
  private buildRowShell(el: HTMLElement): void {
    el.className = 'grid__row';
    el.dataset.gridRow = '';
    el.setAttribute('role', 'row');
    el.tabIndex = 0;
    for (const col of GRID_COLUMNS) {
      const cell = document.createElement('div');
      cell.className = `grid__cell grid-${col.kind}`;
      cell.dataset.gridCol = col.field ?? col.key;
      cell.setAttribute('role', 'cell');
      el.append(cell);
    }
  }

  /**
   * Swap a pooled row's content for `row`. Sets `data-card-id` from the task
   * (NOT node state) and repopulates every cell, re-resolving card_ref labels
   * from the lookup tree paths. Called every time the slot shows a different
   * task (and whenever the lookups tick re-renders the window). Cells are
   * cleared + rebuilt in place — the cell shells from `buildRowShell` persist.
   */
  private fillRow(el: HTMLElement, row: CardWithAttrs): void {
    el.dataset.cardId = row.id.toString();
    const cells = el.children;
    for (let i = 0; i < GRID_COLUMNS.length; i++) {
      const cell = cells[i] as HTMLElement | undefined;
      if (!cell) continue;
      this.fillCell(cell, row, GRID_COLUMNS[i]!);
    }
  }

  /** Repopulate one cell for a task + column, resolving ref labels from lookups. */
  private fillCell(cell: HTMLElement, row: CardWithAttrs, col: ColumnDef): void {
    // Clear prior content (this slot may have shown another task before).
    cell.replaceChildren();
    switch (col.kind) {
      case 'id':
        cell.textContent = `#${row.id.toString()}`;
        break;
      case 'title':
        cell.textContent = strAttr(row, 'title') ?? '(untitled)';
        break;
      case 'status':
        this.setRefCell(cell, row, 'status', 'statuses');
        break;
      case 'assignee':
        this.setRefCell(cell, row, 'assignee', 'persons');
        break;
      case 'priority': {
        // Priority is a scalar attribute rendered as a tone pill (the design's
        // [high]/[med]/[low]); empty → em-dash.
        const v = row.attributes['priority'];
        if (v === null || v === undefined || v === '') {
          dash(cell);
        } else {
          const pill = document.createElement('span');
          pill.className = 'grid__pill';
          pill.dataset.priority = String(v);
          pill.textContent = String(v);
          cell.append(pill);
        }
        break;
      }
      case 'milestone':
        this.setRefCell(cell, row, 'milestone_ref', 'milestones');
        break;
      case 'component':
        this.setRefCell(cell, row, 'component_ref', 'components');
        break;
      case 'tags':
        this.setTagsCell(cell, row);
        break;
      case 'due':
        cell.textContent = dateAttr(row.attributes['due_date']) ?? '—';
        break;
      case 'created':
        // created_at rides at the top level of the wire row (the server sets it
        // from card.created_at). The shared decode doesn't carry it yet, so this
        // shows '—' until a richer decode lands (documented deferral).
        cell.textContent = dateAttr(topLevel(row, 'created_at')) ?? '—';
        break;
      case 'last_activity':
        cell.textContent = dateAttr(topLevel(row, 'last_activity_at')) ?? '—';
        break;
    }
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
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

/** Read a top-level (non-attribute) field off a wire row defensively. The shared
 *  decode doesn't carry `created_at` / `last_activity_at` yet; a richer decode
 *  would, and this reads them the moment they're present. */
function topLevel(row: CardWithAttrs, key: string): unknown {
  return (row as unknown as Record<string, unknown>)[key];
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

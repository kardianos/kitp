/**
 * Kanban board controls — Kanban + Column + TaskCard.
 *
 * The board groups tasks by an AXIS attribute the GROUP picker (`screen.group`)
 * selects: status / component / assignee / milestone. A one-way group-watch
 * effect resolves the picker's vocabulary to the stored attr via the shared
 * `groupAttrFromGroupValue` seam (filter/group-axis.ts — the same map the Grid
 * uses for row grouping) and re-keys the columns by that attr's value-cards plus
 * a trailing `(unset)` column. The default axis (no GROUP set) stays milestone.
 *
 * A TaskCard drags two ways, both OPTIMISTIC (auto-rollback on fault), wired
 * through the declarative data layer (no promises, no `await`, no `call(...)`):
 *   - CROSS-COLUMN  re-keys the dragged card's CURRENT axis attribute to the
 *     target column's value-card id (or null for `(unset)`) via `attribute.update`
 *     (intent 'moveTask' → SPEC.attributeUpdate). Generalised from the old
 *     milestone-only move: the axis attr name rides in the intent payload.
 *   - WITHIN-COLUMN reorders by rewriting `sort_order` across the destination
 *     cell (planSortRewrite → the minimal `(i+1)*STEP` writes). Each write fires
 *     one `attribute.update` (intent 'reorderTask'); same-tick fires coalesce
 *     into ONE `POST /api/v1/batch` and each carries its own optimistic
 *     sort_order patch so the column re-orders immediately.
 *
 * Data flow (declarative):
 *   - static query `tasks`      → card.select_with_attributes (card_type 'task',
 *     parent = scope.projectId). Refires on a `kanban.queryVersion` leaf the
 *     board bumps for scope changes AND filter changes (shared search + the
 *     Advanced structured predicate, ANDed into where[]/tree like the Grid).
 *   - lookup queries milestones / statuses / components / persons → the axis
 *     value-cards for each possible GROUP axis, each landing its `{id,label}`
 *     card list at `kanban.axis.<lookup>`. (milestones also lands at the legacy
 *     `kanban.milestones` path.)
 *   - static actions 'moveTask' (cross-column re-key) + 'reorderTask'
 *     (within-column sort_order), each with an optimistic tasks patch.
 *
 * The render reads `kanban.tasks` + the active axis's value-card list + the
 * `kanban.groupVersion` leaf reactively; a GROUP picker change bumps the group
 * version and re-buckets WITHOUT re-issuing the tasks query.
 *
 * Each column's card list is a recycling `virtualList` (fixed card height). The
 * board re-renders on tasks / axis / group changes; each render DISPOSES the
 * prior columns' virtualLists and creates fresh ones, so nothing leaks. Drag/drop
 * survives recycling: the dragstart listener is attached ONCE per pooled card
 * node and reads the dragged id from `data-card-id` (set per-fill from the item).
 *
 * Stubbed / deferred (documented):
 *   - Swim lanes (the 2-D group_by_attr axis).
 *   - keyboard hjkl card nav.
 */

import { Control, type BaseControlConfig, type ControlContext } from '../core/control.js';
import type { ActionBinding, QueryBinding } from '../core/data.js';
import type { ApiFault } from '../core/dispatch.js';
import { virtualList, type VirtualListHandle } from '../core/virtual-list.js';
import { DropPlaceholder, computeDropTarget, applySettle, FlipAnimator } from '../ui/drag-placeholder.js';
import { navigate, taskUrl } from '../shell/router.js';
import { publishTaskNav } from '../shell/task-nav.js';
import { SPEC } from './specs.js';
import {
  bucketByColumn,
  bucketKeyOf,
  columnOrder,
  planSortRewrite,
  sortByOrder,
  UNSET_KEY,
  type CardWithAttrs,
} from './kanban-helpers.js';
import { type GroupAttr } from '../filter/group-axis.js';
import { KANBAN_DEFAULT_GROUP_ATTR } from '../filter/screen-resolve.js';
import type { CardWherePredicate } from '../projects/project-helpers.js';
import {
  type Predicate,
  type WireNode,
  isFlatAndOfLeaves,
  toWhereLeaves,
  toWire,
} from '../filter/predicate.js';

/**
 * Fixed virtual-list row height (px) for a kanban card slot: the compact card
 * (grip + title + meta, ~56px) plus the inter-card gap baked in. The card fills
 * the slot with a bottom margin for the visual gap; the virtualList tiles slots
 * by this exact height. Mirror in `.col__body .card` / slot height in CSS.
 */
const KANBAN_CARD_HEIGHT = 64;

/** The default axis when no GROUP is picked: group columns by milestone. The
 *  attr is shared with the filter bar (via screen-resolve) so the board's
 *  fallback and the GROUP picker's default can't drift apart. */
const DEFAULT_AXIS_ATTR = KANBAN_DEFAULT_GROUP_ATTR;
const DEFAULT_AXIS_LOOKUP = 'milestones';

/* -------------------------------------------------------------------------- */
/* Configs + declaration-merged registry types.                              */
/* -------------------------------------------------------------------------- */

export interface KanbanConfig extends BaseControlConfig {
  type: 'Kanban';
  /** Tree path the loaded tasks live at. Default 'kanban.tasks'. */
  tasksPath?: string;
}

export interface ColumnConfig extends BaseControlConfig {
  type: 'Column';
}

export interface TaskCardConfig extends BaseControlConfig {
  type: 'TaskCard';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    Kanban: KanbanConfig;
    Column: ColumnConfig;
    TaskCard: TaskCardConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Axis value-card (the value-card a column is keyed by).                      */
/* -------------------------------------------------------------------------- */

interface AxisCard {
  id: bigint;
  label: string;
}

/* Shared dataset key for the in-flight drag (one board, simple module state). */
let draggingCardId: bigint | null = null;

/* -------------------------------------------------------------------------- */
/* Kanban — the board.                                                         */
/* -------------------------------------------------------------------------- */

export class Kanban extends Control<KanbanConfig> {
  /**
   * The active grouping axis, resolved from the GROUP picker (`screen.group`)
   * via the shared `groupAttrFromGroupValue` seam. `null` means no GROUP is set
   * → the board falls back to its default milestone axis. Read through
   * {@link axisAttr} / {@link axisLookup} so the default is in one place.
   */
  private axis: GroupAttr | null = null;
  /** The active swim-lane axis (2nd dimension), or null for a single row (#26). */
  private lane: GroupAttr | null = null;

  /** The active column attribute (the value the cards are bucketed by). */
  private get axisAttr(): string {
    return this.axis?.attr ?? DEFAULT_AXIS_ATTR;
  }

  /** The lookup-map name whose value-cards key the columns for the active axis. */
  private get axisLookup(): string {
    return this.axis?.lookup ?? DEFAULT_AXIS_LOOKUP;
  }

  /** The board element (`.kanban__columns`). Held so the drag handlers can
   *  toggle `kanban--dragging`, which gates the drop-target affordance — the
   *  dashed/highlighted drop strip only shows during an active drag, not at
   *  rest. Set once in render(); survives column re-renders (replaceChildren). */
  private boardEl: HTMLElement | null = null;

  /** Live per-column virtualLists. The board re-renders wholesale on every
   *  tasks change (optimistic move re-buckets); each render disposes these and
   *  creates fresh ones so no effect / scroll listener / ResizeObserver leaks. */
  private columnLists: VirtualListHandle[] = [];

  /** Live per-column drop placeholders (#1) — created with each column, glide
   *  to the insertion gap during a drag. Disposed with the column lists on a
   *  board rebuild + on destroy so no detached nodes / timers leak. */
  private columnPlaceholders: DropPlaceholder[] = [];

  /** The card id that just moved (drop / re-key), consumed by the next fill to
   *  play a one-shot settle ring on the card in its new slot. */
  private settleCardId: bigint | null = null;

  /** FLIP slider: records card positions before a reorder and slides them to
   *  their new slots after the in-place re-render (within-column moves). */
  private readonly flip = new FlipAnimator(() => this.boardEl, '[data-kanban-card]');

  /** The board's column/lane STRUCTURE signature from the last DOM build. While
   *  it's unchanged the board's DOM is NOT rebuilt on a tasks change — each
   *  column's virtualList reacts to the tasks leaf and updates its cards in
   *  place (recycling), so a drop reorders smoothly instead of the whole board
   *  flashing (hide/show). A real structure change (axis/group/lane switch, a
   *  new bucket column) rebuilds. */
  private boardStructureKey = '';

  /**
   * CLASS-STATIC binding table. The instance config is merged on top, so a
   * screen card could later override paths without a code change.
   *
   * One tasks query + four axis-value-card lookups (one per possible GROUP
   * axis). The tasks query refires on a single `kanban.queryVersion` leaf the
   * board bumps for scope/filter changes; the lookups refire on project switch.
   */
  static override queries: readonly QueryBinding[] = [
    {
      name: 'tasks',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'kanban.queryVersion' },
      input: {
        cardTypeName: { lit: 'task' },
        parentCardId: { from: 'scope.projectId' },
        order: { lit: [{ field: 'attributes.sort_order', direction: 'ASC' }] },
        // Search + Advanced predicate, resolved at fire time (see applyFilter).
        where: { from: 'kanban.where' },
        tree: { from: 'kanban.tree' },
        limit: { lit: 500 },
      },
      // Stay idle until a project scope resolves — avoids loading every
      // project's tasks on the initial (scope=null) fire. The { signal }
      // trigger refires this once kanban.queryVersion is bumped on scope change.
      skipWhenNull: ['parentCardId'],
      result: { method: 'landTasks' },
      onError: 'self',
    },
    // Axis value-cards, one query per possible GROUP axis. All use
    // select_with_attributes (NOT card.select) because the lighter read returns
    // title:null — the column header needs the real `title` attribute. The
    // board reads only the active axis's list; the others stay loaded so a GROUP
    // switch re-keys instantly (no extra round-trip).
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
      name: 'statuses',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'status' }, parentCardId: { from: 'scope.projectId' } },
      skipWhenNull: ['parentCardId'],
      result: { method: 'landStatuses' },
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
      // person cards are NOT project-scoped (assignees span projects), so this
      // omits parentCardId — same posture as the Grid's persons lookup.
      name: 'persons',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'person' } },
      result: { method: 'landPersons' },
      onError: 'self',
    },
    {
      // Tag value-cards — for the assignee/tag chips on each card (#25 richness).
      name: 'tags',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'tag' }, parentCardId: { from: 'scope.projectId' } },
      skipWhenNull: ['parentCardId'],
      result: { method: 'landTags' },
      onError: 'self',
    },
  ];

  static override actions: readonly ActionBinding[] = [
    {
      // Optimistic CROSS-COLUMN move. Patch re-buckets the moved card in the
      // tasks array immediately by setting its AXIS attribute (name + value ride
      // in the payload — NOT hardcoded to milestone_ref); the spec fires
      // attribute.update; on fault the tree transaction auto-rolls-back and the
      // fault funnels to the top-level handler.
      intent: 'moveTask',
      spec: SPEC.attributeUpdate,
      input: {
        cardId: { payload: 'cardId' },
        attributeName: { payload: 'attributeName' },
        value: { payload: 'value' },
      },
      optimistic: {
        path: 'kanban.tasks',
        patch: (current, payload): CardWithAttrs[] => {
          const rows = Array.isArray(current) ? (current as CardWithAttrs[]) : [];
          const p = (payload ?? {}) as { cardId?: bigint; attributeName?: string; value?: unknown };
          if (p.cardId === undefined || p.attributeName === undefined) return rows;
          return rows.map((row) =>
            row.id === p.cardId
              ? { ...row, attributes: { ...row.attributes, [p.attributeName as string]: p.value ?? null } }
              : row,
          );
        },
      },
      onError: 'top',
    },
    {
      // Optimistic WITHIN-COLUMN reorder. ONE per sort_order rewrite the drop
      // plans (planSortRewrite); fired once per affected card in the same tick
      // so the dispatcher coalesces them into one batch. Each carries its own
      // optimistic patch that writes that card's sort_order in kanban.tasks, so
      // the column re-orders immediately; rollback on fault restores it.
      intent: 'reorderTask',
      spec: SPEC.attributeUpdate,
      input: {
        cardId: { payload: 'cardId' },
        attributeName: { lit: 'sort_order' },
        value: { payload: 'sortOrder' },
      },
      optimistic: {
        path: 'kanban.tasks',
        patch: (current, payload): CardWithAttrs[] => {
          const rows = Array.isArray(current) ? (current as CardWithAttrs[]) : [];
          const p = (payload ?? {}) as { cardId?: bigint; sortOrder?: number };
          if (p.cardId === undefined || p.sortOrder === undefined) return rows;
          return rows.map((row) =>
            row.id === p.cardId
              ? { ...row, attributes: { ...row.attributes, sort_order: p.sortOrder as number } }
              : row,
          );
        },
      },
      onError: 'top',
    },
  ];

  private get tasksPath(): string[] {
    return (this.config.tasksPath ?? 'kanban.tasks').split('.');
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'kanban';
    el.dataset.control = 'Kanban';
    el.tabIndex = -1;
    return el;
  }

  protected render(): void {
    this.registerResultHandlers();

    const fault = document.createElement('div');
    fault.className = 'kanban__fault';
    fault.style.display = 'none';

    // `.scroll-x`: the column row scrolls HORIZONTALLY when more columns exist
    // than fit (issue #14), with the visible styled horizontal scrollbar.
    // Columns keep their fixed widths + their own vertical virtual scroll.
    const board = document.createElement('div');
    board.className = 'kanban__columns scroll-x';
    board.dataset.kanbanBoard = '';
    this.boardEl = board;

    this.el.append(fault, board);

    // Seed the query-driver leaves BEFORE the data layer wires (mount() wires
    // after render). where/tree start empty; queryVersion / groupVersion start
    // at 0. Plain seeds — the Object.is gate makes a re-seed a no-op.
    this.ctx.tree.at(['kanban', 'where']).set(undefined);
    this.ctx.tree.at(['kanban', 'tree']).set(undefined);
    const versionNode = this.ctx.tree.at(['kanban', 'queryVersion']);
    if (versionNode.peek<number>() === undefined) versionNode.set(0);
    // groupVersion: a board-only re-render trigger the group-watch bumps so a
    // GROUP picker change re-keys the columns WITHOUT re-issuing the tasks query.
    const groupVersionNode = this.ctx.tree.at(['kanban', 'groupVersion']);
    if (groupVersionNode.peek<number>() === undefined) groupVersionNode.set(0);

    const tasksNode = this.ctx.tree.at(this.tasksPath);

    // One-way query-version drivers — each reads ONLY the leaf it watches and
    // writes ONLY where/tree/version (never back into a watched dep), so the
    // tasks query refires on scope OR filter change without a cascade.
    this.effect(() => {
      this.ctx.tree.at(['scope', 'projectId']).get(); // subscribe
      this.bumpQuery();
    }, 'kanban.scopeWatch');

    this.effect(() => {
      const search = this.ctx.tree.at(['screen', 'search']).get<string>() ?? '';
      const predicate = this.ctx.tree.at(['screen', 'predicate']).get<Predicate | null>() ?? null;
      this.applyFilter(search, predicate);
      this.bumpQuery();
    }, 'kanban.filterWatch');

    // GROUP picker → column axis. Reads the RESOLVED `screen.groupAxis`
    // ({attr, lookup} | null) the ScreenFilterBar derives from the data-driven
    // schema (replacing the retired hardcoded group-value switch); null → the
    // board falls back to its default milestone axis (axisAttr/axisLookup). One-
    // way: never reads back a dep it writes. The board render reads the version
    // leaf, so re-keying happens with no extra wiring and no tasks re-query.
    this.effect(() => {
      this.axis = this.ctx.tree.at(['screen', 'groupAxis']).get<GroupAttr | null>() ?? null;
      this.bumpGroup();
    }, 'kanban.groupWatch');

    // LANE picker → 2nd (swim-lane) axis. Reads the resolved `screen.laneAxis`;
    // null → no lanes (single row). A change re-renders the board (group version).
    this.effect(() => {
      this.lane = this.ctx.tree.at(['screen', 'laneAxis']).get<GroupAttr | null>() ?? null;
      this.bumpGroup();
    }, 'kanban.laneWatch');

    // Refetch when a task is created anywhere (the quick-entry overlay bumps
    // `tasks.createdNonce`), so a newly-added card appears on the board without
    // a manual reload. One-way: reads the nonce, bumps the query version (a
    // different leaf the tasks query watches) — cascade-safe.
    this.effect(() => {
      const nonce = this.ctx.tree.at(['tasks', 'createdNonce']).get<number>() ?? 0;
      if (nonce > 0) this.bumpQuery();
    }, 'kanban.refreshOnCreate');

    // Inline self-represented load error (onError: 'self').
    this.effect(() => {
      const f = this.fault.get();
      if (!f) {
        fault.style.display = 'none';
        fault.textContent = '';
        return;
      }
      fault.style.display = '';
      fault.textContent = `Failed to load kanban: ${describeFault(f)}`;
    }, 'kanban.fault');

    // ONE effect renders the whole board reactively from the tasks leaf, the
    // active axis's value-card list, and the group version. Re-bucketing on
    // every tasks change is what makes the optimistic move/reorder (and their
    // rollbacks) re-render the columns with no extra wiring; reading the group
    // version re-keys the columns when the GROUP picker changes.
    this.effect(() => {
      const tasks = (tasksNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
      this.ctx.tree.at(['kanban', 'groupVersion']).get(); // re-key on a GROUP change
      const axis = this.activeAxisCards();
      this.renderBoard(board, tasks, axis);
    }, 'kanban.board');

    // Dispose any live column virtualLists when the Kanban itself is torn down.
    this.onDestroy(() => this.disposeColumnLists());
  }

  /* ----------------------------- result sinks --------------------------- */

  /** Register the decode → tree-write sinks for the tasks + axis lookups. */
  private registerResultHandlers(): void {
    this.handler('landTasks', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      this.ctx.tree.at(this.tasksPath).set(rows);
    });

    // Each axis lookup lands an AxisCard[] (id + display label) at
    // kanban.axis.<lookup>. The board reads only the active axis's list.
    const landAxis = (lookup: string) => (out: unknown) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const axis: AxisCard[] = rows.map((r) => ({ id: r.id, label: labelOf(r) }));
      this.ctx.tree.at(['kanban', 'axis', lookup]).set(axis);
      // Re-key the columns when a late-landing axis list arrives for the active
      // axis (the board render reads the group version).
      this.bumpGroup();
    };

    // milestones ALSO lands at the legacy `kanban.milestones` path (existing
    // tests + any external reader), in addition to the unified axis path.
    this.handler('landMilestones', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const axis: AxisCard[] = rows.map((r) => ({ id: r.id, label: labelOf(r) }));
      this.ctx.tree.at(['kanban', 'milestones']).set(axis);
      this.ctx.tree.at(['kanban', 'axis', 'milestones']).set(axis);
      this.bumpGroup();
    });
    this.handler('landStatuses', landAxis('statuses'));
    this.handler('landComponents', landAxis('components'));
    this.handler('landPersons', landAxis('persons'));
    this.handler('landTags', landAxis('tags'));
  }

  /** Resolve a value-card id to its label via the loaded axis list (or '#id'). */
  private axisLabel(lookup: string, id: bigint): string {
    const list = (this.ctx.tree.at(['kanban', 'axis', lookup]).peek<AxisCard[]>() ?? []) as AxisCard[];
    return list.find((c) => c.id === id)?.label ?? `#${id.toString()}`;
  }

  /** The value-card list for the ACTIVE axis (peeked — the board render reads
   *  the group version separately to subscribe to axis switches + late lands). */
  private activeAxisCards(): AxisCard[] {
    return (this.ctx.tree.at(['kanban', 'axis', this.axisLookup]).peek<AxisCard[]>() ?? []) as AxisCard[];
  }

  /** Dispose + clear the live per-column virtualLists (before a board rebuild
   *  and on Kanban destroy) so no effect / scroll listener / RO leaks. */
  private disposeColumnLists(): void {
    for (const vl of this.columnLists) vl.dispose();
    this.columnLists = [];
    for (const p of this.columnPlaceholders) p.destroy();
    this.columnPlaceholders = [];
  }

  /** Show `active`'s placeholder at content-space `y`, hiding the others (the
   *  pointer is over one column at a time; this keeps stale bars from lingering
   *  in columns the drag has left). */
  private activatePlaceholder(active: DropPlaceholder, y: number): void {
    for (const p of this.columnPlaceholders) {
      if (p !== active) p.hide();
    }
    active.showAtY(y);
  }

  /** Hide every column placeholder (drag ended / cancelled). */
  private hideAllPlaceholders(): void {
    for (const p of this.columnPlaceholders) p.hide();
  }

  /** Run the FLIP slide on the next frame, once the optimistic re-render has
   *  repositioned the slots. No requestAnimationFrame (test env) → no-op. */
  private scheduleFlip(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => this.flip.play());
  }

  /** The live, sorted cards for one column (and lane, when laned), filtered from
   *  `tasks`. Used both by a column's reactive `data()` (reads the tasks leaf via
   *  `.get()` so the column re-renders in place) and by `onDropInto` (peeks). */
  private bucketColumn(
    tasks: readonly CardWithAttrs[],
    columnKey: string,
    laneKey: string | undefined,
  ): CardWithAttrs[] {
    const attr = this.axisAttr;
    const lane = this.lane;
    const laned = laneKey !== undefined && lane !== null && lane.attr !== attr;
    const out = tasks.filter((t) => {
      if (bucketKeyOf(t.attributes[attr]) !== columnKey) return false;
      if (laned && bucketKeyOf(t.attributes[lane.attr]) !== laneKey) return false;
      return true;
    });
    return sortByOrder(out);
  }

  /** A signature of the board's column/lane STRUCTURE (which columns/lanes exist,
   *  their order + labels) — NOT their card contents. renderBoard rebuilds the
   *  DOM only when this changes; card moves within the same structure flow
   *  through each column's reactive `data()`. */
  private computeStructureKey(tasks: readonly CardWithAttrs[], axis: AxisCard[]): string {
    const attr = this.axisAttr;
    const lane = this.lane;
    const laned = lane !== null && lane.attr !== attr;
    const colPart = (scoped: readonly CardWithAttrs[]): string => {
      const order = columnOrder(axis.map((a) => a.id), Object.keys(bucketByColumn(scoped, attr)));
      const labelById = new Map(axis.map((a) => [a.id.toString(), a.label]));
      return order.map((k) => `${k}=${k === UNSET_KEY ? '∅' : labelById.get(k) ?? `#${k}`}`).join(',');
    };
    if (!laned) return `flat|${attr}|${colPart(tasks)}`;
    const laneCards = (this.ctx.tree.at(['kanban', 'axis', lane.lookup ?? '']).peek<AxisCard[]>() ?? []) as AxisCard[];
    const laneBuckets = bucketByColumn(tasks, lane.attr);
    const laneOrder = columnOrder(laneCards.map((c) => c.id), Object.keys(laneBuckets));
    const laneLabel = new Map(laneCards.map((c) => [c.id.toString(), c.label]));
    const parts = laneOrder.map(
      (lk) => `${lk}=${lk === UNSET_KEY ? '∅' : laneLabel.get(lk) ?? `#${lk}`}[${colPart(laneBuckets[lk] ?? [])}]`,
    );
    return `lane|${attr}|${lane.attr}|${parts.join(';')}`;
  }

  /** Rebuild the board from the current tasks + the active axis value-cards.
   *  With a LANE axis set (#26) the board splits into horizontal lanes (one per
   *  lane value-card), each holding the full column row filtered to its tasks;
   *  otherwise it's a single column row. */
  private renderBoard(board: HTMLElement, tasks: CardWithAttrs[], axis: AxisCard[]): void {
    // SKIP the DOM rebuild when the column/lane STRUCTURE is unchanged: each
    // column's virtualList reacts to the tasks leaf itself, so a move/reorder
    // updates the cards in place (no flash). Only a real structure change
    // (axis/group/lane switch, a new bucket column) rebuilds the DOM below.
    const key = this.computeStructureKey(tasks, axis);
    if (key === this.boardStructureKey && board.children.length > 0) return;
    this.boardStructureKey = key;

    // Dispose the prior render's column virtualLists before replacing the DOM
    // they were bound to (replaceChildren below detaches their containers).
    this.disposeColumnLists();

    const lane = this.lane;
    if (lane === null || lane.attr === this.axisAttr) {
      board.classList.remove('kanban--laned');
      board.replaceChildren(...this.renderColumnRow(tasks, axis));
      return;
    }

    board.classList.add('kanban--laned');
    const laneCards = (this.ctx.tree.at(['kanban', 'axis', lane.lookup ?? '']).peek<AxisCard[]>() ?? []) as AxisCard[];
    const laneBuckets = bucketByColumn(tasks, lane.attr);
    const laneOrder = columnOrder(
      laneCards.map((c) => c.id),
      Object.keys(laneBuckets),
    );
    const laneLabelById = new Map<string, string>();
    for (const c of laneCards) laneLabelById.set(c.id.toString(), c.label);

    const lanes: HTMLElement[] = [];
    for (const laneKey of laneOrder) {
      const laneTasks = laneBuckets[laneKey] ?? [];
      const laneEl = document.createElement('div');
      laneEl.className = 'kanban__lane';
      laneEl.dataset.kanbanLane = laneKey;
      const head = document.createElement('div');
      head.className = 'kanban__lane-head';
      head.textContent = laneKey === UNSET_KEY ? '(unset)' : (laneLabelById.get(laneKey) ?? `#${laneKey}`);
      const colsRow = document.createElement('div');
      colsRow.className = 'kanban__lane-cols';
      colsRow.append(...this.renderColumnRow(laneTasks, axis, laneKey));
      laneEl.append(head, colsRow);
      lanes.push(laneEl);
    }
    board.replaceChildren(...lanes);
  }

  /** Render one row of columns for `tasks`, optionally tagged with the `laneKey`
   *  they belong to (so a drop can cross-lane re-key). */
  private renderColumnRow(tasks: CardWithAttrs[], axis: AxisCard[], laneKey?: string): HTMLElement[] {
    const attr = this.axisAttr;
    const buckets = bucketByColumn(tasks, attr);
    const order = columnOrder(
      axis.map((a) => a.id),
      Object.keys(buckets),
    );
    const labelById = new Map<string, string>();
    for (const a of axis) labelById.set(a.id.toString(), a.label);
    const cols: HTMLElement[] = [];
    for (const key of order) {
      const label = key === UNSET_KEY ? '(unset)' : (labelById.get(key) ?? `#${key}`);
      cols.push(this.renderColumn(key, label, laneKey));
    }
    return cols;
  }

  /** One column: header (label · count · +) + a body of TaskCards + drop zone.
   *  The card list reads the tasks leaf reactively (via `bucketColumn`), so it
   *  recycles in place on a move; the count + empty placeholder track it. */
  private renderColumn(columnKey: string, label: string, laneKey?: string): HTMLElement {
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.kanbanColumn = '';
    col.dataset.column = columnKey;
    if (laneKey !== undefined) col.dataset.laneKey = laneKey;

    const header = document.createElement('div');
    header.className = 'col__header';
    const labelEl = document.createElement('span');
    labelEl.className = 'col__label';
    labelEl.textContent = label;
    const count = document.createElement('span');
    count.className = 'col__count muted';
    count.textContent = '0';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'col__add';
    add.dataset.kanbanColumnAdd = columnKey;
    add.textContent = '+';
    // Per-column quick-add: open the quick-entry overlay prefilled to this
    // column's axis value so the new task lands here (the `(unset)` column
    // opens with no lane prefill).
    add.title = 'Quick-add a task in this column';
    this.listen(add, 'click', () => this.openQuickEntry(columnKey, laneKey));
    header.append(labelEl, count, add);

    const body = document.createElement('div');
    body.className = 'col__body scroll-y';
    body.dataset.kanbanColumnBody = '';

    const empty = document.createElement('div');
    empty.className = 'col__empty muted';
    empty.textContent = 'No tasks';
    body.append(empty);

    // The column's card list is a recycling virtualList whose `data()` reads the
    // tasks leaf REACTIVELY (bucketColumn → .get()), so a move/reorder re-renders
    // the cards in place (recycling) WITHOUT a board rebuild — the source of the
    // hide/show flash. The count + empty placeholder update in the same pass.
    // create(el) attaches the drag listeners ONCE; update(el, card) swaps content
    // + sets data-card-id from the ITEM so the drag payload is never stale.
    const tasksNode = this.ctx.tree.at(this.tasksPath);
    const vl = virtualList<CardWithAttrs>({
      container: body,
      rowHeight: KANBAN_CARD_HEIGHT,
      data: () => {
        const live = (tasksNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
        const cards = this.bucketColumn(live, columnKey, laneKey);
        count.textContent = String(cards.length);
        empty.style.display = cards.length === 0 ? '' : 'none';
        return cards;
      },
      key: (card) => card.id.toString(),
      create: (el) => this.buildCardShell(el),
      update: (el, card) => this.fillCard(el, card),
      name: `kanban.col.${columnKey}`,
    });
    this.columnLists.push(vl);

    // A gliding drop placeholder (#1) lives in this column body's content space.
    // The board re-renders wholesale on a move, so it's recreated per column and
    // disposed in disposeColumnLists.
    const placeholder = new DropPlaceholder(body, { className: 'drop-placeholder--kanban' });
    this.columnPlaceholders.push(placeholder);

    // The column body is a drop target. On drop we distinguish a WITHIN-column
    // reorder (sort_order rewrite) from a CROSS-column re-key (axis attr). During
    // dragover the placeholder glides to the insertion gap under the pointer.
    this.listen(body, 'dragover', (ev) => {
      ev.preventDefault();
      col.classList.add('col--drop');
      if (draggingCardId === null) return;
      const t = computeDropTarget(body, (ev as DragEvent).clientY, draggingCardId.toString(), '[data-kanban-card]');
      this.activatePlaceholder(placeholder, t.y);
    });
    this.listen(body, 'dragleave', () => col.classList.remove('col--drop'));
    this.listen(body, 'drop', (ev) => {
      ev.preventDefault();
      col.classList.remove('col--drop');
      placeholder.pulse();
      this.onDropInto(columnKey, body, ev as DragEvent, laneKey);
    });

    col.append(header, body);
    return col;
  }

  /**
   * Build ONE pooled card node (virtualList `create`) — runs once per pool
   * slot. The drag affordances are attached HERE (once), reading the dragged
   * card id from the node's `data-card-id` at drag time, NOT from a captured
   * card: the node recycles to a different card on scroll, so the id must come
   * from the live dataset that `fillCard` keeps current.
   */
  private buildCardShell(el: HTMLElement): void {
    el.className = 'card';
    el.dataset.kanbanCard = '';
    el.draggable = true;
    el.tabIndex = 0;

    const grip = document.createElement('span');
    grip.className = 'card__grip muted';
    grip.textContent = '⋮⋮';
    grip.setAttribute('aria-hidden', 'true');

    const title = document.createElement('div');
    title.className = 'card__title';
    title.dataset.role = 'title';

    const meta = document.createElement('div');
    meta.className = 'card__meta muted';
    meta.dataset.role = 'meta';

    el.append(grip, title, meta);

    this.listen(el, 'dragstart', (ev) => {
      // Read the CURRENT card id from the node — set per fill, never stale.
      const idStr = el.dataset.cardId;
      draggingCardId = idStr !== undefined ? BigInt(idStr) : null;
      this.settleCardId = null; // a fresh drag clears the prior move's settle
      el.classList.add('card--dragging');
      // Gate the drop-target affordance: mark the board "dragging" so the
      // .col--drop highlight is only visible mid-drag, never at rest.
      this.boardEl?.classList.add('kanban--dragging');
      const dt = (ev as DragEvent).dataTransfer;
      if (dt && idStr !== undefined) {
        dt.effectAllowed = 'move';
        // textContent only — never markup. Carries the id for native DnD.
        dt.setData('text/plain', idStr);
      }
    });
    this.listen(el, 'dragend', () => {
      draggingCardId = null;
      el.classList.remove('card--dragging');
      this.boardEl?.classList.remove('kanban--dragging');
      this.hideAllPlaceholders();
    });

    // Click / Enter / `o` opens the card's task detail (`/task/:id`). A native
    // click does not fire after a drag, so this never collides with DnD. The id
    // is read from `data-card-id` (set per fill) so it is never stale on a
    // recycled node. navigate() is a one-way History write — cascade-safe.
    this.listen(el, 'click', () => this.openCard(el));
    this.listen(el, 'keydown', (ev) => {
      const k = (ev as KeyboardEvent).key;
      if (k === 'Enter' || k === 'o') {
        ev.preventDefault();
        this.openCard(el);
      }
    });
  }

  /** Navigate into a card's task detail (`/task/:id`), reading the live id.
   *  Publishes the board's task order so task-detail prev/next nav (#18) walks
   *  the same set. */
  private openCard(el: HTMLElement): void {
    const idStr = el.dataset.cardId;
    if (idStr === undefined || idStr === '') return;
    const tasks = (this.ctx.tree.at(['kanban', 'tasks']).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    publishTaskNav(this.ctx.tree, tasks.map((t) => t.id));
    navigate(taskUrl(idStr));
  }

  /** Swap a pooled card's content for `card` (virtualList `update`). Sets
   *  data-card-id from the ITEM so the drag payload + drop reads are current. */
  private fillCard(el: HTMLElement, card: CardWithAttrs): void {
    el.dataset.cardId = card.id.toString();
    // The card that just moved settles into its new slot; every other fill
    // clears the class so a recycled node never keeps a stale animation. The id
    // persists past the optimistic re-render (cleared on the next dragstart), so
    // the server-confirm re-render doesn't cut the animation short.
    applySettle(el, 'card--settling', this.settleCardId !== null && card.id === this.settleCardId);
    const title = childByRole(el, 'title');
    if (title) title.textContent = titleOf(card);
    const meta = childByRole(el, 'meta');
    if (meta === null) return;
    // Richer card (#25): #id · assignee · tag chips (resolved from the axis
    // lookups; falls back to ids until those lists land + the board re-renders).
    meta.replaceChildren();
    const idEl = document.createElement('span');
    idEl.className = 'card__id';
    idEl.textContent = `#${card.id.toString()}`;
    meta.append(idEl);

    const assignee = card.attributes['assignee'];
    if (typeof assignee === 'bigint') {
      const a = document.createElement('span');
      a.className = 'card__assignee';
      a.dataset.role = 'assignee';
      a.textContent = this.axisLabel('persons', assignee);
      meta.append(a);
    }

    const tags = card.attributes['tags'];
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (typeof t !== 'bigint') continue;
        const path = this.axisLabel('tags', t);
        const chip = document.createElement('span');
        chip.className = 'tag-chip card__tag';
        chip.dataset.tagChip = '';
        const lbl = document.createElement('span');
        lbl.className = 'tag-chip__label';
        lbl.textContent = path.includes('/') ? (path.split('/').filter(Boolean).pop() ?? path) : path;
        chip.append(lbl);
        meta.append(chip);
      }
    }
  }

  /**
   * Resolve a drop onto a column. Two independent effects, both applied so the
   * card lands EXACTLY where dropped:
   *   - RE-KEY (only when it changed column/lane): set the axis (and lane) attr
   *     to the target's value-card id, or null for `(unset)`, via `moveTask`.
   *   - PLACE: rewrite `sort_order` across the target cell so the card sits at
   *     the pointer's slot, firing one `reorderTask` per affected card. This
   *     runs for cross-column drops too (previously they only re-keyed and
   *     landed at an arbitrary position).
   * Same-tick writes compose (attribute-level optimistic patches) + coalesce
   * into one batch. The target cell's cards are derived LIVE from the tasks leaf
   * (`bucketColumn`); `body` + the drop event give the insertion slot.
   */
  private onDropInto(
    targetColumnKey: string,
    body: HTMLElement,
    ev: DragEvent,
    laneKey?: string,
  ): void {
    const cardId = draggingCardId;
    draggingCardId = null;
    if (cardId === null) return;

    const tasks = (this.ctx.tree.at(this.tasksPath).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    const card = tasks.find((t) => t.id === cardId);
    if (!card) return;

    // FLIP (#context): snapshot card positions BEFORE the optimistic patch, then
    // slide them to their new slots on the next frame (after the in-place
    // re-render). Scheduled up front so all drop paths animate. The moved card
    // also gets a settle ring (compatible — ring is box-shadow, slide is
    // transform); a cross-column move skips the slide and keeps just the ring.
    this.flip.capture();
    this.scheduleFlip();
    this.settleCardId = cardId;

    // CROSS-LANE (swim lanes #26): dropped into a different lane → re-key the
    // lane axis attribute (a separate moveTask, coalesced into the batch).
    const lane = this.lane;
    if (lane !== null && laneKey !== undefined && bucketKeyOf(card.attributes[lane.attr]) !== laneKey) {
      const laneValue: bigint | null = laneKey === UNSET_KEY ? null : BigInt(laneKey);
      this.intent('moveTask', { cardId, attributeName: lane.attr, value: laneValue });
    }

    // CROSS-COLUMN: re-key the dragged card's axis attribute to the target
    // column's value.
    const attr = this.axisAttr;
    if (bucketKeyOf(card.attributes[attr]) !== targetColumnKey) {
      const value: bigint | null = targetColumnKey === UNSET_KEY ? null : BigInt(targetColumnKey);
      this.intent('moveTask', { cardId, attributeName: attr, value });
    }

    // PLACE AT THE DROPPED SLOT. Rewrite sort_order so the card lands exactly
    // where it was dropped — this runs whether the card stayed in its column (a
    // reorder) OR crossed into a new one, so a cross-column drop honours the
    // drop position instead of landing at an arbitrary spot. The dest stack is
    // the TARGET cell's live cards minus the moved card (it isn't bucketed there
    // yet on a cross-column move); the slot is the insertion index under the
    // pointer. The moveTask re-key + these reorderTask writes compose on the
    // moved card (attribute-level optimistic patches) and coalesce into one
    // POST /api/v1/batch.
    const destStack = this.bucketColumn(tasks, targetColumnKey, laneKey).filter((c) => c.id !== cardId);
    const slot = dropSlot(body, ev, cardId);
    const updates = planSortRewrite(destStack, card, slot);
    for (const u of updates) {
      this.intent('reorderTask', { cardId: u.cardId, sortOrder: u.sortOrder });
    }
  }

  /* ----------------------------- query driver --------------------------- */

  /**
   * Project the shared search + Advanced structured predicate to the tasks
   * query's `where[]` / `tree` leaves. Identical contract to the Grid's
   * applyFilter: a flat AND of leaves composes with the title-search leaf in
   * `where[]`; a structured tree (OR / NOT / nesting) rides the v2 `tree` field
   * while the search leaf stays in `where[]`. Empty inputs are set to undefined
   * so the encoder omits them.
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
      const leaves = toWhereLeaves(predicate) ?? [];
      const combined = searchLeaf ? [searchLeaf, ...leaves] : leaves;
      where = combined.length > 0 ? combined : undefined;
    } else {
      where = searchLeaf ? [searchLeaf] : undefined;
      tree = toWire(predicate);
    }

    this.ctx.tree.at(['kanban', 'where']).set(where);
    this.ctx.tree.at(['kanban', 'tree']).set(tree);
  }

  /* ------------------------------ keyboard ------------------------------ */

  /**
   * Screen-tier hotkeys. `n` opens the global quick-entry overlay scoped to the
   * current project (raised as the `quickCreateOpen` bus intent the AppShell's
   * QuickEntry listens for). The per-column `+` raises the same intent with a
   * lane prefill (see {@link openQuickEntry}).
   */
  override hotkeys(): readonly import('../core/hotkeys.js').HotkeyBinding[] {
    return [
      { binding: 'n', label: 'New task', run: () => this.openQuickEntry() },
      // Card cursor (#25): h/l move between columns, j/k between cards in a
      // column, Shift+H/L move the focused card to the adjacent column. Operates
      // on the focused card node (Enter/o on a card opens it — wired per card).
      { binding: 'l', label: 'Next column', run: () => this.navColumn(1) },
      { binding: 'h', label: 'Previous column', run: () => this.navColumn(-1) },
      // ArrowLeft/Right alternates for h/l — NOT fireInInputs (they move the
      // text caret in the search input; hijacking would strand typing).
      { binding: 'ArrowRight', label: 'Next column', run: () => this.navColumn(1) },
      { binding: 'ArrowLeft', label: 'Previous column', run: () => this.navColumn(-1) },
      { binding: 'j', label: 'Next card', run: () => this.navCard(1) },
      { binding: 'k', label: 'Previous card', run: () => this.navCard(-1) },
      // ArrowUp/Down also navigate cards while the search input has focus
      // (Up/Down don't move the text caret, so it's safe to hijack).
      { binding: 'ArrowDown', label: 'Next card', run: () => this.navCard(1), fireInInputs: true },
      { binding: 'ArrowUp', label: 'Previous card', run: () => this.navCard(-1), fireInInputs: true },
      { binding: 'Shift+L', label: 'Move card → next column', run: () => this.moveFocused(1) },
      { binding: 'Shift+H', label: 'Move card → previous column', run: () => this.moveFocused(-1) },
      ...(this.config.hotkeys ?? []),
    ];
  }

  /* ------------------------------ card cursor (#25) --------------------- */

  private boardColumns(): HTMLElement[] {
    const board = this.boardEl;
    if (board === null) return [];
    return Array.from(board.querySelectorAll?.('[data-kanban-column]') ?? []) as HTMLElement[];
  }
  private visibleCardsIn(col: HTMLElement): HTMLElement[] {
    return (Array.from(col.querySelectorAll?.('[data-kanban-card]') ?? []) as HTMLElement[]).filter(
      (c) => c.style?.display !== 'none',
    );
  }
  private focusedCard(): HTMLElement | null {
    const a = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
    return a !== null && a.dataset?.kanbanCard !== undefined ? a : null;
  }
  private columnOf(card: HTMLElement): HTMLElement | null {
    return (card.closest?.('[data-kanban-column]') ?? null) as HTMLElement | null;
  }

  /** j/k — focus the next/prev visible card in the focused card's column (or the
   *  first card on the board when nothing is focused). */
  private navCard(dir: 1 | -1): void {
    const card = this.focusedCard();
    if (card === null) {
      for (const col of this.boardColumns()) {
        const cs = this.visibleCardsIn(col);
        if (cs.length > 0) {
          cs[0]?.focus?.();
          return;
        }
      }
      return;
    }
    const col = this.columnOf(card);
    if (col === null) return;
    const cards = this.visibleCardsIn(col);
    const j = cards.indexOf(card) + dir;
    if (j >= 0 && j < cards.length) cards[j]?.focus?.();
  }

  /** h/l — focus the first visible card in the adjacent column. */
  private navColumn(dir: 1 | -1): void {
    const cols = this.boardColumns();
    if (cols.length === 0) return;
    const card = this.focusedCard();
    let ci = 0;
    if (card !== null) {
      const col = this.columnOf(card);
      ci = col !== null ? cols.indexOf(col) : 0;
    } else {
      ci = dir > 0 ? -1 : cols.length; // step into the first/last column
    }
    const next = ci + dir;
    if (next < 0 || next >= cols.length) return;
    const cs = this.visibleCardsIn(cols[next] as HTMLElement);
    if (cs.length > 0) cs[0]?.focus?.();
  }

  /** Shift+H/L — move the focused card to the adjacent column (cross-column
   *  re-key on the active axis), reusing the optimistic moveTask action. */
  private moveFocused(dir: 1 | -1): void {
    const card = this.focusedCard();
    if (card === null) return;
    const idStr = card.dataset.cardId;
    if (idStr === undefined || idStr === '') return;
    const cols = this.boardColumns();
    const col = this.columnOf(card);
    if (col === null) return;
    const next = cols.indexOf(col) + dir;
    if (next < 0 || next >= cols.length) return;
    const key = (cols[next] as HTMLElement).dataset.column;
    const value = key === undefined || key === UNSET_KEY ? null : BigInt(key);
    this.intent('moveTask', { cardId: BigInt(idStr), attributeName: this.axisAttr, value });
  }

  /**
   * Open the quick-entry overlay. When `columnKey` is given (the column `+`),
   * prefill the dragged-onto axis value on the CURRENT axis attribute so the new
   * task lands in that column (the `(unset)` column passes no prefill). The
   * parent is scoped to the current project by the overlay itself.
   */
  private openQuickEntry(columnKey?: string, laneKey?: string): void {
    const prefill: {
      laneAttribute?: { name: string; value: unknown };
      extraAttributes?: Array<{ name: string; value: unknown }>;
    } = {};
    if (columnKey !== undefined && columnKey !== UNSET_KEY) {
      prefill.laneAttribute = { name: this.axisAttr, value: BigInt(columnKey) };
    }
    // In a swim lane, also stamp the new task's lane-axis value so it lands here.
    const lane = this.lane;
    if (lane !== null && laneKey !== undefined && laneKey !== UNSET_KEY) {
      prefill.extraAttributes = [{ name: lane.attr, value: BigInt(laneKey) }];
    }
    const detail =
      prefill.laneAttribute !== undefined || prefill.extraAttributes !== undefined
        ? { prefill }
        : {};
    this.ctx.bus?.emit('quickCreateOpen', detail);
  }

  /** Bump the tasks-query version leaf so the `{ signal }` trigger refires. A
   *  plain write outside any tracked effect — one-way, cascade-safe. */
  private bumpQuery(): void {
    const node = this.ctx.tree.at(['kanban', 'queryVersion']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /** Bump the group version leaf so the board render re-keys the columns (GROUP
   *  change or a late-landing axis list) WITHOUT re-issuing the tasks query.
   *  One-way, cascade-safe. */
  private bumpGroup(): void {
    const node = this.ctx.tree.at(['kanban', 'groupVersion']);
    node.set((node.peek<number>() ?? 0) + 1);
  }
}

/* -------------------------------------------------------------------------- */
/* Column + TaskCard — registered so a future screen card can declare them as  */
/* standalone controls; the Kanban board renders them inline for v1 perf.      */
/* -------------------------------------------------------------------------- */

/**
 * Standalone Column control (registered for the controls-and-rules de-dup
 * map). The board above renders columns inline (one effect rebuilds the whole
 * board) rather than spawning a Control per column, so this is a thin shell
 * kept registered for parity + future screen-card-driven composition.
 */
export class Column extends Control<ColumnConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'col';
    el.dataset.control = 'Column';
    return el;
  }
  protected render(): void {
    // Inline-rendered by Kanban today; nothing to do standalone.
  }
}

/** Standalone TaskCard control (see Column note). */
export class TaskCard extends Control<TaskCardConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.control = 'TaskCard';
    return el;
  }
  protected render(): void {
    // Inline-rendered by Kanban today.
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

function titleOf(card: CardWithAttrs): string {
  const t = card.attributes['title'];
  if (typeof t === 'string' && t.length > 0) return t;
  return `Task #${card.id.toString()}`;
}

/** An axis value-card's display label: its `title` attribute (statuses/persons
 *  carry their name there too), else `#id`. */
function labelOf(r: CardWithAttrs): string {
  const t = r.attributes['title'] ?? r.attributes['name'];
  return typeof t === 'string' && t.length > 0 ? t : `#${r.id.toString()}`;
}

/**
 * Compute the insertion slot for a within-column drop. Walks the column body's
 * card nodes (excluding the dragged card) and returns the index of the first
 * card whose vertical midpoint sits BELOW the pointer — i.e. the card the
 * dropped card should land in front of. Past the last card → the bottom slot.
 *
 * Robust to the test DOM shim (which has no real layout): when no node reports
 * a usable rect, the slot falls back to the bottom of the stack, and a
 * test-only override (`data-drop-slot` on the body) lets a test drive an exact
 * insertion index deterministically without faking pointer geometry.
 */
function dropSlot(body: HTMLElement, ev: DragEvent, draggedId: bigint): number {
  // Test seam: an explicit slot on the body wins (the shim can't lay out rects).
  const forced = body.dataset?.dropSlot;
  if (forced !== undefined && /^\d+$/.test(forced)) return Number(forced);

  const y = ev.clientY;
  const nodes = body.querySelectorAll?.('[data-kanban-card]') ?? [];
  let slot = 0;
  for (const node of nodes as unknown as HTMLElement[]) {
    if (node.style?.display === 'none') continue;
    if (node.dataset?.cardId === draggedId.toString()) continue;
    const rect = node.getBoundingClientRect?.();
    if (!rect || (rect.top === 0 && rect.bottom === 0)) continue;
    const mid = rect.top + rect.height / 2;
    if (y < mid) return slot;
    slot += 1;
  }
  return slot;
}

/** Walk a node's descendants for the first with `dataset.role === role`. Works
 *  against both real DOM (HTMLCollection) and the test shim (array children). */
function childByRole(root: HTMLElement, role: string): HTMLElement | null {
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i] as HTMLElement;
    if (el.dataset?.role === role) return el;
    const found = childByRole(el, role);
    if (found) return found;
  }
  return null;
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

export function registerKanbanControls(): void {
  Control.register('Kanban', Kanban);
  Control.register('Column', Column);
  Control.register('TaskCard', TaskCard);
}

/** Test seam: reset module-level drag state between tests. */
export function _resetDragState(): void {
  draggingCardId = null;
}

/** Re-export the context type so callers don't reach into core. */
export type { ControlContext };

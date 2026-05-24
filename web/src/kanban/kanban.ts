/**
 * Kanban board controls — Kanban + Column + TaskCard.
 *
 * The board groups tasks by an axis attribute (default `milestone_ref`),
 * rendering one Column per axis value-card id plus a trailing `(unset)` column.
 * A TaskCard drags between columns with an OPTIMISTIC move that auto-rolls-back
 * on fault — wired entirely through the declarative data layer (no promises,
 * no `await`, no `call(...)` in any control body).
 *
 * Data flow (declarative):
 *   - static query `tasks`      → card.select_with_attributes (card_type_name
 *     'task', parent = scope.projectId), result toPath 'kanban.tasks'. Refires
 *     on a `kanban.queryVersion` leaf the board bumps for scope changes AND
 *     filter changes (shared search + the Advanced structured predicate, ANDed
 *     into the query via where[]/tree — same contract the Grid uses).
 *   - static query `milestones` → card.select (card_type_name 'milestone',
 *     parent = scope.projectId), result method 'landMilestones' (which writes
 *     the axis value-card ids to 'kanban.milestones').
 *   - static action `moveTask` (intent 'moveTask') → attribute.update of the
 *     moved card's axis attribute, with an OPTIMISTIC patch that re-buckets the
 *     card in 'kanban.tasks' and an auto-rollback on fault, onError 'top'.
 *
 * The render reads `ctx.tree.at('kanban.tasks')` and `…('kanban.milestones')`
 * reactively; drag-drop fires `this.intent('moveTask', {...})`. The DataController
 * owns every async outcome.
 *
 * Each column's card list is a recycling `virtualList` (fixed card height). The
 * board re-renders on every tasks change (the optimistic move re-buckets); each
 * board render DISPOSES the prior columns' virtualLists and creates fresh ones,
 * so nothing leaks across re-renders. Drag/drop survives recycling: the
 * dragstart listener is attached ONCE per pooled card node and reads the dragged
 * card id from the node's `data-card-id` — which `update(el, card, i)` sets from
 * the ITEM, never from stale node state (a pooled node is reassigned to a
 * different card on scroll). The drop target stays the column body; the drop
 * resolves the target column key + the in-flight drag id into the declarative
 * `moveTask` intent exactly as before.
 *
 * Stubbed / deferred (documented):
 *   - Within-column reorder (the sort_order rewrite via planSortRewrite/
 *     computeMoveBatch). The helpers are lifted + unit-tested and ready; the
 *     drag UI here only does cross-column moves for v1.
 *   - Swim lanes (the 2-D group_by_attr axis).
 *   - QuickEntryOverlay per-column `+`, keyboard hjkl card nav.
 */

import { Control, type BaseControlConfig, type ControlContext } from '../core/control.js';
import type { ActionBinding, QueryBinding } from '../core/data.js';
import type { ApiFault } from '../core/dispatch.js';
import { virtualList, type VirtualListHandle } from '../core/virtual-list.js';
import { SPEC } from './specs.js';
import {
  bucketByColumn,
  bucketKeyOf,
  columnOrder,
  sortByOrder,
  UNSET_KEY,
  type CardWithAttrs,
} from './kanban-helpers.js';
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

/* -------------------------------------------------------------------------- */
/* Configs + declaration-merged registry types.                              */
/* -------------------------------------------------------------------------- */

export interface KanbanConfig extends BaseControlConfig {
  type: 'Kanban';
  /** The grouping attribute (column axis). Default 'milestone_ref'. */
  columnAttr?: string;
  /** card_type to load as columns' value cards. Default 'milestone'. */
  axisCardType?: string;
  /** Tree path the loaded tasks live at. Default 'kanban.tasks'. */
  tasksPath?: string;
  /** Tree path the axis value-cards live at. Default 'kanban.milestones'. */
  milestonesPath?: string;
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
/* Axis value-card (a milestone the column is keyed by).                       */
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
   * Default axis (the current demo board groups by milestone). The result tree
   * paths are fixed at 'kanban.tasks' / 'kanban.milestones' to match the static
   * binding tables and the landTasks/landMilestones handlers; `columnAttr` /
   * `axisCardType` remain config-overridable for a future screen-card-driven
   * board.
   */
  private get columnAttr(): string {
    return this.config.columnAttr ?? 'milestone_ref';
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

  /**
   * CLASS-STATIC binding table. The instance config is merged on top, so a
   * screen card could later override paths/axis without a code change.
   */
  static override queries: readonly QueryBinding[] = [
    {
      // Tasks for the in-scope project. Refires on a single `kanban.queryVersion`
      // leaf the board bumps for project switch AND filter (search + Advanced
      // predicate) changes — the same one-way query-version pattern the Grid uses.
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
    {
      // Axis value-cards (milestones) for the in-scope project. Uses
      // select_with_attributes (NOT card.select) because the lighter card.select
      // read returns title:null — the column header needs the real `title`
      // attribute, which only select_with_attributes carries. (Matches the
      // Svelte KanbanLayout, which loads every axis value-card with attributes.)
      name: 'milestones',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: {
        cardTypeName: { lit: 'milestone' },
        parentCardId: { from: 'scope.projectId' },
      },
      // Same scope guard as tasks: no axis cards until the project resolves.
      skipWhenNull: ['parentCardId'],
      result: { method: 'landMilestones' },
      onError: 'self',
    },
  ];

  static override actions: readonly ActionBinding[] = [
    {
      // Optimistic cross-column move. Patch re-buckets the moved card in the
      // tasks array immediately; the spec fires attribute.update of the axis
      // attribute; on fault the tree transaction auto-rolls-back and the fault
      // funnels to the top-level handler.
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
  ];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'kanban';
    el.dataset.control = 'Kanban';
    el.tabIndex = -1;
    return el;
  }

  protected render(): void {
    // Named result sinks for the two queries (method-route demonstrates the
    // decode → tree-write split; landMilestones derives the axis card list).
    this.handler('landTasks', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      this.ctx.tree.at(['kanban', 'tasks']).set(rows);
    });
    this.handler('landMilestones', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const axis: AxisCard[] = rows.map((r) => {
        const t = r.attributes?.['title'];
        return {
          id: r.id,
          label: typeof t === 'string' && t.length > 0 ? t : `#${r.id.toString()}`,
        };
      });
      this.ctx.tree.at(['kanban', 'milestones']).set(axis);
    });

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
    // after render). where/tree start empty; queryVersion starts at 0. Plain
    // seeds — the Object.is gate makes a re-seed a no-op.
    this.ctx.tree.at(['kanban', 'where']).set(undefined);
    this.ctx.tree.at(['kanban', 'tree']).set(undefined);
    const versionNode = this.ctx.tree.at(['kanban', 'queryVersion']);
    if (versionNode.peek<number>() === undefined) versionNode.set(0);

    const tasksNode = this.ctx.tree.at(['kanban', 'tasks']);
    const axisNode = this.ctx.tree.at(['kanban', 'milestones']);

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

    // ONE effect renders the whole board reactively from the two tree paths.
    // Re-bucketing on every tasks change is what makes the optimistic move (and
    // its rollback) re-render the columns with no extra wiring.
    this.effect(() => {
      const tasks = (tasksNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
      const axis = (axisNode.get<AxisCard[]>() ?? []) as AxisCard[];
      this.renderBoard(board, tasks, axis);
    }, 'kanban.board');

    // Dispose any live column virtualLists when the Kanban itself is torn down.
    this.onDestroy(() => this.disposeColumnLists());
  }

  /** Dispose + clear the live per-column virtualLists (before a board rebuild
   *  and on Kanban destroy) so no effect / scroll listener / RO leaks. */
  private disposeColumnLists(): void {
    for (const vl of this.columnLists) vl.dispose();
    this.columnLists = [];
  }

  /** Rebuild the column DOM from the current tasks + axis value-cards. */
  private renderBoard(board: HTMLElement, tasks: CardWithAttrs[], axis: AxisCard[]): void {
    // Dispose the prior render's column virtualLists before replacing the DOM
    // they were bound to (replaceChildren below detaches their containers).
    this.disposeColumnLists();

    const attr = this.columnAttr;
    const buckets = bucketByColumn(tasks, attr);
    const order = columnOrder(
      axis.map((a) => a.id),
      Object.keys(buckets),
    );
    const labelById = new Map<string, string>();
    for (const a of axis) labelById.set(a.id.toString(), a.label);

    const cols: HTMLElement[] = [];
    for (const key of order) {
      const cards = sortByOrder([...(buckets[key] ?? [])]);
      const label = key === UNSET_KEY ? '(unset)' : (labelById.get(key) ?? `#${key}`);
      cols.push(this.renderColumn(key, label, cards));
    }
    board.replaceChildren(...cols);
  }

  /** One column: header (label · count · +) + a body of TaskCards + drop zone. */
  private renderColumn(columnKey: string, label: string, cards: CardWithAttrs[]): HTMLElement {
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.kanbanColumn = '';
    col.dataset.column = columnKey;

    const header = document.createElement('div');
    header.className = 'col__header';
    const labelEl = document.createElement('span');
    labelEl.className = 'col__label';
    labelEl.textContent = label;
    const count = document.createElement('span');
    count.className = 'col__count muted';
    count.textContent = String(cards.length);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'col__add';
    add.textContent = '+';
    add.title = 'Quick-add (not wired in v1)';
    add.disabled = true;
    header.append(labelEl, count, add);

    const body = document.createElement('div');
    body.className = 'col__body scroll-y';
    body.dataset.kanbanColumnBody = '';

    const empty = document.createElement('div');
    empty.className = 'col__empty muted';
    empty.textContent = 'No tasks';
    empty.style.display = cards.length === 0 ? '' : 'none';

    if (cards.length === 0) {
      // Empty column: no virtualList (nothing to recycle), just the placeholder.
      body.append(empty);
    } else {
      // The column's card list is a recycling virtualList. `cards` is this
      // render's stable snapshot (the whole board re-renders on a tasks change,
      // which disposes + recreates these lists). create(el) builds the card
      // shell + attaches the dragstart/dragend listeners ONCE; update(el, card)
      // swaps content + sets data-card-id from the ITEM so the drag payload is
      // never stale node state.
      const vl = virtualList<CardWithAttrs>({
        container: body,
        rowHeight: KANBAN_CARD_HEIGHT,
        data: () => cards,
        key: (card) => card.id.toString(),
        create: (el) => this.buildCardShell(el),
        update: (el, card) => this.fillCard(el, card),
        name: `kanban.col.${columnKey}`,
      });
      this.columnLists.push(vl);
    }

    // The column body is a drop target. On drop we re-bucket the dragged card
    // into THIS column by firing the declarative move intent.
    this.listen(body, 'dragover', (ev) => {
      ev.preventDefault();
      col.classList.add('col--drop');
    });
    this.listen(body, 'dragleave', () => col.classList.remove('col--drop'));
    this.listen(body, 'drop', (ev) => {
      ev.preventDefault();
      col.classList.remove('col--drop');
      this.onDropInto(columnKey);
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
    });
  }

  /** Swap a pooled card's content for `card` (virtualList `update`). Sets
   *  data-card-id from the ITEM so the drag payload + drop reads are current. */
  private fillCard(el: HTMLElement, card: CardWithAttrs): void {
    el.dataset.cardId = card.id.toString();
    const title = childByRole(el, 'title');
    if (title) title.textContent = titleOf(card);
    const meta = childByRole(el, 'meta');
    if (meta) meta.textContent = `#${card.id.toString()}`;
  }

  /**
   * Resolve the dragged card + target column key into a declarative move
   * intent. The axis attribute value is the target column's value-card id
   * (bigint), or `null` for the `(unset)` column (clears the attribute).
   */
  private onDropInto(targetColumnKey: string): void {
    const cardId = draggingCardId;
    draggingCardId = null;
    if (cardId === null) return;

    const tasks = (this.ctx.tree.at(['kanban', 'tasks']).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    const card = tasks.find((t) => t.id === cardId);
    if (!card) return;

    const attr = this.columnAttr;
    const currentKey = bucketKeyOf(card.attributes[attr]);
    if (currentKey === targetColumnKey) return; // no-op drop (same column)

    const value: bigint | null = targetColumnKey === UNSET_KEY ? null : BigInt(targetColumnKey);
    this.intent('moveTask', { cardId, attributeName: attr, value });
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

  /** Bump the tasks-query version leaf so the `{ signal }` trigger refires. A
   *  plain write outside any tracked effect — one-way, cascade-safe. */
  private bumpQuery(): void {
    const node = this.ctx.tree.at(['kanban', 'queryVersion']);
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

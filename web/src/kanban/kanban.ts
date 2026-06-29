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
import { rowLink, setRowLinkHref } from '../shell/popout.js';
import { SPEC } from './specs.js';
import {
  bucketByKey,
  bucketKeyOf,
  columnOrder,
  planSortRewrite,
  sortByOrder,
  UNSET_KEY,
  type CardWithAttrs,
} from './kanban-helpers.js';
import { type GroupAttr } from '../filter/group-axis.js';
import { tagIdUnderRoot, tagLeaf } from '../filter/tag-prefix.js';
import { TAG_APPLY_SPEC, TAG_REMOVE_SPEC } from '../task-detail/attachment-specs.js';
import { KANBAN_DEFAULT_GROUP_ATTR } from '../filter/screen-resolve.js';
import type { CardWherePredicate } from '../projects/project-helpers.js';
import {
  type Predicate,
  type Phase,
  applySearchFilter,
  topLevelPhases,
} from '../filter/predicate.js';

import { icon } from '../ui/icons.js';
import { type StatusGlyph } from '../ui/status-icon.js';
import { isPriorityPath, priorityIcon, priorityPlaceholder } from '../ui/priority-icon.js';
/**
 * Fixed virtual-list row height (px) for a kanban card slot: the card (grip +
 * up-to-two-line title + bottom meta row) plus the inter-card gap baked in,
 * sized like a Linear issue card. The virtualList tiles slots by this exact
 * pitch; buildCardShell shrinks the visible card to HEIGHT − GAP so adjacent
 * cards show a true gap. test/kanban-card-layout.test.mjs pins the visible
 * height.
 */
const KANBAN_CARD_HEIGHT = 112;
/** Visible gap (px) between stacked cards, inside each slot's pitch. */
const KANBAN_CARD_GAP = 8;

/** The default axis when no GROUP is picked: group columns by milestone. The
 *  attr is shared with the filter bar (via screen-resolve) so the board's
 *  fallback and the GROUP picker's default can't drift apart. */
const DEFAULT_AXIS_ATTR = KANBAN_DEFAULT_GROUP_ATTR;
const DEFAULT_AXIS_LOOKUP = 'statuses';

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
  /** Top-level `phase` (statuses only) — drives column visibility when a phase
   *  scope is set on a status-grouped board: out-of-phase columns are hidden. */
  phase?: Phase;
  /** The value-card's `sort_order` attribute, used to sequence the kanban's
   *  columns / lanes. Falls back to +Inf for cards that never had it written,
   *  so explicit-order cards always lead untouched ones. */
  sortOrder: number;
  /** Named palette tone (tag cards only — `color` attribute). Empty / absent
   *  leaves the chip in its neutral default. */
  color?: string;
  /** Tag cards only: the slash-delimited `path` ('priority/high') — its leaf is
   *  the column/lane label under a tag-prefix axis. */
  path?: string;
  /** Tag cards only: the `root_exclusive_at` segment ('priority') — the prefix
   *  this tag is groupable under, and the membership test for that prefix's
   *  columns. Empty / absent for non-exclusive tags. */
  rootExclusiveAt?: string;
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

  /** A bucket-key resolver for [axis], with any tag root map precomputed once
   *  (so a per-card key is O(1)). For a tag-prefix axis the key is the id of the
   *  card's single tag under that exclusive root (or UNSET); otherwise it's the
   *  scalar value of the axis attribute. Shared by columns + swim lanes. */
  private keyer(axis: GroupAttr | null): (card: CardWithAttrs) => string {
    const prefix = axis?.tagPrefix;
    if (prefix !== undefined) {
      const rootMap = this.tagRootMap();
      return (card) => tagIdUnderRoot(card.attributes['tags'], rootMap, prefix) ?? UNSET_KEY;
    }
    const attr = axis?.attr ?? DEFAULT_AXIS_ATTR;
    return (card) => bucketKeyOf(card.attributes[attr]);
  }

  /** id→exclusive-root map over the loaded tag value-cards (tag-prefix keying). */
  private tagRootMap(): Map<string, string> {
    const tags = (this.ctx.tree.at(['kanban', 'axis', 'tags']).peek<AxisCard[]>() ?? []) as AxisCard[];
    const m = new Map<string, string>();
    for (const t of tags) if (t.rootExclusiveAt !== undefined) m.set(t.id.toString(), t.rootExclusiveAt);
    return m;
  }

  /** The column/lane LABEL for a value-card on [axis]: a tag-prefix axis shows
   *  the tag's leaf ('priority/high' → 'high'); any other axis its plain label. */
  private axisLabelOf(card: AxisCard, axis: GroupAttr | null): string {
    if (axis?.tagPrefix !== undefined) return tagLeaf(card.path ?? card.label);
    return card.label;
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

  /** The LOGICAL card cursor — a (column, lane, card-id) coordinate, NOT a
   *  focused DOM node, so it survives card recycling. j/k move within a column,
   *  h/l across columns; the highlight + auto-scroll (board horizontally, column
   *  body vertically) follow it. Null until the user navigates / it's restored. */
  private cursor: { columnKey: string; laneKey: string | undefined; cardId: bigint } | null = null;
  /** Set once the remembered cursor has been restored on the first board render. */
  private cursorRestored = false;
  /** The cursor RING paints only after the keyboard actually drives the cursor
   *  (j/k/h/l, board entry). A restore or a mouse-click sets the LOGICAL
   *  cursor silently — returning from a task must not outline the card. */
  private cursorVisible = false;
  /** Per-(lane, column) last-focused card id. h/l returns the cursor to where it
   *  last sat in each column instead of snapping to the top every time — the
   *  vertical position is tracked per column, not shared across the board. Keyed
   *  by {@link columnMemoryKey}; updated whenever the cursor settles (revealCursor). */
  private readonly columnCursorMemory = new Map<string, bigint>();

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
    {
      // Optimistic CROSS-COLUMN move on a TAG-PREFIX axis. Re-keying a tag
      // prefix isn't a scalar attribute set (that would clobber the whole `tags`
      // array) — it's `tag.apply`, which the server resolves atomically: it adds
      // the target tag AND drops any sibling sharing its `root_exclusive_at`,
      // preserving the card's other tags. The optimistic patch sets the card's
      // `tags` to the array the client precomputed (payload.tags) so the move
      // shows instantly; the wire call only carries target/tag ids.
      intent: 'applyTag',
      spec: TAG_APPLY_SPEC,
      input: {
        targetCardId: { payload: 'cardId' },
        tagCardId: { payload: 'tagId' },
      },
      optimistic: { path: 'kanban.tasks', patch: patchTags },
      onError: 'top',
    },
    {
      // Optimistic move into the `(unset)` column of a tag-prefix axis: drop the
      // card's current tag under that root via `tag.remove`. Same optimistic
      // `tags` rewrite as applyTag.
      intent: 'removeTag',
      spec: TAG_REMOVE_SPEC,
      input: {
        targetCardId: { payload: 'cardId' },
        tagCardId: { payload: 'tagId' },
      },
      optimistic: { path: 'kanban.tasks', patch: patchTags },
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
    board.tabIndex = -1; // programmatically focusable so Enter opens the cursor card
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
      const fields = this.ctx.tree.at(['screen', 'searchFields']).get<string[]>() ?? ['title'];
      this.applyFilter(search, fields, predicate);
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

    // Workflow restriction (#16): when a project's status flow exists, the
    // status-grouped board hides columns for statuses the flow doesn't include.
    // Reads scope.projectId; writes `kanban.workflowStatusIds` (a Set<bigint>
    // of in-workflow status card ids, or null when no flow applies → no filter).
    // One-way; the board render effect subscribes to the leaf so a late landing
    // re-keys the columns without a re-issued tasks query.
    this.effect(() => {
      this.ctx.tree.at(['scope', 'projectId']).get();
      this.loadWorkflowStatuses();
    }, 'kanban.workflowStatuses');

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
    // version re-keys the columns when the GROUP picker changes. Subscribing
    // to `screen.predicate` here re-renders the board when only the phase scope
    // changes (status-axis columns hide out-of-phase value cards in that case).
    this.effect(() => {
      const tasks = (tasksNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
      this.ctx.tree.at(['kanban', 'groupVersion']).get(); // re-key on a GROUP change
      this.ctx.tree.at(['screen', 'predicate']).get(); // re-key on a PHASE change
      this.ctx.tree.at(['kanban', 'workflowStatusIds']).get(); // re-key when workflow lands
      const axis = this.activeAxisCards();
      this.renderBoard(board, tasks, axis);
      // Restore the remembered logical cursor on the first render after (re)mount.
      this.restoreCursor(tasks);
      // Keep the cursor's (column, lane) coordinate consistent with the axis
      // that was just rendered. A GROUP / LANE switch — or the persisted group
      // axis resolving AFTER a cursor restore — re-keys the columns, which would
      // otherwise strand the cursor's stored column key against the old axis and
      // make j/k/h/l silently no-op (the card no longer sits in that bucket).
      this.syncCursorColumn();
    }, 'kanban.board');

    // Switching back to the mouse dismisses the keyboard-cursor ring: real
    // pointer movement over the board hides it (the LOGICAL cursor stays, so
    // j/k resume from the same card). Coordinates are compared because the
    // browser re-fires a synthetic pointermove when keyboard navigation
    // auto-scrolls content under a stationary pointer — only actual motion
    // counts as "using the mouse again".
    let lastPointer: { x: number; y: number } | null = null;
    this.listen(board, 'pointermove', (ev) => {
      const e = ev as PointerEvent;
      const moved = lastPointer !== null && (lastPointer.x !== e.clientX || lastPointer.y !== e.clientY);
      lastPointer = { x: e.clientX, y: e.clientY };
      if (moved && this.cursorVisible) {
        this.cursorVisible = false;
        this.repaintCursor();
      }
    });

    // Enter / o on the focused board opens the cursor card. A focused CARD
    // handles its own Enter (card keydown); this is the board-focused case.
    this.listen(board, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key !== 'Enter' && e.key !== 'o') return;
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest('[data-kanban-card]')) return;
      e.preventDefault();
      this.openCursor();
    });

    // The search box's ArrowDown hands focus to the board (screen.enterBodyNonce);
    // place the cursor on the first card so j/k/h/l/Enter operate on the board.
    this.effect(() => {
      const n = this.ctx.tree.at(['screen', 'enterBodyNonce']).get<number>() ?? 0;
      if (n === 0) return;
      this.cursorVisible = true;
      if (this.cursor === null) this.cursorToFirst();
      else this.revealCursor();
    }, 'kanban.enterBody');

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
    // kanban.axis.<lookup>. The board reads only the active axis's list. The
    // list is sorted by each value-card's explicit `sort_order` so the column
    // / lane sequence matches the operator's ordering (the server returns rows
    // in default id / created_at order — without this the kanban sequenced
    // statuses / milestones arbitrarily).
    const landAxis = (lookup: string) => (out: unknown) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const axis = sortAxisCards(rows.map((r) => axisCardOf(r)));
      this.ctx.tree.at(['kanban', 'axis', lookup]).set(axis);
      // Re-key the columns when a late-landing axis list arrives for the active
      // axis (the board render reads the group version).
      this.bumpGroup();
    };

    // milestones ALSO lands at the legacy `kanban.milestones` path (existing
    // tests + any external reader), in addition to the unified axis path.
    this.handler('landMilestones', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const axis = sortAxisCards(rows.map((r) => axisCardOf(r)));
      this.ctx.tree.at(['kanban', 'milestones']).set(axis);
      this.ctx.tree.at(['kanban', 'axis', 'milestones']).set(axis);
      this.bumpGroup();
    });
    this.handler('landStatuses', landAxis('statuses'));
    this.handler('landComponents', landAxis('components'));
    this.handler('landPersons', landAxis('persons'));
    this.handler('landTags', landAxis('tags'));
  }

  /** The value-card list for the ACTIVE axis (peeked — the board render reads
   *  the group version separately to subscribe to axis switches + late lands).
   *  Two status-specific restrictions stack: phase scope (`screen.predicate`'s
   *  `has_phase` leaf hides out-of-phase columns) and workflow restriction
   *  (`kanban.workflowStatusIds`, the set of status ids the project's status
   *  flow uses, hides statuses the workflow doesn't include). Both peek; the
   *  board render subscribes to the underlying leaves separately. */
  private activeAxisCards(): AxisCard[] {
    return this.axisCardsFor(this.axis);
  }

  /** The value-card list for ANY axis (column or lane). For a tag-prefix axis
   *  it's the tags under that exclusive root; otherwise the axis's full
   *  value-card list, with the status-only phase / workflow restrictions
   *  applied (those only matter for the column axis, which is the status case). */
  private axisCardsFor(axis: GroupAttr | null): AxisCard[] {
    const lookup = axis?.lookup ?? DEFAULT_AXIS_LOOKUP;
    const all = (this.ctx.tree.at(['kanban', 'axis', lookup]).peek<AxisCard[]>() ?? []) as AxisCard[];
    if (axis?.tagPrefix !== undefined) {
      return all.filter((a) => a.rootExclusiveAt === axis.tagPrefix);
    }
    if (lookup !== 'statuses') return all;
    let out = all;
    // Workflow restriction: when the project's status flow has loaded, keep
    // only the statuses the workflow includes; null = no workflow → no filter.
    const wf = this.ctx.tree.at(['kanban', 'workflowStatusIds']).peek<Set<bigint> | null>() ?? null;
    if (wf !== null && wf.size > 0) {
      out = out.filter((a) => wf.has(a.id));
    }
    // Phase restriction (#15): keep only statuses whose phase the user scoped to.
    const predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    const phases = topLevelPhases(predicate);
    if (phases.length > 0) {
      const allow = new Set<Phase>(phases);
      out = out.filter((a) => a.phase === undefined || allow.has(a.phase));
    }
    return out;
  }

  /**
   * Load the project's status workflow + its steps, then land the set of
   * in-workflow status card ids at `kanban.workflowStatusIds`. Two sequential
   * batched reads (`flow.list` → `flow_step.list`) — the second can't fire
   * until the flow id resolves from the first. The first that mentions the
   * `status` attribute wins (multi-flow projects pick a deterministic one by
   * the server's row order). Clearing the leaf to null when no flow applies
   * → the activeAxisCards filter falls back to "show every status".
   */
  private loadWorkflowStatuses(): void {
    const pid = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
    if (pid === null) {
      this.ctx.tree.at(['kanban', 'workflowStatusIds']).set(null);
      return;
    }
    this.ctx.api.callByName(
      'flow.list',
      { scopeCardId: pid },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out ?? {}) as { rows?: Array<{ id: string; attribute_def_name?: string }> }).rows ?? [];
        const flow = rows.find((r) => r.attribute_def_name === 'status') ?? null;
        if (flow === null) {
          this.ctx.tree.at(['kanban', 'workflowStatusIds']).set(null);
          this.bumpGroup();
          return;
        }
        this.ctx.api.callByName(
          'flow_step.list',
          { flowId: flow.id },
          (stepsOut) => {
            if (!this.isAlive()) return;
            const stepRows = ((stepsOut ?? {}) as { rows?: Array<{ from_card_id: string; to_card_id: string }> }).rows ?? [];
            const ids = new Set<bigint>();
            const add = (s: string): void => {
              if (/^-?\d+$/.test(s)) ids.add(BigInt(s));
            };
            for (const r of stepRows) {
              add(r.from_card_id);
              add(r.to_card_id);
            }
            this.ctx.tree.at(['kanban', 'workflowStatusIds']).set(ids.size > 0 ? ids : null);
            this.bumpGroup();
          },
          { alive: () => this.isAlive() },
        );
      },
      { alive: () => this.isAlive() },
    );
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
    const lane = this.lane;
    const laned = laneKey !== undefined && lane !== null && !this.laneIsColumnAxis(lane);
    const colKeyOf = this.keyer(this.axis);
    const laneKeyOf = laned ? this.keyer(lane) : null;
    const out = tasks.filter((t) => {
      if (colKeyOf(t) !== columnKey) return false;
      if (laneKeyOf !== null && laneKeyOf(t) !== laneKey) return false;
      return true;
    });
    return sortByOrder(out);
  }

  /** A signature of the board's column/lane STRUCTURE (which columns/lanes exist,
   *  their order + labels) — NOT their card contents. renderBoard rebuilds the
   *  DOM only when this changes; card moves within the same structure flow
   *  through each column's reactive `data()`. */
  private computeStructureKey(tasks: readonly CardWithAttrs[], axis: AxisCard[]): string {
    const lane = this.lane;
    const laned = lane !== null && !this.laneIsColumnAxis(lane);
    const colKeyOf = this.keyer(this.axis);
    const colPart = (scoped: readonly CardWithAttrs[]): string => {
      const order = columnOrder(axis.map((a) => a.id), Object.keys(bucketByKey(scoped, colKeyOf)));
      const labelById = new Map(axis.map((a) => [a.id.toString(), this.axisLabelOf(a, this.axis)]));
      return order.map((k) => `${k}=${k === UNSET_KEY ? '∅' : labelById.get(k) ?? `#${k}`}`).join(',');
    };
    if (!laned) return `flat|${this.axisSig(this.axis)}|${colPart(tasks)}`;
    const laneCards = this.axisCardsFor(lane);
    const laneKeyOf = this.keyer(lane);
    const laneBuckets = bucketByKey(tasks, laneKeyOf);
    const laneOrder = columnOrder(laneCards.map((c) => c.id), Object.keys(laneBuckets));
    const laneLabel = new Map(laneCards.map((c) => [c.id.toString(), this.axisLabelOf(c, lane)]));
    const parts = laneOrder.map(
      (lk) => `${lk}=${lk === UNSET_KEY ? '∅' : laneLabel.get(lk) ?? `#${lk}`}[${colPart(laneBuckets[lk] ?? [])}]`,
    );
    return `lane|${this.axisSig(this.axis)}|${this.axisSig(lane)}|${parts.join(';')}`;
  }

  /** A stable signature for an axis (attr + any tag prefix) used in the
   *  structure key so a prefix switch (priority → severity) rebuilds the DOM. */
  private axisSig(axis: GroupAttr | null): string {
    return axis?.tagPrefix !== undefined ? `tags:${axis.tagPrefix}` : (axis?.attr ?? this.axisAttr);
  }

  /** Whether [lane] addresses the SAME axis as the column axis — by signature,
   *  not bare attr, so two distinct tag prefixes (both `attr='tags'`, e.g.
   *  priority columns × severity lanes) are correctly seen as different axes
   *  rather than collapsing to "no lanes". */
  private laneIsColumnAxis(lane: GroupAttr): boolean {
    return this.axisSig(lane) === this.axisSig(this.axis);
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
    if (lane === null || this.laneIsColumnAxis(lane)) {
      board.classList.remove('kanban--laned');
      board.replaceChildren(...this.renderColumnRow(tasks, axis));
      return;
    }

    board.classList.add('kanban--laned');
    const laneCards = this.axisCardsFor(lane);
    const laneBuckets = bucketByKey(tasks, this.keyer(lane));
    const laneOrder = columnOrder(
      laneCards.map((c) => c.id),
      Object.keys(laneBuckets),
    );
    const laneLabelById = new Map<string, string>();
    for (const c of laneCards) laneLabelById.set(c.id.toString(), this.axisLabelOf(c, lane));

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
    const buckets = bucketByKey(tasks, this.keyer(this.axis));
    const order = columnOrder(
      axis.map((a) => a.id),
      Object.keys(buckets),
    );
    const labelById = new Map<string, string>();
    // Phase per axis value — only status cards carry a phase; a status-grouped
    // board tints its column-header pill by phase (triage/active/terminal).
    const glyphById = new Map<string, StatusGlyph>();
    for (const a of axis) {
      const label = this.axisLabelOf(a, this.axis);
      labelById.set(a.id.toString(), label);
      if (a.phase !== undefined) glyphById.set(a.id.toString(), { phase: a.phase });
    }
    const cols: HTMLElement[] = [];
    for (const key of order) {
      const label = key === UNSET_KEY ? '(unset)' : (labelById.get(key) ?? `#${key}`);
      cols.push(this.renderColumn(key, label, laneKey, glyphById.get(key)));
    }
    return cols;
  }

  /** One column: header (label · count · +) + a body of TaskCards + drop zone.
   *  The card list reads the tasks leaf reactively (via `bucketColumn`), so it
   *  recycles in place on a move; the count + empty placeholder track it. */
  private renderColumn(
    columnKey: string,
    label: string,
    laneKey?: string,
    glyph?: StatusGlyph,
  ): HTMLElement {
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
    // Status columns wear their label in a phase-tinted pill (matching the
    // grid/list status chips); non-status axes keep the plain label.
    if (glyph !== undefined) {
      const pill = document.createElement('span');
      pill.className = 'col__status-pill';
      pill.dataset.phase = glyph.phase;
      pill.append(labelEl);
      header.append(pill, count, add);
    } else {
      header.append(labelEl, count, add);
    }

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
    // The slot el IS the card: shrink it inside the fixed slot pitch so
    // stacked cards show a real gap (the virtualList's inline height would
    // otherwise make borders abut edge-to-edge).
    el.style.height = `${KANBAN_CARD_HEIGHT - KANBAN_CARD_GAP}px`;

    const title = document.createElement('div');
    title.className = 'card__title';
    title.dataset.role = 'title';

    // Row 2: priority + tag chips on the left (clip), created date on the right.
    const metaRow = document.createElement('div');
    metaRow.className = 'card__row card__row--meta';
    const tags = document.createElement('div');
    tags.className = 'card__meta muted';
    tags.dataset.role = 'tags';
    const date = document.createElement('div');
    date.className = 'card__date muted';
    date.dataset.role = 'date';
    metaRow.append(tags, date);

    // Row 3: ticket id on the left, the assignee avatar on the right.
    const idRow = document.createElement('div');
    idRow.className = 'card__row card__row--id';
    const idText = document.createElement('span');
    idText.className = 'card__idrow muted';
    idText.dataset.role = 'id';
    const assignee = document.createElement('span');
    assignee.className = 'card__assignee';
    assignee.dataset.role = 'assignee';
    idRow.append(idText, assignee);

    // Stretched full-row link covering the card — ⌘/middle/right-click → new
    // tab natively. The card is itself natively draggable; the link's own
    // draggable=false means a mousedown-drag falls through to the card's DnD,
    // and its click handler only special-cases plain vs modified clicks. href
    // set per fill. A plain click bubbles to the card open handler below.
    const link = rowLink();
    link.dataset.role = 'rowlink';

    el.append(title, metaRow, idRow, link);

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
    // Land the LOGICAL cursor on the clicked card + remember it, so returning
    // anchors j/k where the user left off (no visible ring until the keyboard
    // drives the cursor — see cursorVisible).
    const col = el.closest?.('[data-kanban-column]') as HTMLElement | null | undefined;
    if (col) {
      this.cursor = { columnKey: col.dataset?.column ?? '', laneKey: col.dataset?.laneKey ?? undefined, cardId: BigInt(idStr) };
    }
    this.rememberCardId(BigInt(idStr));
    const tasks = (this.ctx.tree.at(['kanban', 'tasks']).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    publishTaskNav(this.ctx.tree, tasks.map((t) => t.id));
    navigate(taskUrl(idStr));
  }

  /** Swap a pooled card's content for `card` (virtualList `update`). Sets
   *  data-card-id from the ITEM so the drag payload + drop reads are current. */
  private fillCard(el: HTMLElement, card: CardWithAttrs): void {
    el.dataset.cardId = card.id.toString();
    // The keyboard-cursor highlight class MUST match `.card--cursor` (styles.css)
    // and `repaintCursor` — so the ring survives a board rebuild / card recycle
    // that re-runs fillCard without a following repaintCursor (e.g. an async axis
    // / workflow-status load re-keying the columns after a cursor restore).
    el.classList.toggle(
      'card--cursor',
      this.cursorVisible && this.cursor !== null && card.id === this.cursor.cardId,
    );
    // The card that just moved settles into its new slot; every other fill
    // clears the class so a recycled node never keeps a stale animation. The id
    // persists past the optimistic re-render (cleared on the next dragstart), so
    // the server-confirm re-render doesn't cut the animation short.
    applySettle(el, 'card--settling', this.settleCardId !== null && card.id === this.settleCardId);
    const title = childByRole(el, 'title');
    if (title) title.textContent = titleOf(card);
    const tagsRow = childByRole(el, 'tags');
    const idRow = childByRole(el, 'id');
    if (tagsRow === null || idRow === null) return;
    // Richer card (#25): the ticket #id sits on its own bottom row; priority +
    // tag chips (resolved from the axis lookups; falls back to ids until those
    // lists land + the board re-renders) ride the row right under the title.
    tagsRow.replaceChildren();
    idRow.replaceChildren();
    const idEl = document.createElement('span');
    idEl.className = 'card__id';
    idEl.textContent = `#${card.id.toString()}`;
    idRow.append(idEl);
    const link = childByRole(el, 'rowlink');
    if (link) setRowLinkHref(link as HTMLAnchorElement, card.id);

    // Created date (top-level audit field) on the right of the tags row.
    const dateEl = childByRole(el, 'date');
    if (dateEl) {
      dateEl.textContent = card.created_at ? `Created ${formatCardDate(card.created_at)}` : '';
    }
    // Assignee NAME on the right of the id row — resolved from the persons axis
    // (id → name); hidden when the task is unassigned.
    const assigneeEl = childByRole(el, 'assignee');
    if (assigneeEl) {
      const aid = card.attributes['assignee'];
      const persons = (this.ctx.tree.at(['kanban', 'axis', 'persons']).peek<AxisCard[]>() ?? []) as AxisCard[];
      const name = typeof aid === 'bigint' ? (persons.find((p) => p.id === aid)?.label ?? '') : '';
      assigneeEl.textContent = name;
      assigneeEl.title = name;
      assigneeEl.style.display = name !== '' ? '' : 'none';
    }

    // The priority indicator leads the row right after the id — ALWAYS:
    // a card without a priority reserves the same footprint (placeholder),
    // so tag chips start from one x position across every card. Priority is
    // pulled out of data order; other tags keep theirs.
    const tags = card.attributes['tags'];
    let bars: HTMLElement | null = null;
    const chips: HTMLElement[] = [];
    if (Array.isArray(tags)) {
      const tagAxis = (this.ctx.tree.at(['kanban', 'axis', 'tags']).peek<AxisCard[]>() ?? []) as AxisCard[];
      for (const t of tags) {
        if (typeof t !== 'bigint') continue;
        const ac = tagAxis.find((c) => c.id === t);
        const path = ac?.label ?? `#${t.toString()}`;
        const leaf = path.includes('/') ? (path.split('/').filter(Boolean).pop() ?? path) : path;
        // A priority tag renders as Linear-style signal bars, not a pill.
        if (isPriorityPath(path) && bars === null) {
          bars = priorityIcon(leaf);
          if (bars !== null) continue;
        }
        const chip = document.createElement('span');
        chip.className = 'tag-chip card__tag';
        chip.dataset.tagChip = '';
        if (ac?.color !== undefined) chip.dataset.tagColor = ac.color;
        const lbl = document.createElement('span');
        lbl.className = 'tag-chip__label';
        lbl.textContent = leaf;
        chip.append(lbl);
        chips.push(chip);
      }
    }
    tagsRow.append(bars ?? priorityPlaceholder(), ...chips);
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
    // lane axis to the target lane's value (moveTask for a scalar axis, or
    // tag.apply/remove for a tag-prefix lane — see rekeyAxis).
    const lane = this.lane;
    if (lane !== null && !this.laneIsColumnAxis(lane) && laneKey !== undefined) {
      this.rekeyAxis(card, cardId, lane, laneKey);
    }

    // CROSS-COLUMN: re-key the dragged card's column axis to the target column.
    this.rekeyAxis(card, cardId, this.axis, targetColumnKey);

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

  /**
   * Re-key a card's [axis] to the target bucket [targetKey], choosing the write
   * by axis kind. A TAG-PREFIX axis re-tags rather than overwriting `tags`:
   * `tag.apply` (into a tag column) or `tag.remove` (into `(unset)`), both of
   * which the server resolves atomically — apply drops any sibling under the
   * same exclusive root, so the card's OTHER tags survive. The optimistic `tags`
   * array is precomputed here to match. A scalar axis re-keys via
   * attribute.update (moveTask). No-op when the card already sits in the target.
   */
  private rekeyAxis(card: CardWithAttrs, cardId: bigint, axis: GroupAttr | null, targetKey: string): void {
    if (this.keyer(axis)(card) === targetKey) return;
    if (axis?.tagPrefix !== undefined) {
      const root = axis.tagPrefix;
      if (targetKey === UNSET_KEY) {
        // Into (unset): drop the card's current tag under this root, if any.
        const curKey = this.keyer(axis)(card);
        if (curKey === UNSET_KEY) return;
        this.intent('removeTag', { cardId, tagId: BigInt(curKey), tags: this.retagArray(card, root, null) });
      } else {
        const addId = BigInt(targetKey);
        this.intent('applyTag', { cardId, tagId: addId, tags: this.retagArray(card, root, addId) });
      }
      return;
    }
    const value: bigint | null = targetKey === UNSET_KEY ? null : BigInt(targetKey);
    this.intent('moveTask', { cardId, attributeName: axis?.attr ?? DEFAULT_AXIS_ATTR, value });
  }

  /** The card's `tags` after an exclusive-root retag: drop every tag it holds
   *  under [root], then add [addId] (null = pure removal). Mirrors tag.apply's
   *  atomic swap so the optimistic view matches what the server stores. */
  private retagArray(card: CardWithAttrs, root: string, addId: bigint | null): bigint[] {
    const rootMap = this.tagRootMap();
    const raw = card.attributes['tags'];
    const kept: bigint[] = [];
    if (Array.isArray(raw)) {
      for (const el of raw) {
        const id = typeof el === 'bigint' ? el : /^-?\d+$/.test(String(el)) ? BigInt(String(el)) : null;
        if (id === null) continue;
        if (rootMap.get(id.toString()) === root) continue; // drop the old tag under this root
        kept.push(id);
      }
    }
    if (addId !== null && !kept.some((id) => id === addId)) kept.push(addId);
    return kept;
  }

  /* ----------------------------- query driver --------------------------- */

  /**
   * Project the shared search + chosen search fields + Advanced structured
   * predicate to the tasks query's `where[]` / `tree` leaves via the shared
   * {@link applySearchFilter} composer. A single-field search keeps the leaf in
   * `where[]` (the common case); a multi-field search wraps the needle in an
   * OR group on `tree`. Empty inputs leave each leaf undefined so the encoder
   * omits them.
   */
  private applyFilter(search: string, fields: readonly string[], predicate: Predicate | null): void {
    const { where, tree } = applySearchFilter(search, fields, predicate);
    this.ctx.tree.at(['kanban', 'where']).set(where as CardWherePredicate[] | undefined);
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
      // ArrowUp/Down navigate cards when the board (not a text field) holds
      // focus. NOT fireInInputs — the search box's own ArrowDown hands focus to
      // the board instead (see ScreenFilterBar), so arrows never hijack typing.
      { binding: 'ArrowDown', label: 'Next card', run: () => this.navCard(1) },
      { binding: 'ArrowUp', label: 'Previous card', run: () => this.navCard(-1) },
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

  /** Tasks currently on the board (logical card source). */
  private boardTasks(): CardWithAttrs[] {
    return (this.ctx.tree.at(this.tasksPath).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
  }

  /** Column elements in the given lane (or the un-laned board), in render order.
   *  Columns are never virtualized, so this DOM order is the logical column
   *  order; only their CARDS recycle. */
  private columnsInLane(laneKey: string | undefined): HTMLElement[] {
    return this.boardColumns().filter((c) => (c.dataset.laneKey ?? undefined) === laneKey);
  }

  /** Stable key for {@link columnCursorMemory} — a (lane, column) coordinate.
   *  The Unit-Separator (U+001F) joiner can't appear in either id-or-`__unset__`
   *  key, so distinct coordinates never collide. */
  private columnMemoryKey(columnKey: string, laneKey: string | undefined): string {
    return `${laneKey ?? ''}\u001f${columnKey}`;
  }

  /** The card the cursor should land on when ENTERING a column via h/l: the last
   *  card it sat on there (if still present), else the column's first card. Keeps
   *  the vertical position per column rather than resetting to the top. */
  private columnEntryCardId(columnKey: string, laneKey: string | undefined, cards: readonly CardWithAttrs[]): bigint {
    const remembered = this.columnCursorMemory.get(this.columnMemoryKey(columnKey, laneKey));
    if (remembered !== undefined && cards.some((c) => c.id === remembered)) return remembered;
    return cards[0]!.id;
  }

  /** The DOM column element the cursor points into. */
  private cursorColEl(): HTMLElement | null {
    if (this.cursor === null) return null;
    return this.columnsInLane(this.cursor.laneKey).find((c) => c.dataset.column === this.cursor!.columnKey) ?? null;
  }

  /** Re-derive the cursor's (column, lane) keys from its card's CURRENT axis
   *  values, so the coordinate tracks the axis the board is rendered under. The
   *  stored keys go stale when the GROUP / LANE axis changes (or resolves async
   *  after a restore); left unsynced, {@link bucketColumn} would look the cursor
   *  card up in a bucket that no longer holds it and j/k/h/l would no-op. A no-op
   *  itself when the keys already match or the card has left the board. */
  private syncCursorColumn(): void {
    if (this.cursor === null) return;
    const card = this.boardTasks().find((t) => t.id === this.cursor!.cardId);
    if (card === undefined) return;
    const laned = this.lane !== null && !this.laneIsColumnAxis(this.lane);
    const columnKey = this.keyer(this.axis)(card);
    const laneKey = laned ? this.keyer(this.lane)(card) : undefined;
    if (columnKey === this.cursor.columnKey && laneKey === this.cursor.laneKey) return;
    this.cursor = { columnKey, laneKey, cardId: this.cursor.cardId };
  }

  /** Place the cursor on the first card of the first non-empty column. */
  private cursorToFirst(): void {
    this.cursorVisible = true;
    for (const col of this.boardColumns()) {
      const columnKey = col.dataset.column;
      if (columnKey === undefined) continue;
      const laneKey = col.dataset.laneKey ?? undefined;
      const cards = this.bucketColumn(this.boardTasks(), columnKey, laneKey);
      if (cards.length > 0) {
        this.cursor = { columnKey, laneKey, cardId: cards[0]!.id };
        this.revealCursor();
        return;
      }
    }
  }

  /** j/k — move the LOGICAL cursor within its column (by card id, so it survives
   *  card recycling), auto-scrolling the column body at the edge. */
  private navCard(dir: 1 | -1): void {
    this.cursorVisible = true;
    if (this.cursor === null) {
      this.cursorToFirst();
      return;
    }
    const cards = this.bucketColumn(this.boardTasks(), this.cursor.columnKey, this.cursor.laneKey);
    const i = cards.findIndex((c) => c.id === this.cursor!.cardId);
    const j = i + dir;
    if (j < 0 || j >= cards.length) {
      // Edge of the column: the cursor doesn't move, but the ring must still
      // reveal (a silently-restored cursor becomes visible on the first press).
      this.revealCursor();
      return;
    }
    this.cursor = { ...this.cursor, cardId: cards[j]!.id };
    this.revealCursor();
  }

  /** h/l — move the cursor to the first card of the next/prev non-empty column in
   *  the same lane, auto-scrolling the board horizontally. */
  private navColumn(dir: 1 | -1): void {
    this.cursorVisible = true;
    if (this.cursor === null) {
      this.cursorToFirst();
      return;
    }
    const cols = this.columnsInLane(this.cursor.laneKey);
    const ci = cols.findIndex((c) => c.dataset.column === this.cursor!.columnKey);
    for (let s = ci + dir; s >= 0 && s < cols.length; s += dir) {
      const columnKey = cols[s]!.dataset.column;
      if (columnKey === undefined) continue;
      const cards = this.bucketColumn(this.boardTasks(), columnKey, this.cursor.laneKey);
      if (cards.length > 0) {
        const cardId = this.columnEntryCardId(columnKey, this.cursor.laneKey, cards);
        this.cursor = { columnKey, laneKey: this.cursor.laneKey, cardId };
        this.revealCursor();
        return;
      }
    }
    // Edge of the board: no move, but reveal the (possibly restored) ring.
    this.revealCursor();
  }

  /** Shift+H/L — move the CURSOR card to the adjacent column (cross-column re-key
   *  on the active axis); the cursor follows the card to its new column. */
  private moveFocused(dir: 1 | -1): void {
    if (this.cursor === null) return;
    this.cursorVisible = true;
    const cols = this.columnsInLane(this.cursor.laneKey);
    const ci = cols.findIndex((c) => c.dataset.column === this.cursor!.columnKey);
    const next = ci + dir;
    if (next < 0 || next >= cols.length) return;
    const key = cols[next]!.dataset.column;
    if (key === undefined) return;
    const cardId = this.cursor.cardId;
    const card = this.boardTasks().find((t) => t.id === cardId);
    if (card === undefined) return;
    // Re-key the card's column axis — moveTask for a scalar axis, tag.apply /
    // tag.remove for a tag-prefix axis (preserving the card's other tags).
    this.rekeyAxis(card, cardId, this.axis, key);
    this.cursor = { columnKey: key, laneKey: this.cursor.laneKey, cardId };
    this.revealCursor();
  }

  /** Bring the cursor card into view — board scrolls HORIZONTALLY to its column,
   *  the column body scrolls VERTICALLY to the card (edge-only) — then re-render
   *  so the cursor highlight lands on the (possibly newly-rendered) card. */
  private revealCursor(): void {
    const col = this.cursorColEl();
    if (col !== null && this.cursor !== null) {
      col.scrollIntoView?.({ inline: 'nearest', block: 'nearest' }); // horizontal (+ lane)
      const body = col.querySelector?.('[data-kanban-column-body]') as HTMLElement | null;
      if (body !== null) {
        const cards = this.bucketColumn(this.boardTasks(), this.cursor.columnKey, this.cursor.laneKey);
        const idx = cards.findIndex((c) => c.id === this.cursor!.cardId);
        if (idx >= 0) {
          const top = idx * KANBAN_CARD_HEIGHT;
          const bottom = top + KANBAN_CARD_HEIGHT;
          const vh = body.clientHeight || 0;
          const st = body.scrollTop || 0;
          let nextTop = st;
          if (top < st) nextTop = top;
          else if (bottom > st + vh) nextTop = bottom - vh;
          if (nextTop !== st) body.scrollTop = nextTop;
        }
      }
    }
    // Re-render every column so a card scrolled into view renders; then repaint
    // the cursor class directly (the virtualList key-skip would otherwise skip
    // fillCard for unchanged slots, stranding the old highlight).
    for (const vl of this.columnLists) vl.refresh();
    this.repaintCursor();
    this.rememberCursorCard();
    this.boardEl?.focus({ preventScroll: true });
  }

  /** Toggle the cursor class onto the rendered card matching the cursor id (and
   *  off every other) — independent of the virtualList's content-skip. */
  private repaintCursor(): void {
    if (this.boardEl === null) return;
    const want = this.cursorVisible && this.cursor !== null ? this.cursor.cardId.toString() : null;
    const cards = this.boardEl.querySelectorAll?.('[data-kanban-card]') ?? [];
    for (const node of cards as unknown as HTMLElement[]) {
      node.classList?.toggle('card--cursor', want !== null && node.dataset?.cardId === want);
    }
  }

  /** Open the cursor card's task detail (Enter / o on the focused board). */
  private openCursor(): void {
    if (this.cursor === null) return;
    publishTaskNav(this.ctx.tree, this.boardTasks().map((t) => t.id));
    navigate(taskUrl(this.cursor.cardId.toString()));
  }

  /* ---- logical-cursor persistence (remember across nav, by card id) ------- */

  private cursorNode() {
    const pid = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
    if (pid === null) return null;
    return this.ctx.tree.at(['session', 'cursor', 'kanban', pid.toString()]);
  }
  private rememberedCursorId(): bigint | undefined {
    const v = this.cursorNode()?.peek<bigint>();
    return typeof v === 'bigint' ? v : undefined;
  }
  private rememberCardId(id: bigint): void {
    this.cursorNode()?.set(id);
  }
  private rememberCursorCard(): void {
    if (this.cursor === null) return;
    this.rememberCardId(this.cursor.cardId);
    // Track the vertical position PER column so h/l returns here, not the top.
    this.columnCursorMemory.set(
      this.columnMemoryKey(this.cursor.columnKey, this.cursor.laneKey),
      this.cursor.cardId,
    );
  }

  /** Restore the remembered cursor (by card id) — locate the card in the current
   *  tasks, derive its column/lane, and reveal it. Called once per (re)mount. */
  private restoreCursor(tasks: readonly CardWithAttrs[]): void {
    // Wait for a non-empty render (the first board effect runs against an empty
    // tasks leaf, before the load lands) so we restore against real data.
    if (this.cursorRestored || tasks.length === 0) return;
    this.cursorRestored = true;
    const want = this.rememberedCursorId();
    if (want === undefined) return;
    const card = tasks.find((t) => t.id === want);
    if (card === undefined) return;
    const laned = this.lane !== null && !this.laneIsColumnAxis(this.lane);
    this.cursor = {
      columnKey: this.keyer(this.axis)(card),
      laneKey: laned ? this.keyer(this.lane)(card) : undefined,
      cardId: want,
    };
    // Defer the reveal one microtask: on a cold return-mount (e.g. coming back
    // from a task after jump-nav) the column virtual-lists haven't windowed /
    // laid out yet, so a synchronous revealCursor scrolls against a column body
    // with no clientHeight and the restored card never comes into view. Waiting
    // a microtask lets the initial render settle first — mirrors the inbox/grid
    // restore deferral.
    queueMicrotask(() => {
      if (!this.isAlive()) return;
      this.revealCursor();
    });
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
      // A tag-prefix column keys on `tags` (a card_ref[]): seed it as a
      // single-element ARRAY so the new task carries that one tag, not a scalar
      // that would mis-shape the multi-valued attribute.
      const value: unknown =
        this.axis?.tagPrefix !== undefined ? [BigInt(columnKey)] : BigInt(columnKey);
      prefill.laneAttribute = { name: this.axisAttr, value };
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

/** Optimistic patch for the applyTag / removeTag actions: replace the dragged
 *  card's `tags` array with the client-precomputed result (payload.tags), so a
 *  tag-prefix column/lane move shows instantly. A no-op if the payload lacks the
 *  precomputed array. Rolls back automatically on a server fault. */
function patchTags(current: unknown, payload: unknown): CardWithAttrs[] {
  const rows = Array.isArray(current) ? (current as CardWithAttrs[]) : [];
  const p = (payload ?? {}) as { cardId?: bigint; tags?: bigint[] };
  if (p.cardId === undefined || !Array.isArray(p.tags)) return rows;
  return rows.map((row) =>
    row.id === p.cardId ? { ...row, attributes: { ...row.attributes, tags: p.tags } } : row,
  );
}

/** Build the kanban's column-keying AxisCard from a value-card row. Carries the
 *  row's top-level `phase` (status cards) so a phase-scoped status-grouped board
 *  can hide out-of-phase columns. Reads `sort_order` so the column / lane
 *  sequence honours the operator's explicit value-card ordering — see
 *  {@link sortAxisCards}. */
function axisCardOf(r: CardWithAttrs): AxisCard {
  const so = r.attributes['sort_order'];
  const out: AxisCard = {
    id: r.id,
    label: labelOf(r),
    sortOrder: typeof so === 'number' && Number.isFinite(so) ? so : Number.POSITIVE_INFINITY,
  };
  if (r.phase !== undefined) out.phase = r.phase;
  const color = r.attributes['color'];
  if (typeof color === 'string' && color !== '') out.color = color;
  const path = r.attributes['path'];
  if (typeof path === 'string' && path !== '') out.path = path;
  const root = r.attributes['root_exclusive_at'];
  if (typeof root === 'string' && root !== '') out.rootExclusiveAt = root;
  return out;
}

/** Sort a value-card list by explicit `sort_order` (ASC), tie-breaking on the
 *  id (ASC) — so the kanban's column / lane order matches the operator's
 *  ordering, and value-cards without `sort_order` keep the server's
 *  deterministic id-based order rather than reshuffling alphabetically (which
 *  is locale-sensitive). Stable across re-fetches. */
function sortAxisCards(cards: AxisCard[]): AxisCard[] {
  cards.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return cards;
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

/** Short "Mon D" rendering of an ISO timestamp for the card's created date
 *  (e.g. "Jun 10"). Empty string for an unparseable / missing value. */
function formatCardDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

/**
 * Inbox (list) control — the personal-sorted task inbox.
 *
 * Registered as the `list` layout body (ScreenHost maps `list` → 'Inbox'), so a
 * screen card with `layout: 'list'` under `/project/:id/screen/:slug` resolves
 * here instead of the NotFound placeholder. Reuses the shared ScreenFilterBar
 * (ScreenHost mounts it above the body) by reading the same `screen.search` /
 * `screen.predicate` leaves the Grid + Kanban read.
 *
 * Data flow (ALL declarative — no promises, no `await`, no `call(...)`; the
 * DataController owns every async outcome, exactly like Grid/Kanban):
 *   - static query `tasks`    → card.select_with_attributes with
 *     `with_personal_sort: true` so every row carries `personal_sort_order`,
 *     ordered by it (NULLS LAST) then created_at. A routed-to-me toggle adds
 *     `routed_to_me: true` (agent-perspective view); scope is the in-scope
 *     project (`scope.projectId`, skipWhenNull). Refires on `inbox.queryVersion`
 *     (scope / filter / toggles bump it). Result → method 'landTasks' →
 *     'inbox.tasks'.
 *   - lookup queries `persons` / `statuses` → label maps the row reads to
 *     resolve assignee + status.
 *
 * Rows render through the recycling `virtualList` (fixed row height): a task row
 * with a drag handle, id + title, a status pill, and the assignee. NO transient
 * per-row state lives on a pooled node — selection + the resolved labels are
 * read from the task + lookup tree paths inside `update(el, item, i)` and
 * re-applied each call (recycling-safe). A `personal_sort_order`-bearing row
 * shows a brighter leading indicator than a server-default (unset) row.
 *
 * Reorder (drag + Shift+J/K): both rewrite `personal_sort_order` via
 * planPersonalReorder → one `user_card_sort.set` per affected card, fired in
 * the same tick so the dispatcher coalesces them into ONE batch. The row list
 * is patched OPTIMISTICALLY (applyPersonalReorder) and rolled back on fault.
 * This is the per-user inbox order, distinct from the kanban `sort_order`.
 *
 * Per-row delegate-to-agent: a `<select>` per row assigns the card to one of the
 * user's agents (user_card_agent.set; clearing via user_card_agent.clear). The
 * agent list loads from `user.select { parent_user_id: me, is_agent: true }` —
 * the signed-in user's OWN agents (the `auth.user` identity landed by the boot
 * /api/v1/auth/me probe). The query stays idle until the identity resolves, then
 * refires; an empty result hides the picker.
 *
 * mine_only toggle (toggle_groups.scope.mine_only): a header toggle narrowing to
 * the current user. It ANDs an `assignee = currentUserId` leaf, where
 * currentUserId is the signed-in user's id read from `auth.user` (the same id
 * space the `assignee` attribute compares against — see the Svelte reference's
 * `meId` derivation + server personal_sort_test.go). A `config.currentUserId`
 * override is honoured first (tests / a host that injects one); absent that the
 * identity comes from `auth.user`. Before the identity resolves the toggle bumps
 * the query but adds no leaf (the brief pre-probe window).
 *
 * Cascade-safe: every reorder/toggle is a ONE-WAY write outside any tracked
 * effect (it patches the row list / bumps `inbox.queryVersion`); the single
 * render effect reads only the tasks leaf + the lookups tick.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ActionBinding, QueryBinding } from '../core/data.js';
import type { ApiFault } from '../core/dispatch.js';
import { AUTH_USER_PATH, peekCurrentUserId, type AuthUser } from '../auth/auth-state.js';
import { virtualList } from '../core/virtual-list.js';
import { DropPlaceholder, computeDropTarget, applySettle, FlipAnimator } from '../ui/drag-placeholder.js';
import { navigate, taskUrl } from '../shell/router.js';
import { publishTaskNav } from '../shell/task-nav.js';
import { SPEC } from '../kanban/specs.js';
import { INBOX_SPEC } from './specs.js';
import { asAttrId, type CardWithAttrs } from '../kanban/kanban-helpers.js';
import { walkGrouped, type GroupAttr, type GroupItem } from '../filter/group-axis.js';
import {
  applyPersonalReorder,
  move,
  planPersonalReorder,
  sortByPersonal,
  sortGrouped,
} from './inbox-helpers.js';
import type { CardWherePredicate } from '../projects/project-helpers.js';
import {
  type Predicate,
  type WireNode,
  applySearchFilter,
} from '../filter/predicate.js';

/**
 * Fixed virtual-list row height (px) for an inbox task row: two lines (title +
 * meta) + padding + the inter-row gap baked in. The row fills the slot; mirror
 * this in `.inbox__row` height in styles.css — the virtualList positions rows
 * by this exact px value, so the CSS row height MUST equal it.
 */
const INBOX_ROW_HEIGHT = 56;

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry types.                                */
/* -------------------------------------------------------------------------- */

export interface InboxConfig extends BaseControlConfig {
  type: 'Inbox';
  /** Tree path the loaded task rows live at. Default 'inbox.tasks'. */
  tasksPath?: string;
  /**
   * Optional OVERRIDE for the signed-in user's id. When set, mine_only ANDs an
   * `assignee = currentUserId` leaf using THIS value (tests / a host that injects
   * an identity). When absent the id is read from `auth.user` (the boot /auth/me
   * probe). Either way mine_only is a no-op leaf only while NO id is resolvable.
   */
  currentUserId?: bigint;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    Inbox: InboxConfig;
  }
}

/** A label lookup: stringified id → display label. */
type LabelMap = Record<string, string>;

/** An agent the user can delegate to. */
interface AgentOption {
  id: bigint;
  label: string;
}

/* Shared dataset key for an in-flight row drag (one inbox, simple module state). */
let draggingRowId: bigint | null = null;

/* -------------------------------------------------------------------------- */
/* Inbox control.                                                             */
/* -------------------------------------------------------------------------- */

export class Inbox extends Control<InboxConfig> {
  /** Index of the keyboard-selected row (j/k cursor + Shift+j/k reorder).
   *  Indexes into the DISPLAY order (see currentRows) — which is the grouped
   *  order when a group axis is active, so it lines up with each row item's
   *  `idx` from walkGrouped. */
  private selectedIndex = 0;

  /**
   * Active group-by axis (the RESOLVED `screen.groupAxis` from the shared
   * ScreenFilterBar's GROUP picker), or null for a flat list. When set, rows are
   * clustered into labelled sections — the same model the Grid renders. Drives
   * the wire `order[]` (group key prepended so rows arrive bucketed) AND the
   * flat header+row item sequence the virtualList renders.
   */
  private group: GroupAttr | null = null;

  /** Direction of the group sort key (asc/desc). A group-header click flips it;
   *  reset to 'asc' whenever the group attr itself changes. Mirrors the Grid. */
  private groupDir: 'asc' | 'desc' = 'asc';

  /** The "Mine only" / "Routed to me" view state lives entirely in the
   *  `inbox.mineOnly` / `inbox.routedToMe` tree leaves (flipped by the filter-bar
   *  InboxViewToggles control); this control only watches them. */

  /** The viewport element (the virtualList scroll container) — held so reorder
   *  geometry + focus can find rows. */
  private listBody: HTMLElement | null = null;

  /** The gliding drop placeholder (#5), one per list — glides to the insertion
   *  gap during a row drag. */
  private placeholder: DropPlaceholder | null = null;

  /** The row id that just reordered (drag or keyboard), consumed by the next
   *  fill to play a one-shot settle ring on the row in its new slot. */
  private settleRowId: bigint | null = null;

  /** FLIP slider: records row positions before a reorder and slides them to
   *  their new slots after the in-place re-render. */
  private readonly flip = new FlipAnimator(() => this.listBody, '[data-inbox-row]');

  private get tasksPath(): string[] {
    return (this.config.tasksPath ?? 'inbox.tasks').split('.');
  }

  /**
   * CLASS-STATIC query table. The tasks query carries `withPersonalSort` + the
   * personal-sort order, `routedToMe` (resolved from a tree leaf at fire time),
   * and `where`/`tree` from the shared filter. It refires whenever
   * `inbox.queryVersion` changes (scope, filter, routed-to-me, mine_only all
   * bump it). The two lookups refire on project switch + land label maps.
   */
  static override queries: readonly QueryBinding[] = [
    {
      name: 'tasks',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'inbox.queryVersion' },
      input: {
        cardTypeName: { lit: 'task' },
        parentCardId: { from: 'scope.projectId' },
        withPersonalSort: { lit: true },
        routedToMe: { from: 'inbox.routedToMe' },
        // Resolved from a tree leaf at fire time: the personal-sort order by
        // default, with the active group key prepended (so rows arrive bucketed)
        // when a group axis is selected. See applyOrder().
        order: { from: 'inbox.order' },
        where: { from: 'inbox.where' },
        tree: { from: 'inbox.tree' },
        limit: { lit: 200 },
      },
      // Idle until a project scope resolves (no cross-project flash). The
      // { signal } trigger refires once the scope leaf is written.
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
      // Label maps for the milestone / component GROUP axes (the inbox row cells
      // don't show these, but grouping by them must resolve a name, not `#id` —
      // same axes the Grid loads). Project-scoped value cards.
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
      // The user's OWN agents — the delegate-to-agent options. Scoped read
      // (user.select { parent_user_id: me, is_agent: true }) keyed on the
      // signed-in identity mirrored into `inbox.parentUserId` (see render()'s
      // identity-watch effect). Idle until the identity resolves (skipWhenNull),
      // then refires on the leaf write. Landed into a lookup the row picker
      // reads; may return [] (picker then hides).
      name: 'agents',
      spec: 'user.select',
      when: { signal: 'inbox.parentUserId' },
      input: { parentUserId: { from: 'inbox.parentUserId' }, isAgent: { lit: true } },
      skipWhenNull: ['parentUserId'],
      result: { method: 'landAgents' },
      // A failed/forbidden agents read must NOT raise the screen-level inbox
      // fault — it just leaves the delegate picker hidden. Route to a named
      // no-op handler instead of 'self'/'top'.
      onError: { method: 'agentsLoadFailed' },
    },
    {
      // The user's EXISTING delegations, scoped to the active project. Without
      // this load the per-row picker only ever reflected an optimistic patch, so
      // a saved delegation looked lost after reload — the actual bug. Refires on
      // a project switch; idle until scope resolves.
      name: 'routing',
      spec: INBOX_SPEC.userCardAgentList,
      when: { signal: 'scope.projectId' },
      input: { parentCardId: { from: 'scope.projectId' } },
      skipWhenNull: ['parentCardId'],
      result: { method: 'landRouting' },
      // A failed routing read shouldn't raise the screen fault — just leave the
      // pickers unseeded (and must NOT clear the agents list).
      onError: { method: 'routingLoadFailed' },
    },
  ];

  /**
   * CLASS-STATIC action table. The reorder write + the delegate set/clear. The
   * reorder action carries an optimistic patch over the row list; set/clear
   * patch the per-card routing lookup so the picker reflects the change before
   * the round-trip.
   */
  static override actions: readonly ActionBinding[] = [
    {
      // One per planned personal_sort_order write; fired once per affected card
      // in the same tick so the dispatcher coalesces them into one batch. Each
      // carries its own optimistic patch that writes that card's
      // personal_sort_order, so the list re-orders immediately.
      intent: 'reorderRow',
      spec: INBOX_SPEC.userCardSortSet,
      input: {
        cardId: { payload: 'cardId' },
        sortOrder: { payload: 'sortOrder' },
      },
      optimistic: {
        path: 'inbox.tasks',
        patch: (current, payload): CardWithAttrs[] => {
          const rows = Array.isArray(current) ? (current as CardWithAttrs[]) : [];
          const p = (payload ?? {}) as { cardId?: bigint; sortOrder?: number };
          if (p.cardId === undefined || p.sortOrder === undefined) return rows;
          return rows.map((row) =>
            row.id === p.cardId ? { ...row, personal_sort_order: p.sortOrder as number } : row,
          );
        },
      },
      onError: 'top',
    },
    {
      // Delegate the card to one of the user's agents. Optimistic patch writes
      // the routing lookup leaf so the row's picker shows the new target before
      // the server confirms; rollback restores it.
      intent: 'delegateRow',
      spec: INBOX_SPEC.userCardAgentSet,
      input: {
        cardId: { payload: 'cardId' },
        agentUserId: { payload: 'agentUserId' },
      },
      optimistic: {
        path: 'inbox.routing',
        patch: (current, payload): Record<string, bigint> => {
          const map = isMap(current) ? { ...(current as Record<string, bigint>) } : {};
          const p = (payload ?? {}) as { cardId?: bigint; agentUserId?: bigint };
          if (p.cardId === undefined || p.agentUserId === undefined) return map;
          map[p.cardId.toString()] = p.agentUserId;
          return map;
        },
      },
      onError: 'top',
    },
    {
      // Clear a delegation. Optimistic patch drops the routing entry.
      intent: 'clearDelegateRow',
      spec: INBOX_SPEC.userCardAgentClear,
      input: { cardId: { payload: 'cardId' } },
      optimistic: {
        path: 'inbox.routing',
        patch: (current, payload): Record<string, bigint> => {
          const map = isMap(current) ? { ...(current as Record<string, bigint>) } : {};
          const p = (payload ?? {}) as { cardId?: bigint };
          if (p.cardId !== undefined) delete map[p.cardId.toString()];
          return map;
        },
      },
      onError: 'top',
    },
  ];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'inbox';
    el.dataset.control = 'Inbox';
    el.tabIndex = -1;
    return el;
  }

  protected render(): void {
    this.registerResultHandlers();

    // Seed the query-driver leaves BEFORE the data layer wires (mount() wires
    // after render). where/tree/routedToMe start empty; queryVersion at 0.
    this.ctx.tree.at(['inbox', 'where']).set(undefined);
    this.ctx.tree.at(['inbox', 'tree']).set(undefined);
    // Toggle state (flipped by the filter-bar InboxViewToggles). Seed only when
    // unset so a value carried over (e.g. a back-nav) isn't clobbered.
    if (this.ctx.tree.at(['inbox', 'routedToMe']).peek() === undefined) {
      this.ctx.tree.at(['inbox', 'routedToMe']).set(false);
    }
    if (this.ctx.tree.at(['inbox', 'mineOnly']).peek() === undefined) {
      this.ctx.tree.at(['inbox', 'mineOnly']).set(false);
    }
    // Seed the agents-query driver leaf to the resolvable identity (config
    // override first, else the already-landed auth.user) so the `{ signal:
    // 'inbox.parentUserId' }` trigger has a value to skip/fire on. The
    // identity-watch effect (below) keeps it in sync if the probe lands later.
    this.ctx.tree.at(['inbox', 'parentUserId']).set(this.resolveUserId());
    if (this.ctx.tree.at(['inbox', 'routing']).peek() === undefined) {
      this.ctx.tree.at(['inbox', 'routing']).set({});
    }
    const versionNode = this.ctx.tree.at(['inbox', 'queryVersion']);
    if (versionNode.peek<number>() === undefined) versionNode.set(0);
    // Seed the wire order leaf (group null → personal-sort default) BEFORE the
    // data layer wires, so the first tasks fire reads a value (not undefined).
    this.applyOrder();
    // groupVersion: a body-only re-walk trigger the group effect + group-dir
    // flip bump; the virtualList's data() reads it so the grouped item model
    // re-derives from the rows already loaded without waiting on the refetch.
    const groupVersionNode = this.ctx.tree.at(['inbox', 'groupVersion']);
    if (groupVersionNode.peek<number>() === undefined) groupVersionNode.set(0);
    // lookups tick: a body-only re-render trigger the lookups + agents bump so a
    // late-landing label/agent list re-resolves the visible rows.
    const tickNode = this.ctx.tree.at(['inbox', 'lookups', 'tick']);
    if (tickNode.peek<number>() === undefined) tickNode.set(0);

    /* ------------------------------- header -------------------------------- */
    // Toggles row: routed-to-me (agent view) + mine_only scope. The shared
    // ScreenFilterBar (search / saved views / per-attr chips) is mounted ABOVE
    // the body by ScreenHost — the inbox only adds its two scope toggles.
    const header = document.createElement('header');
    header.className = 'inbox__header';

    const agentBanner = document.createElement('span');
    agentBanner.className = 'inbox__agent-banner';
    agentBanner.dataset.inboxAgentBanner = '';
    agentBanner.textContent = 'Agent view · routed work';
    agentBanner.style.display = 'none';
    header.append(agentBanner);

    // The "Mine only" / "Routed to me" toggles no longer live in the Inbox body
    // — they're registered as filter-bar view actions (InboxViewToggles, #13)
    // and flip the `inbox.mineOnly` / `inbox.routedToMe` leaves this control
    // watches below.
    this.el.append(header);

    /* -------------------------------- fault -------------------------------- */
    const fault = document.createElement('div');
    fault.className = 'inbox__fault';
    fault.style.display = 'none';
    this.el.append(fault);

    /* -------------------------------- body --------------------------------- */
    const body = document.createElement('div');
    body.className = 'inbox__list scroll-y';
    body.dataset.inboxList = '';
    body.setAttribute('role', 'list');
    this.listBody = body;
    this.el.append(body);

    const empty = document.createElement('div');
    empty.className = 'inbox__empty muted';
    empty.dataset.inboxEmpty = '';
    empty.textContent = 'Your inbox is clear. Nothing assigned to you right now.';
    empty.style.display = 'none';
    this.el.append(empty);

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
      fault.textContent = `Failed to load inbox: ${describeFault(f)}`;
    }, 'inbox.fault');

    // Empty-state toggle reads only the tasks leaf (cascade-safe).
    this.effect(() => {
      const rows = (tasksNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
      empty.style.display = rows.length === 0 ? '' : 'none';
    }, 'inbox.empty');

    // Agent-view banner reflects the routed-to-me toggle (read the tree leaf so
    // it repaints on toggle).
    this.effect(() => {
      const routed = this.ctx.tree.at(['inbox', 'routedToMe']).get<boolean>() ?? false;
      agentBanner.style.display = routed ? '' : 'none';
    }, 'inbox.agentBanner');

    // Rows render through the recycling virtualList. `data()` reads the tasks
    // leaf reactively AND the lookups tick (late label/agent lands re-resolve)
    // AND the routing leaf (a delegate set/clear repaints the picker). The list
    // is sorted by personal_sort_order so an optimistic patch re-orders it.
    const vl = virtualList<GroupItem<CardWithAttrs>>({
      container: body,
      rowHeight: INBOX_ROW_HEIGHT,
      data: () => {
        this.ctx.tree.at(['inbox', 'lookups', 'tick']).get();
        this.ctx.tree.at(['inbox', 'routing']).get();
        this.ctx.tree.at(['inbox', 'groupVersion']).get();
        const rows = (tasksNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
        return this.buildItems(rows);
      },
      create: (el) => this.buildRowShell(el),
      update: (el, item) => this.fillItem(el, item),
      name: 'inbox.rows',
    });
    this.onDestroy(() => vl.dispose());

    // The shared gliding drop placeholder (#5), in the list viewport's content
    // coordinate space (appended after the virtualList so it sits on top).
    this.placeholder = new DropPlaceholder(body, { className: 'drop-placeholder--inbox' });
    this.onDestroy(() => {
      this.placeholder?.destroy();
      this.placeholder = null;
    });

    // CONTAINER-level drag wiring (the bug fix, #22): the per-row dragover/drop
    // only fire when the pointer is OVER a row, so releasing in the insertion
    // GAP between rows (exactly where the placeholder bar sits) lands on the
    // body, which had no handler → the drop never committed. The body's dragover
    // preventDefault makes the gap a valid drop target, and its drop resolves the
    // insertion point geometrically. A drop ONTO a row is handled by the row
    // (which stops propagation), so this only runs for true gap drops.
    this.listen(body, 'dragover', (ev) => {
      if (draggingRowId === null) return;
      ev.preventDefault();
      const t = computeDropTarget(body, (ev as DragEvent).clientY, draggingRowId.toString(), '[data-inbox-row]');
      this.placeholder?.showAtY(t.y);
    });
    this.listen(body, 'drop', (ev) => {
      ev.preventDefault();
      if (draggingRowId === null) return;
      this.placeholder?.pulse();
      const before = this.dropBeforeRow(body, (ev as DragEvent).clientY);
      if (before !== null) {
        // Gap drop: dropBeforeRow already resolved the insertion row, so insert
        // BEFORE it (no per-row midpoint check — pass no clientY).
        this.onRowDrop(before);
      } else {
        // Released past the last row → move to the end.
        const movedId = draggingRowId;
        draggingRowId = null;
        this.reorderTo(movedId, Math.max(0, this.currentRows().length - 1));
      }
    });

    /* -------------------- one-way query-version drivers -------------------- */
    // Bump the tasks query version whenever scope changes.
    this.effect(() => {
      this.ctx.tree.at(['scope', 'projectId']).get(); // subscribe
      this.bumpQuery();
    }, 'inbox.scopeWatch');

    // Search + the structured Advanced predicate both narrow the task query.
    // One-way: reads search + predicate (+ the mine_only flag), writes only
    // where/tree/version. Same cascade-safe shape as Grid/Kanban.
    this.effect(() => {
      const search = this.ctx.tree.at(['screen', 'search']).get<string>() ?? '';
      const predicate = this.ctx.tree.at(['screen', 'predicate']).get<Predicate | null>() ?? null;
      const fields = this.ctx.tree.at(['screen', 'searchFields']).get<string[]>() ?? ['title'];
      this.ctx.tree.at(['inbox', 'mineOnly']).get(); // subscribe — the toggle flips it
      this.applyFilter(search, fields, predicate);
      this.bumpQuery();
    }, 'inbox.filterWatch');

    // "Routed to me" flips `inbox.routedToMe` (the agent-perspective view); the
    // tasks query reads it at fire time, so just refire on a change. The banner
    // effect (above) repaints from the same leaf. One-way, cascade-safe.
    this.effect(() => {
      this.ctx.tree.at(['inbox', 'routedToMe']).get(); // subscribe
      this.bumpQuery();
    }, 'inbox.routedWatch');

    // GROUP picker → group-by axis. Reads the RESOLVED `screen.groupAxis`
    // ({attr, lookup} | null) the shared ScreenFilterBar derives from the
    // data-driven schema — the SAME leaf the Grid consumes. Writes the group
    // state + the wire `order[]` (group key prepended so rows arrive bucketed),
    // re-walks the body, and refires the query. One-way (never reads back a dep
    // it writes) — same cascade-safe shape as the sort/filter watchers.
    this.effect(() => {
      const next = this.ctx.tree.at(['screen', 'groupAxis']).get<GroupAttr | null>() ?? null;
      // A fresh group column resets the direction so the toggle is predictable.
      if ((next?.attr ?? null) !== (this.group?.attr ?? null)) this.groupDir = 'asc';
      this.group = next;
      this.applyOrder();
      this.bumpGroup();
      this.bumpQuery();
    }, 'inbox.groupWatch');

    // Identity watch: when the boot /auth/me probe lands `auth.user` (or it
    // changes), mirror the user's id into `inbox.parentUserId` (drives the
    // agents query) and re-project the mine_only filter so a toggle that was on
    // before the identity resolved picks up the real id. One-way: reads the
    // identity leaf, writes only parentUserId / where / version (paths no caller
    // effect feeds back into) — cascade-safe.
    this.effect(() => {
      this.ctx.tree.at([...AUTH_USER_PATH]).get<AuthUser | undefined>(); // subscribe
      const me = this.resolveUserId();
      const node = this.ctx.tree.at(['inbox', 'parentUserId']);
      if (node.peek<bigint | null>() !== me) node.set(me);
      if ((this.ctx.tree.at(['inbox', 'mineOnly']).peek<boolean>() ?? false)) {
        const search = this.ctx.tree.at(['screen', 'search']).peek<string>() ?? '';
        const predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
        const fields = this.ctx.tree.at(['screen', 'searchFields']).peek<string[]>() ?? ['title'];
        this.applyFilter(search, fields, predicate);
        this.bumpQuery();
      }
    }, 'inbox.identityWatch');

    // Refetch when a task is created anywhere (the quick-entry overlay bumps
    // `tasks.createdNonce`), so a newly-added task shows up without a manual
    // reload. One-way: reads the nonce, bumps the query version — cascade-safe.
    this.effect(() => {
      const nonce = this.ctx.tree.at(['tasks', 'createdNonce']).get<number>() ?? 0;
      if (nonce > 0) this.bumpQuery();
    }, 'inbox.refreshOnCreate');
  }

  /**
   * The signed-in user's id for mine_only / the agents scope: the
   * `config.currentUserId` override first (tests / an injecting host), else the
   * landed `auth.user` identity. Null when neither is resolvable yet.
   */
  private resolveUserId(): bigint | null {
    if (this.config.currentUserId !== undefined) return this.config.currentUserId;
    return peekCurrentUserId(this.ctx.tree);
  }

  /* ----------------------------- result sinks --------------------------- */

  private registerResultHandlers(): void {
    this.handler('landTasks', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      this.ctx.tree.at(this.tasksPath).set(rows);
      // Keep the keyboard selection in range after a reload.
      if (this.selectedIndex >= rows.length) {
        this.selectedIndex = rows.length === 0 ? 0 : rows.length - 1;
      }
    });

    const landLabels = (name: string, labelOf: (r: CardWithAttrs) => string) => (out: unknown) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const map: LabelMap = {};
      for (const r of rows) map[r.id.toString()] = labelOf(r);
      this.ctx.tree.at(['inbox', 'lookups', name]).set(map);
      this.tickLookups();
    };
    this.handler('landPersons', landLabels('persons', titleAttr));
    this.handler('landStatuses', landLabels('statuses', titleOrName));
    this.handler('landMilestones', landLabels('milestones', titleOrName));
    this.handler('landComponents', landLabels('components', titleOrName));

    // Agents land as an {id,label}[] the row picker reads.
    this.handler('landAgents', (out) => {
      const rows = ((out ?? {}) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const agents: AgentOption[] = rows.map((r) => ({
        id: asId(r['id']),
        label: agentLabel(r),
      }));
      this.ctx.tree.at(['inbox', 'agents']).set(agents);
      this.tickLookups();
    });

    // Swallow an agents-read fault (no identity / admin-gated): the delegate
    // picker stays hidden, the rest of the inbox is unaffected. Documented data
    // gap — see the class doc comment + the render() note.
    this.handler('agentsLoadFailed', () => {
      this.ctx.tree.at(['inbox', 'agents']).set([]);
      this.tickLookups();
    });

    // Land the user's existing delegations so the per-row pickers reflect saved
    // routings (not just optimistic patches) on load / project switch.
    this.handler('landRouting', (out) => {
      const routing = ((out ?? {}) as { routing?: Record<string, bigint> }).routing ?? {};
      this.ctx.tree.at(['inbox', 'routing']).set(routing);
      this.tickLookups();
    });

    // A routing-read fault leaves the existing pickers untouched (it must NOT
    // clobber the agents list like agentsLoadFailed does).
    this.handler('routingLoadFailed', () => {
      this.tickLookups();
    });
  }

  private tickLookups(): void {
    const node = this.ctx.tree.at(['inbox', 'lookups', 'tick']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /* ----------------------------- query driver --------------------------- */

  /**
   * Project the active search + the Advanced predicate (+ the mine_only
   * assignee leaf when a currentUserId is configured) to the tasks query's
   * `where[]` / `tree` leaves. Same flat-AND-vs-structured contract as
   * Grid/Kanban: a flat AND composes into where[]; a structured tree rides the
   * v2 `tree` field while the search leaf stays in where[].
   */
  private applyFilter(search: string, fields: readonly string[], predicate: Predicate | null): void {
    // Compose the shared (search × selected-fields × Advanced-predicate) leaves
    // via {@link applySearchFilter}, then AND the inbox-specific `assignee = me`
    // leaf in alongside it. The mine_only leaf rides as a flat-AND leaf in
    // `where[]` whenever the result is already in where[]-shape; otherwise it
    // joins the tree's top-level AND so the search-OR group still applies.
    const { where, tree } = applySearchFilter(search, fields, predicate);
    const me = this.resolveUserId();
    const mineOnly = this.ctx.tree.at(['inbox', 'mineOnly']).peek<boolean>() ?? false;
    const mineLeaf: CardWherePredicate | null =
      mineOnly && me !== null ? { attr: 'assignee', op: '=', value: me } : null;

    let outWhere: CardWherePredicate[] | undefined = where as CardWherePredicate[] | undefined;
    let outTree: WireNode | undefined = tree;
    if (mineLeaf !== null) {
      if (outTree === undefined) {
        outWhere = [...(outWhere ?? []), mineLeaf];
      } else if (outTree.connective === 'and' && Array.isArray(outTree.children)) {
        outTree = { connective: 'and', children: [...outTree.children, mineLeaf] };
      } else {
        outTree = { connective: 'and', children: [outTree, mineLeaf] };
      }
    }

    this.ctx.tree.at(['inbox', 'where']).set(outWhere);
    this.ctx.tree.at(['inbox', 'tree']).set(outTree);
  }

  private bumpQuery(): void {
    const node = this.ctx.tree.at(['inbox', 'queryVersion']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /**
   * Project the wire `order[]`: the active group key FIRST (at `groupDir`, so
   * the server returns rows bucketed), then the personal-sort order, then
   * created_at. Ungrouped this is just the personal-sort default. Written to a
   * tree leaf the tasks query reads at fire time.
   */
  private applyOrder(): void {
    const order: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
    if (this.group !== null) {
      order.push({
        field: `attributes.${this.group.attr}`,
        direction: this.groupDir === 'asc' ? 'ASC' : 'DESC',
      });
    }
    order.push({ field: 'personal_sort_order', direction: 'ASC' });
    order.push({ field: 'created_at', direction: 'DESC' });
    this.ctx.tree.at(['inbox', 'order']).set(order);
  }

  /** Bump the group version so the virtualList re-walks the body (re-buckets +
   *  repaints headers) without waiting on the tasks refetch. */
  private bumpGroup(): void {
    const node = this.ctx.tree.at(['inbox', 'groupVersion']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /**
   * Flip the group sort direction (asc ⇄ desc of the group key). Re-issues the
   * tasks query with the flipped first `order[]` key (server reverses bucket
   * order) and re-walks the body. Wired to the group-section header click.
   */
  private toggleGroupDir(): void {
    if (this.group === null) return;
    this.groupDir = this.groupDir === 'asc' ? 'desc' : 'asc';
    this.applyOrder();
    this.bumpGroup();
    this.bumpQuery();
  }

  /* -------------------------------- rows -------------------------------- */

  /**
   * Build ONE pooled node (virtualList `create`). The el-level gestures (click /
   * keyboard / drag) are wired HERE exactly once; they read the live MODE +
   * `data-card-id` at event time — never a captured row, since a pooled node
   * recycles AND may flip between a data row and a group header on scroll. The
   * row's inner content + the delegate <select> listener are built by
   * makeRowMode (the node starts in row mode).
   */
  private buildRowShell(el: HTMLElement): void {
    this.makeRowMode(el);

    // A DATA-row click selects AND opens the task detail (`/task/:id`); a
    // GROUP-HEADER click flips the group direction (same gesture as the Grid's
    // section header). Enter / `o` on a focused row opens it. Clicks on the
    // delegate <select> are ignored (its own change handler owns those). All
    // read the live mode + data-card-id (never stale on a recycled node).
    this.listen(el, 'click', (ev) => {
      if (el.dataset.inboxGroup !== undefined) {
        this.toggleGroupDir();
        return;
      }
      const target = ev.target as HTMLElement | null;
      if (target && target.dataset?.role === 'delegate') return;
      const idStr = el.dataset.cardId;
      if (idStr === undefined) return;
      this.selectByCardId(BigInt(idStr));
      this.openTask(idStr);
    });
    this.listen(el, 'keydown', (ev) => {
      if (el.dataset.inboxRow === undefined) return; // headers aren't openable
      const k = (ev as KeyboardEvent).key;
      if (k === 'Enter' || k === 'o') {
        ev.preventDefault();
        const idStr = el.dataset.cardId;
        if (idStr !== undefined) this.openTask(idStr);
      }
    });
    this.listen(el, 'dragstart', (ev) => {
      if (el.dataset.inboxRow === undefined) return; // group headers don't drag
      const idStr = el.dataset.cardId;
      draggingRowId = idStr !== undefined ? BigInt(idStr) : null;
      this.settleRowId = null; // a fresh drag clears the prior move's settle
      el.classList.add('inbox__row--dragging');
      const dt = (ev as DragEvent).dataTransfer;
      if (dt && idStr !== undefined) {
        dt.effectAllowed = 'move';
        dt.setData('text/plain', idStr);
      }
    });
    this.listen(el, 'dragend', () => {
      draggingRowId = null;
      el.classList.remove('inbox__row--dragging');
      this.placeholder?.hide();
    });
    this.listen(el, 'dragover', (ev) => {
      ev.preventDefault();
      // Glide the shared placeholder to the insertion gap (#5), computed against
      // the list viewport so the bar sits in the list's content coordinate space
      // (and "drag to end" parks it below the last row).
      if (draggingRowId === null || this.listBody === null) return;
      const t = computeDropTarget(this.listBody, (ev as DragEvent).clientY, draggingRowId.toString(), '[data-inbox-row]');
      this.placeholder?.showAtY(t.y);
    });
    this.listen(el, 'drop', (ev) => {
      ev.preventDefault();
      // Stop the drop from ALSO bubbling to the container `drop` (the gap
      // handler) — otherwise a drop ONTO a row would commit twice in a real
      // browser. (The test DOM shim doesn't bubble, so this is a no-op there.)
      ev.stopPropagation();
      if (el.dataset.inboxRow === undefined) return; // a drop landing on a header
      // Position-aware: a drop in the row's LOWER half inserts AFTER it (so a
      // drop on the last row's lower half reaches the END — a card could never
      // pass the last row before, #30). Matches the dragover placeholder.
      this.onRowDrop(el, (ev as DragEvent).clientY);
    });
  }

  /**
   * (Re)build a pooled node as a DATA ROW: the grip, the title/meta lines, and
   * the delegate <select> (its change listener wired here — re-wired on each
   * mode transition, since the children are rebuilt). Idempotent: returns early
   * when the node is already a row, so a pure scroll between rows is cheap. A
   * node previously in group-header mode is rebuilt here.
   */
  private makeRowMode(el: HTMLElement): void {
    if (el.dataset.inboxRow !== undefined) return;
    delete el.dataset.inboxGroup;
    delete el.dataset.groupKey;
    delete el.dataset.groupDir;
    el.className = 'inbox__row';
    el.dataset.inboxRow = '';
    el.setAttribute('role', 'listitem');
    el.tabIndex = 0;
    el.draggable = true;
    el.replaceChildren();

    const grip = document.createElement('span');
    grip.className = 'inbox__grip muted';
    grip.dataset.role = 'grip';
    grip.setAttribute('aria-label', 'Drag to reorder');
    grip.title = 'Drag to reorder';
    grip.textContent = '⋮⋮';

    const main = document.createElement('div');
    main.className = 'inbox__main';

    const line1 = document.createElement('div');
    line1.className = 'inbox__line1';
    const idEl = document.createElement('span');
    idEl.className = 'inbox__id muted';
    idEl.dataset.role = 'id';
    const title = document.createElement('span');
    title.className = 'inbox__title';
    title.dataset.role = 'title';
    line1.append(idEl, title);

    const line2 = document.createElement('div');
    line2.className = 'inbox__line2';
    const status = document.createElement('span');
    status.className = 'inbox__status-pill';
    status.dataset.role = 'status';
    const assignee = document.createElement('span');
    assignee.className = 'inbox__assignee muted';
    assignee.dataset.role = 'assignee';
    const priority = document.createElement('span');
    priority.className = 'inbox__priority';
    priority.dataset.role = 'priority';
    line2.append(status, assignee, priority);

    main.append(line1, line2);

    // Delegate-to-agent picker (hidden until agents resolve; see fillRow).
    const delegate = document.createElement('select');
    delegate.className = 'inbox__delegate';
    delegate.dataset.role = 'delegate';
    delegate.dataset.inboxDelegate = '';
    delegate.setAttribute('aria-label', 'Delegate task to one of your agents');
    this.listen(delegate, 'change', (ev) => {
      const sel = ev.target as HTMLSelectElement;
      const idStr = el.dataset.cardId;
      if (idStr === undefined) return;
      const cardId = BigInt(idStr);
      if (sel.value === '') this.intent('clearDelegateRow', { cardId });
      else this.intent('delegateRow', { cardId, agentUserId: BigInt(sel.value) });
    });

    el.append(grip, main, delegate);
  }

  /**
   * (Re)build a pooled node as a GROUP HEADER: a leading direction arrow, the
   * bucket label, and `· count`. The whole band is clickable (the el-level click
   * handler flips the group direction). Idempotent across header fills; rebuilds
   * only on the transition out of row mode.
   */
  private makeHeaderMode(el: HTMLElement): void {
    if (el.dataset.inboxGroup !== undefined) return;
    delete el.dataset.inboxRow;
    delete el.dataset.cardId;
    el.className = 'inbox__group-header';
    el.dataset.inboxGroup = '';
    el.setAttribute('role', 'listitem');
    el.tabIndex = 0;
    el.draggable = false;
    el.replaceChildren();
    const arrow = document.createElement('span');
    arrow.className = 'inbox__group-arrow';
    arrow.dataset.role = 'group-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'inbox__group-label';
    label.dataset.role = 'group-label';
    const count = document.createElement('span');
    count.className = 'inbox__group-count muted';
    count.dataset.role = 'group-count';
    el.append(arrow, label, count);
  }

  /**
   * Build the flat item sequence the virtualList renders. No group → plain rows
   * (unchanged behaviour). A group axis active → cluster the (optimistic-patch-
   * aware) display order with sortGrouped, then walk it into
   * `[{kind:'group'}, {kind:'row'}, …]`, resolving card_ref group keys to their
   * display label through the matching lookup map.
   */
  private buildItems(rows: CardWithAttrs[]): GroupItem<CardWithAttrs>[] {
    const g = this.group;
    if (g === null) return walkGrouped(sortByPersonal(rows.slice()), null, () => '');
    const ordered = sortGrouped(rows.slice(), g.attr, this.groupDir);
    return walkGrouped(ordered, g.attr, (key) => this.labelForGroupKey(key, g.lookup));
  }

  /** Discriminate a flat GroupItem onto a pooled node: header content for a
   *  `group` item, the data-row cells for a `row` item (using the row's
   *  rows-only `idx` as its selection index, so headers don't offset it). */
  private fillItem(el: HTMLElement, item: GroupItem<CardWithAttrs>): void {
    if (item.kind === 'group') {
      this.makeHeaderMode(el);
      el.dataset.groupKey = item.key;
      el.dataset.groupDir = this.groupDir;
      const arrow = childByRole(el, 'group-arrow');
      if (arrow) arrow.textContent = this.groupDir === 'asc' ? '↑' : '↓';
      const label = childByRole(el, 'group-label');
      if (label) label.textContent = item.label;
      const count = childByRole(el, 'group-count');
      if (count) count.textContent = `· ${item.count}`;
    } else {
      this.makeRowMode(el);
      this.fillRow(el, item.row, item.idx);
    }
  }

  /** Resolve a group key to its display label: a card_ref id goes through the
   *  group axis's lookup map (persons / statuses / milestones / components);
   *  scalars are their own label. Coerces the key via {@link asAttrId} so an
   *  un-revived wire form (digit-string for un-primed card_ref attrs like
   *  `originator`) still resolves a name. Mirrors the Grid's labelForGroupKey. */
  private labelForGroupKey(key: unknown, lookup: string | null): string {
    if (lookup !== null) {
      const id = asAttrId(key);
      if (id !== null) {
        const map = this.lookup(lookup);
        const k = id.toString();
        return map[k] ?? `#${k}`;
      }
    }
    return String(key);
  }

  /**
   * Swap a pooled row's content for `row`. Sets `data-card-id` from the task
   * (NOT node state), resolves the assignee + status labels from the lookup
   * tree paths, reflects selection, the brighter personal-sort indicator, and
   * the delegate picker's current value. Called every time the slot shows a
   * different task and on every lookups/routing tick.
   */
  private fillRow(el: HTMLElement, row: CardWithAttrs, index: number): void {
    el.dataset.cardId = row.id.toString();
    el.dataset.index = String(index);
    // The row that just reordered settles into its new slot; every other fill
    // clears the class so a recycled node keeps no stale animation. The id
    // persists past the optimistic re-render (cleared on the next dragstart).
    applySettle(el, 'inbox__row--settling', this.settleRowId !== null && row.id === this.settleRowId);
    el.classList.toggle('inbox__row--selected', index === this.selectedIndex);
    el.setAttribute('aria-selected', index === this.selectedIndex ? 'true' : 'false');
    // Brighter leading indicator for a personally-ordered row vs server default.
    const personallyOrdered = typeof row.personal_sort_order === 'number';
    el.classList.toggle('inbox__row--ordered', personallyOrdered);

    const idEl = childByRole(el, 'id');
    if (idEl) idEl.textContent = `#${row.id.toString()}`;
    const title = childByRole(el, 'title');
    if (title) title.textContent = titleOf(row);

    const statusEl = childByRole(el, 'status');
    if (statusEl) this.fillStatus(statusEl, row);

    const assigneeEl = childByRole(el, 'assignee');
    if (assigneeEl) {
      const a = row.attributes['assignee'];
      if (typeof a === 'bigint') {
        const map = this.lookup('persons');
        assigneeEl.textContent = map[a.toString()] ?? `#${a.toString()}`;
        assigneeEl.style.display = '';
      } else {
        assigneeEl.textContent = '';
        assigneeEl.style.display = 'none';
      }
    }

    const priorityEl = childByRole(el, 'priority');
    if (priorityEl) {
      const p = row.attributes['priority'];
      if (typeof p === 'string' && p.length > 0) {
        priorityEl.textContent = p;
        priorityEl.dataset.priority = p;
        priorityEl.style.display = '';
      } else {
        priorityEl.textContent = '';
        priorityEl.style.display = 'none';
      }
    }

    const delegate = childByRole(el, 'delegate') as HTMLSelectElement | null;
    if (delegate) this.fillDelegate(delegate, row);
  }

  /** Resolve + render the status pill (phase-toned via data-phase when known). */
  private fillStatus(el: HTMLElement, row: CardWithAttrs): void {
    const s = row.attributes['status'];
    if (typeof s !== 'bigint') {
      el.textContent = '';
      el.style.display = 'none';
      return;
    }
    const map = this.lookup('statuses');
    el.textContent = map[s.toString()] ?? `#${s.toString()}`;
    el.style.display = '';
  }

  /** Populate the per-row delegate <select> with the user's agents + reflect the
   *  card's current routing. Hidden when no agents resolve (data gap / no
   *  agents owned). */
  private fillDelegate(sel: HTMLSelectElement, row: CardWithAttrs): void {
    const agents = (this.ctx.tree.at(['inbox', 'agents']).peek<AgentOption[]>() ?? []) as AgentOption[];
    if (agents.length === 0) {
      sel.style.display = 'none';
      sel.replaceChildren();
      return;
    }
    sel.style.display = '';
    // Rebuild options (cheap; the agent set is small + stable).
    const opts: HTMLOptionElement[] = [];
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— delegate —';
    opts.push(none);
    for (const a of agents) {
      const o = document.createElement('option');
      o.value = a.id.toString();
      o.textContent = a.label;
      opts.push(o);
    }
    sel.replaceChildren(...opts);

    const routing = (this.ctx.tree.at(['inbox', 'routing']).peek<Record<string, bigint>>() ?? {}) as Record<
      string,
      bigint
    >;
    const routed = routing[row.id.toString()];
    sel.value = routed === undefined ? '' : routed.toString();
  }

  private lookup(name: string): LabelMap {
    return (this.ctx.tree.at(['inbox', 'lookups', name]).peek<LabelMap>() ?? {}) as LabelMap;
  }

  /* ------------------------------- reorder ------------------------------ */

  /**
   * The visible row the dragged row would land BEFORE for a pointer at `clientY`
   * (the first non-dragged, non-parked row whose vertical midpoint is below the
   * pointer). Returns null when released past the last row (an end drop). Mirrors
   * computeDropTarget's iteration but returns the node so the commit can reuse
   * the row-based onRowDrop (card-id → data index, scroll-robust).
   */
  private dropBeforeRow(body: HTMLElement, clientY: number): HTMLElement | null {
    const moved = draggingRowId?.toString();
    const nodes = (body.querySelectorAll?.('[data-inbox-row]') ?? []) as unknown as HTMLElement[];
    for (const node of nodes) {
      if (node.style?.display === 'none') continue;
      if (node.dataset?.cardId === moved) continue;
      const rect = node.getBoundingClientRect?.();
      if (!rect || (rect.top === 0 && rect.bottom === 0)) continue;
      if (clientY < rect.top + rect.height / 2) return node;
    }
    return null;
  }

  /**
   * Resolve a drop onto a row: reorder the dragged row relative to this row's
   * slot. With `clientY` (a drop ONTO the row), the pointer's vertical half
   * decides BEFORE (upper) vs AFTER (lower) — so a drop on the LAST row's lower
   * half reaches the end (#30). Without it (a gap drop, where dropBeforeRow
   * already resolved the row to go before), it inserts BEFORE. No layout
   * (test shim → 0-rects) falls back to BEFORE, the historical default.
   */
  private onRowDrop(targetRow: HTMLElement, clientY?: number): void {
    const movedId = draggingRowId;
    draggingRowId = null;
    if (movedId === null) return;
    const targetIdStr = targetRow.dataset.cardId;
    if (targetIdStr === undefined) return;
    const targetId = BigInt(targetIdStr);
    if (targetId === movedId) return;

    const rows = this.currentRows();
    const fromIdx = rows.findIndex((r) => r.id === movedId);
    const toIdx = rows.findIndex((r) => r.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    // Lower-half drop → insert AFTER the target; otherwise BEFORE it.
    let after = false;
    if (clientY !== undefined) {
      const rect = targetRow.getBoundingClientRect?.();
      if (rect && (rect.top !== 0 || rect.bottom !== 0)) {
        after = clientY >= rect.top + rect.height / 2;
      }
    }
    // insertAt counts in the list with the moved row removed; a downward move
    // past the moved row's old slot needs the -1 correction.
    let insertAt = after ? toIdx + 1 : toIdx;
    if (fromIdx < insertAt) insertAt -= 1;
    this.reorderTo(movedId, insertAt);
  }

  /**
   * Reorder the row with [movedId] to [insertAt] (slot in the list with the
   * moved row removed). Patches the list optimistically (applyPersonalReorder)
   * and fires one `reorderRow` (user_card_sort.set) per affected card in the
   * same tick — the dispatcher coalesces them into one batch. Each carries its
   * own optimistic personal_sort_order patch (so the per-action rollback is
   * granular); we ALSO patch the whole list up front so the FLIP-like reorder
   * paints immediately even for the no-write rows.
   */
  private reorderTo(movedId: bigint, insertAt: number): void {
    const rows = this.currentRows();
    const updates = planPersonalReorder(rows, movedId, insertAt);
    if (updates.length === 0) return;
    // FLIP (#context): snapshot positions before the optimistic patch, slide
    // rows to their new slots after the in-place re-render (drag OR keyboard).
    // The moved row also gets a settle ring.
    this.flip.capture();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this.flip.play());
    this.settleRowId = movedId;
    // Up-front optimistic list patch so the order paints before the writes land
    // (the per-action patches reconcile each row's personal_sort_order, but the
    // whole-list patch also reseats rows whose value already matched).
    this.ctx.tree.at(this.tasksPath).set(applyPersonalReorder(rows, movedId, insertAt));
    for (const u of updates) {
      this.intent('reorderRow', { cardId: u.cardId, sortOrder: u.sortOrder });
    }
  }

  /** Move the keyboard-selected row by `delta` (±1) and persist the new order. */
  private reorderSelected(delta: number): void {
    const rows = this.currentRows();
    if (rows.length < 2) return;
    if (this.selectedIndex < 0 || this.selectedIndex >= rows.length) return;
    const row = rows[this.selectedIndex];
    if (row === undefined) return;
    const newIdx = move(rows.length, this.selectedIndex, delta);
    if (newIdx === this.selectedIndex) return;
    // Slots sit BEFORE rows: an up move targets slot newIdx; a down move targets
    // newIdx (after the moved row is removed, the remaining target shifts).
    this.reorderTo(row.id, newIdx);
    this.selectedIndex = newIdx;
    this.repaintSelection();
  }

  /* ----------------------------- selection ------------------------------ */

  private selectByCardId(id: bigint): void {
    const rows = this.currentRows();
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return;
    this.selectedIndex = i;
    this.repaintSelection();
  }

  /** Open a task, publishing the inbox's row order first so task-detail
   *  prev/next nav (#18) walks the same sequence. */
  private openTask(idStr: string): void {
    publishTaskNav(this.ctx.tree, this.currentRows().map((r) => r.id));
    navigate(taskUrl(idStr));
  }

  private moveSelection(delta: number): void {
    const rows = this.currentRows();
    if (rows.length === 0) return;
    this.selectedIndex = move(rows.length, this.selectedIndex, delta);
    this.repaintSelection();
  }

  /** Re-apply the selected class to the currently visible pooled rows by their
   *  data-index (recycling-safe — reads the live index dataset). */
  private repaintSelection(): void {
    const body = this.listBody;
    if (body === null) return;
    const nodes = body.querySelectorAll?.('[data-inbox-row]') ?? [];
    for (const node of nodes as unknown as HTMLElement[]) {
      const idx = Number(node.dataset?.index ?? '-1');
      const on = idx === this.selectedIndex;
      node.classList?.toggle('inbox__row--selected', on);
      node.setAttribute?.('aria-selected', on ? 'true' : 'false');
    }
  }

  /** The current DISPLAY row order — the grouped order (group key, then personal
   *  sort within each bucket) when a group axis is active, else the flat
   *  personal-sorted order. This matches each row item's `idx` from walkGrouped,
   *  so the keyboard selection + reorder math index into the same sequence the
   *  body renders. */
  private currentRows(): CardWithAttrs[] {
    const rows = (this.ctx.tree.at(this.tasksPath).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    if (this.group === null) return sortByPersonal(rows.slice());
    return sortGrouped(rows.slice(), this.group.attr, this.groupDir);
  }

  /* ------------------------------- hotkeys ------------------------------ */

  /** The Inbox's keyboard map: j/k cursor, Shift+j/k reorder. Declared so the
   *  HotkeyController binds them when the Inbox is the active control. The
   *  `run` callbacks drive the selection/reorder directly (no intent hop). */
  override hotkeys(): readonly import('../core/hotkeys.js').HotkeyBinding[] {
    return [
      { binding: 'n', run: () => this.ctx.bus?.emit('quickCreateOpen'), label: 'New task' },
      { binding: 'j', run: () => this.moveSelection(1), label: 'Next task' },
      { binding: 'k', run: () => this.moveSelection(-1), label: 'Previous task' },
      // Up/Down also navigate rows while the filter-bar search input has focus
      // (typing in the search shouldn't strand the cursor — Up/Down don't move
      // the caret in a text input, so this is safe). Left/Right stay default
      // (they DO move the caret) so typing isn't hijacked.
      { binding: 'ArrowDown', run: () => this.moveSelection(1), label: 'Next task', fireInInputs: true },
      { binding: 'ArrowUp', run: () => this.moveSelection(-1), label: 'Previous task', fireInInputs: true },
      { binding: ['Shift+j', 'Shift+ArrowDown'], run: () => this.reorderSelected(1), label: 'Move row down' },
      { binding: ['Shift+k', 'Shift+ArrowUp'], run: () => this.reorderSelected(-1), label: 'Move row up' },
      ...(this.config.hotkeys ?? []),
    ];
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

function titleAttr(r: CardWithAttrs): string {
  const t = r.attributes['title'];
  return typeof t === 'string' && t.length > 0 ? t : `#${r.id.toString()}`;
}

function titleOrName(r: CardWithAttrs): string {
  const t = r.attributes['title'] ?? r.attributes['name'];
  return typeof t === 'string' && t.length > 0 ? t : `#${r.id.toString()}`;
}

/** Coerce a wire id (bigint after revival, or number/string) to bigint. */
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/** A user.select row's display label: display_name / title / name, else #id. */
function agentLabel(r: Record<string, unknown>): string {
  const v = r['display_name'] ?? r['title'] ?? r['name'];
  if (typeof v === 'string' && v.length > 0) return v;
  return `#${asId(r['id']).toString()}`;
}

function isMap(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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

export function registerInbox(): void {
  Control.register('Inbox', Inbox);
}

/** Test seam: reset module-level drag state between tests. */
export function _resetInboxDragState(): void {
  draggingRowId = null;
}

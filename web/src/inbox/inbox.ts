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
import { navigate, taskUrl } from '../shell/router.js';
import { SPEC } from '../kanban/specs.js';
import { INBOX_SPEC } from './specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import {
  applyPersonalReorder,
  move,
  planPersonalReorder,
  sortByPersonal,
} from './inbox-helpers.js';
import type { CardWherePredicate } from '../projects/project-helpers.js';
import {
  type Predicate,
  type WireNode,
  isFlatAndOfLeaves,
  toWhereLeaves,
  toWire,
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
  /** Index of the keyboard-selected row (j/k cursor + Shift+j/k reorder). */
  private selectedIndex = 0;

  /** Whether the routed-to-me (agent) view is active. */
  private routedToMe = false;

  /** Whether the mine_only scope toggle is active. */
  private mineOnly = false;

  /** The viewport element (the virtualList scroll container) — held so reorder
   *  geometry + focus can find rows. */
  private listBody: HTMLElement | null = null;

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
        order: {
          lit: [
            { field: 'personal_sort_order', direction: 'ASC' },
            { field: 'created_at', direction: 'DESC' },
          ],
        },
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
    this.ctx.tree.at(['inbox', 'routedToMe']).set(false);
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

    const toggles = document.createElement('div');
    toggles.className = 'inbox__toggles';

    const routedToggle = this.buildToggle(
      'inbox-routed-toggle',
      'Routed to me',
      'Show tasks routed to me as an agent',
      () => this.toggleRoutedToMe(),
    );
    const mineToggle = this.buildToggle(
      'inbox-mine-toggle',
      'Mine only',
      'Narrow to tasks assigned to me',
      () => this.toggleMineOnly(),
    );
    toggles.append(mineToggle.el, routedToggle.el);
    header.append(toggles);
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
      routedToggle.setActive(routed);
    }, 'inbox.agentBanner');

    // Rows render through the recycling virtualList. `data()` reads the tasks
    // leaf reactively AND the lookups tick (late label/agent lands re-resolve)
    // AND the routing leaf (a delegate set/clear repaints the picker). The list
    // is sorted by personal_sort_order so an optimistic patch re-orders it.
    const vl = virtualList<CardWithAttrs>({
      container: body,
      rowHeight: INBOX_ROW_HEIGHT,
      data: () => {
        this.ctx.tree.at(['inbox', 'lookups', 'tick']).get();
        this.ctx.tree.at(['inbox', 'routing']).get();
        const rows = (tasksNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
        return sortByPersonal(rows.slice());
      },
      create: (el) => this.buildRowShell(el),
      update: (el, row, i) => this.fillRow(el, row, i),
      name: 'inbox.rows',
    });
    this.onDestroy(() => vl.dispose());

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
      this.applyFilter(search, predicate);
      this.bumpQuery();
    }, 'inbox.filterWatch');

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
      if (this.mineOnly) {
        const search = this.ctx.tree.at(['screen', 'search']).peek<string>() ?? '';
        const predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
        this.applyFilter(search, predicate);
        this.bumpQuery();
      }
    }, 'inbox.identityWatch');
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
  }

  private tickLookups(): void {
    const node = this.ctx.tree.at(['inbox', 'lookups', 'tick']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /* ------------------------------- toggles ------------------------------ */

  private buildToggle(
    testId: string,
    label: string,
    title: string,
    onToggle: () => void,
  ): { el: HTMLElement; setActive(on: boolean): void } {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inbox__toggle';
    btn.dataset.inboxToggle = testId;
    btn.title = title;
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = label;
    this.listen(btn, 'click', () => onToggle());
    return {
      el: btn,
      setActive(on: boolean): void {
        btn.classList.toggle('inbox__toggle--active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      },
    };
  }

  private toggleRoutedToMe(): void {
    this.routedToMe = !this.routedToMe;
    // One-way write: the tasks query reads this leaf at fire time; bumping the
    // version refires it. The agentBanner effect repaints from the same leaf.
    this.ctx.tree.at(['inbox', 'routedToMe']).set(this.routedToMe);
    this.bumpQuery();
  }

  private toggleMineOnly(): void {
    this.mineOnly = !this.mineOnly;
    const btn = this.el.querySelector('[data-inbox-toggle="inbox-mine-toggle"]') as HTMLElement | null;
    if (btn) {
      btn.classList.toggle('inbox__toggle--active', this.mineOnly);
      btn.setAttribute('aria-pressed', this.mineOnly ? 'true' : 'false');
    }
    // Re-project the filter (the mine_only assignee leaf rides in applyFilter)
    // and refire. Reads the live search/predicate via the tree.
    const search = this.ctx.tree.at(['screen', 'search']).peek<string>() ?? '';
    const predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    this.applyFilter(search, predicate);
    this.bumpQuery();
  }

  /* ----------------------------- query driver --------------------------- */

  /**
   * Project the active search + the Advanced predicate (+ the mine_only
   * assignee leaf when a currentUserId is configured) to the tasks query's
   * `where[]` / `tree` leaves. Same flat-AND-vs-structured contract as
   * Grid/Kanban: a flat AND composes into where[]; a structured tree rides the
   * v2 `tree` field while the search leaf stays in where[].
   */
  private applyFilter(search: string, predicate: Predicate | null): void {
    const needle = search.trim();
    const leaves: CardWherePredicate[] = [];
    if (needle.length > 0) leaves.push({ attr: 'title', op: 'contains', value: needle });

    // mine_only: AND an `assignee = me` leaf — using the resolved identity
    // (config override, else the landed auth.user). Before the identity resolves
    // (null) this is a no-op refire; the identity-watch effect re-applies the
    // filter once the probe lands.
    const me = this.resolveUserId();
    if (this.mineOnly && me !== null) {
      leaves.push({ attr: 'assignee', op: '=', value: me });
    }

    let where: CardWherePredicate[] | undefined;
    let tree: WireNode | undefined;

    if (predicate === null) {
      where = leaves.length > 0 ? leaves : undefined;
    } else if (isFlatAndOfLeaves(predicate)) {
      const combined = [...leaves, ...(toWhereLeaves(predicate) ?? [])];
      where = combined.length > 0 ? combined : undefined;
    } else {
      where = leaves.length > 0 ? leaves : undefined;
      tree = toWire(predicate);
    }

    this.ctx.tree.at(['inbox', 'where']).set(where);
    this.ctx.tree.at(['inbox', 'tree']).set(tree);
  }

  private bumpQuery(): void {
    const node = this.ctx.tree.at(['inbox', 'queryVersion']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /* -------------------------------- rows -------------------------------- */

  /**
   * Build ONE pooled row node (virtualList `create`). The drag affordances +
   * the delegate <select> change listener are attached HERE (once), reading the
   * live card id from `data-card-id` at event time — never a captured card,
   * since the node recycles to a different row on scroll.
   */
  private buildRowShell(el: HTMLElement): void {
    el.className = 'inbox__row';
    el.dataset.inboxRow = '';
    el.setAttribute('role', 'listitem');
    el.tabIndex = 0;
    el.draggable = true;

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

    // A row click selects AND opens the task detail (`/task/:id`); Enter / `o`
    // on the focused row opens it too. The id comes from `data-card-id` (set
    // per fill, never stale on a recycled node). navigate() is a one-way
    // History write outside any tracked effect — cascade-safe. Clicks that
    // originate on the delegate <select> are ignored (its own change handler
    // owns those) so picking an agent never bounces into the detail.
    this.listen(el, 'click', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target && target.dataset?.role === 'delegate') return;
      const idStr = el.dataset.cardId;
      if (idStr === undefined) return;
      this.selectByCardId(BigInt(idStr));
      navigate(taskUrl(idStr));
    });
    this.listen(el, 'keydown', (ev) => {
      const k = (ev as KeyboardEvent).key;
      if (k === 'Enter' || k === 'o') {
        ev.preventDefault();
        const idStr = el.dataset.cardId;
        if (idStr !== undefined) navigate(taskUrl(idStr));
      }
    });
    this.listen(el, 'dragstart', (ev) => {
      const idStr = el.dataset.cardId;
      draggingRowId = idStr !== undefined ? BigInt(idStr) : null;
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
    });
    this.listen(el, 'dragover', (ev) => {
      ev.preventDefault();
      el.classList.add('inbox__row--drop');
    });
    this.listen(el, 'dragleave', () => el.classList.remove('inbox__row--drop'));
    this.listen(el, 'drop', (ev) => {
      ev.preventDefault();
      el.classList.remove('inbox__row--drop');
      this.onRowDrop(el, ev as DragEvent);
    });
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

  /** Resolve a drop onto a row: reorder the dragged row to this row's slot. */
  private onRowDrop(targetRow: HTMLElement, _ev: DragEvent): void {
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
    // insertAt counts BEFORE the target row in the list with the moved row
    // removed; a downward move past its old slot needs the -1 correction.
    let insertAt = toIdx;
    if (fromIdx < toIdx) insertAt -= 1;
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

  /** The current (personal-sorted) row order. */
  private currentRows(): CardWithAttrs[] {
    const rows = (this.ctx.tree.at(this.tasksPath).peek<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
    return sortByPersonal(rows.slice());
  }

  /* ------------------------------- hotkeys ------------------------------ */

  /** The Inbox's keyboard map: j/k cursor, Shift+j/k reorder. Declared so the
   *  HotkeyController binds them when the Inbox is the active control. The
   *  `run` callbacks drive the selection/reorder directly (no intent hop). */
  override hotkeys(): readonly import('../core/hotkeys.js').HotkeyBinding[] {
    return [
      { binding: 'n', run: () => this.ctx.bus?.emit('quickCreateOpen'), label: 'New task' },
      { binding: ['j', 'ArrowDown'], run: () => this.moveSelection(1), label: 'Next task' },
      { binding: ['k', 'ArrowUp'], run: () => this.moveSelection(-1), label: 'Previous task' },
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

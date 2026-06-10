/**
 * CardListCore — the shared "common control structure" every card-list body is
 * built on. It owns the parts that were triplicated across the old Inbox / Grid
 * / Comms controls:
 *
 *   - the card QUERY (card_type-driven `card.select_with_attributes`, where/tree/
 *     order composed from the shared `screen.predicate` + `screen.search` + the
 *     phase toggle), plus the value-card LOOKUPS (status / person / milestone /
 *     component / tag) used for badges, ref columns, and group-header labels;
 *   - the virtualised item list (group headers + rows), with the j/k CURSOR
 *     (single-select), the Set-backed BULK SELECTION (multi-select + range +
 *     select-all), and Shift+j/k personal-sort REORDER;
 *   - GROUP-by (screen.groupAxis → walkGrouped buckets), mine-only / routed-to-me,
 *     and per-row delegate-to-agent.
 *
 * Subclasses supply ONLY the presentation: `createRoot`, the per-row DOM
 * (`ensureRowMode` + `fillRowCard`), and the table chrome. No behavior is
 * special-cased per presentation — instead the core is PLUGGABLE: a subclass
 * overrides {@link leafPrefix} to keep its own tree namespace (the Grid stays on
 * `grid.*` so its helpers + tests are untouched), {@link rowSelector} /
 * {@link selectedClass} for its cursor styling, and {@link extraOrderClauses}
 * for extra wire ordering (the Grid's column sort). NO card_type is hardcoded —
 * it flows from the `screen.cardType` leaf.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ActionBinding, QueryBinding } from '../core/data.js';
import { SPEC } from '../kanban/specs.js';
import { INBOX_SPEC } from '../inbox/specs.js';
import { asAttrId, type CardWithAttrs } from '../kanban/kanban-helpers.js';
import { virtualList, type VirtualListHandle } from '../core/virtual-list.js';
import { navigate, taskUrl } from '../shell/router.js';
import { publishTaskNav } from '../shell/task-nav.js';
import { applySearchFilter, type Predicate, type WireNode } from '../filter/predicate.js';
import { walkGrouped, GROUP_EMPTY_KEY, type GroupAttr, type GroupItem } from '../filter/group-axis.js';
import { applyPersonalReorder, move, planPersonalReorder, sortByPersonal, sortGrouped } from '../inbox/inbox-helpers.js';
import { DropPlaceholder, computeDropTarget } from '../ui/drag-placeholder.js';
import { AUTH_USER_PATH, peekCurrentUserId, type AuthUser } from '../auth/auth-state.js';

export type LabelMap = Record<string, string>;
export interface AgentOption {
  id: bigint;
  label: string;
}

/** Config shared by every card-list body (presentation subclasses extend this). */
export interface CardListCoreConfig extends BaseControlConfig {
  /** Tree path the loaded rows live at (the Grid keeps 'grid.tasks'). Default
   *  `<leafPrefix>.rows`. */
  tasksPath?: string;
  /** Load the task value-card lookups (persons / milestones / components). */
  loadTaskLookups?: boolean;
  /** Load the `tag` lookups (path + color) — the Grid's tag columns. */
  loadTags?: boolean;
  /** When set, rows show a parent-card chip; the parent card_type whose titles
   *  are loaded for the chip (e.g. 'task' for a comm). */
  parentChipCardType?: string;
  /** A boolean attr rendered/filtered as a flag when FALSE (comm `acked`). */
  flagAttr?: string;
  flagLabel?: string;
  /** Row opens itself or its parent card. Default 'self'. */
  openTarget?: 'self' | 'parent';
  /** Honour `screen.groupAxis` — render group headers + bucket rows. */
  group?: boolean;
  /** Per-user personal sort: query `with_personal_sort`, Shift+j/k reorder. */
  personalSort?: boolean;
  /** Per-row delegate-to-agent picker (loads agents + routing). */
  delegate?: boolean;
  /** Honour the `inbox.mineOnly` / `inbox.routedToMe` view-toggle leaves. */
  viewToggles?: boolean;
  /** Test/host override for the signed-in user's id (mine_only assignee leaf). */
  currentUserId?: bigint;
  /** Wire order[] when not personal-sorted. Default created_at DESC. */
  order?: Array<{ field: string; direction: 'ASC' | 'DESC' }>;
}

/**
 * Build the shared QueryBinding[] for a given tree-leaf prefix. The query
 * STRUCTURE is identical for every body; only the driver leaves (`<p>.order`,
 * `<p>.queryVersion`, …) are namespaced so a presentation can keep its own
 * leaves. `card_type` is always the flow-derived `screen.cardType`.
 */
export function buildCardListQueries(p: string): QueryBinding[] {
  return [
    {
      name: 'cards',
      spec: SPEC.selectWithAttributes,
      when: { signal: `${p}.queryVersion` },
      input: {
        cardTypeName: { from: 'screen.cardType' },
        projectId: { from: 'scope.projectId' },
        withPersonalSort: { from: `${p}.withPersonalSort` },
        routedToMe: { from: `${p}.routedToMe` },
        order: { from: `${p}.order` },
        where: { from: `${p}.where` },
        tree: { from: `${p}.tree` },
        limit: { lit: 200 },
      },
      skipWhenNull: ['cardTypeName', 'projectId'],
      result: { method: 'landCards' },
      onError: 'self',
    },
    {
      name: 'statuses',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'status' }, projectId: { from: 'scope.projectId' } },
      skipWhenNull: ['projectId'],
      result: { method: 'landStatuses' },
      onError: 'self',
    },
    {
      name: 'persons',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'person' }, _gate: { config: 'loadTaskLookups' } },
      skipWhenNull: ['_gate'],
      result: { method: 'landPersons' },
      onError: 'self',
    },
    {
      name: 'milestones',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'milestone' }, projectId: { from: 'scope.projectId' }, _gate: { config: 'loadTaskLookups' } },
      skipWhenNull: ['projectId', '_gate'],
      result: { method: 'landMilestones' },
      onError: 'self',
    },
    {
      name: 'components',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'component' }, projectId: { from: 'scope.projectId' }, _gate: { config: 'loadTaskLookups' } },
      skipWhenNull: ['projectId', '_gate'],
      result: { method: 'landComponents' },
      onError: 'self',
    },
    {
      name: 'tags',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { lit: 'tag' }, projectId: { from: 'scope.projectId' }, _gate: { config: 'loadTags' } },
      skipWhenNull: ['projectId', '_gate'],
      result: { method: 'landTags' },
      onError: 'self',
    },
    {
      name: 'parents',
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: { cardTypeName: { config: 'parentChipCardType' }, projectId: { from: 'scope.projectId' } },
      skipWhenNull: ['cardTypeName', 'projectId'],
      result: { method: 'landParents' },
      onError: 'self',
    },
    {
      name: 'agents',
      spec: 'user.select',
      when: { signal: `${p}.parentUserId` },
      input: { parentUserId: { from: `${p}.parentUserId` }, isAgent: { lit: true } },
      skipWhenNull: ['parentUserId'],
      result: { method: 'landAgents' },
      onError: { method: 'agentsLoadFailed' },
    },
    {
      name: 'routing',
      spec: INBOX_SPEC.userCardAgentList,
      when: { signal: 'scope.projectId' },
      input: { parentCardId: { from: 'scope.projectId' }, _gate: { config: 'delegate' } },
      skipWhenNull: ['parentCardId', '_gate'],
      result: { method: 'landRouting' },
      onError: { method: 'routingLoadFailed' },
    },
  ];
}

/** Build the shared reorder / delegate ActionBinding[] for a leaf prefix. */
export function buildCardListActions(p: string): ActionBinding[] {
  const rowsPath = `${p}.rows`;
  const routingPath = `${p}.routing`;
  return [
    {
      intent: 'reorderRow',
      spec: INBOX_SPEC.userCardSortSet,
      input: { cardId: { payload: 'cardId' }, sortOrder: { payload: 'sortOrder' } },
      optimistic: {
        path: rowsPath,
        patch: (current, payload): CardWithAttrs[] => {
          const rows = Array.isArray(current) ? (current as CardWithAttrs[]) : [];
          const pl = (payload ?? {}) as { cardId?: bigint; sortOrder?: number };
          if (pl.cardId === undefined || pl.sortOrder === undefined) return rows;
          return rows.map((r) => (r.id === pl.cardId ? { ...r, personal_sort_order: pl.sortOrder as number } : r));
        },
      },
      onError: 'top',
    },
    {
      intent: 'delegateRow',
      spec: INBOX_SPEC.userCardAgentSet,
      input: { cardId: { payload: 'cardId' }, agentUserId: { payload: 'agentUserId' } },
      optimistic: {
        path: routingPath,
        patch: (current, payload): Record<string, bigint> => {
          const map = isMap(current) ? { ...(current as Record<string, bigint>) } : {};
          const pl = (payload ?? {}) as { cardId?: bigint; agentUserId?: bigint };
          if (pl.cardId !== undefined && pl.agentUserId !== undefined) map[pl.cardId.toString()] = pl.agentUserId;
          return map;
        },
      },
      onError: 'top',
    },
    {
      intent: 'clearDelegateRow',
      spec: INBOX_SPEC.userCardAgentClear,
      input: { cardId: { payload: 'cardId' } },
      optimistic: {
        path: routingPath,
        patch: (current, payload): Record<string, bigint> => {
          const map = isMap(current) ? { ...(current as Record<string, bigint>) } : {};
          const pl = (payload ?? {}) as { cardId?: bigint };
          if (pl.cardId !== undefined) delete map[pl.cardId.toString()];
          return map;
        },
      },
      onError: 'top',
    },
  ];
}

export abstract class CardListCore<Cfg extends CardListCoreConfig = CardListCoreConfig> extends Control<Cfg> {
  protected statusInfo = new Map<string, { label: string; phase: string }>();
  protected parentTitles = new Map<string, string>();
  protected loaded = false;
  protected flaggedOnly = false;
  /** Single-select keyboard cursor into the ROW order (group headers excluded). */
  protected selectedIndex = 0;
  protected cursorRestored = false;
  protected group: GroupAttr | null = null;
  protected groupDir: 'asc' | 'desc' = 'asc';
  protected items: GroupItem<CardWithAttrs>[] = [];
  protected vlist: VirtualListHandle | null = null;
  protected listEl!: HTMLElement;
  protected emptyEl: HTMLElement | null = null;
  protected rowHeight = 56;
  protected selectionAnchor: string | null = null;

  /** Drag-to-reorder (personalSort lists): the gliding insertion bar, the id of
   *  the row currently being dragged, and the live insertion slot under the
   *  pointer. The grip is the drag source; the scroll viewport is the drop zone. */
  private dropBar: DropPlaceholder | null = null;
  private draggingRowId: string | null = null;
  private dropSlot: number | null = null;

  /** The default body (cardlist) shares; the Grid overrides leafPrefix() →'grid'. */
  static override queries: readonly QueryBinding[] = buildCardListQueries('cardlist');
  static override actions: readonly ActionBinding[] = buildCardListActions('cardlist');

  /** The tree-leaf namespace this body keeps its driver / lookup / selection
   *  leaves under. Default 'cardlist'; the Grid overrides to 'grid' so its
   *  helpers + tests stay on grid.* — the ONLY per-presentation knob the data
   *  layer needs. A subclass that overrides this MUST also set its static
   *  `queries`/`actions` via buildCardListQueries/Actions(prefix). */
  protected leafPrefix(): string {
    return 'cardlist';
  }
  private px(...parts: string[]): string[] {
    return [this.leafPrefix(), ...parts];
  }
  protected get rowsPath(): string[] {
    return this.config.tasksPath !== undefined ? this.config.tasksPath.split('.') : this.px('rows');
  }

  /* ---- presentation hooks (subclass-provided) ------------------------------ */
  protected abstract ensureRowMode(el: HTMLElement): void;
  protected abstract fillRowCard(el: HTMLElement, card: CardWithAttrs, index: number): void;
  protected refreshView(): void {
    this.vlist?.refresh();
  }
  /** The selector + class the cursor paints onto (the Grid uses its own row). */
  protected rowSelector(): string {
    return '[data-card-row]';
  }
  protected selectedClass(): string {
    return 'card-list__row--selected';
  }
  /** Subclass-supplied order clauses (the Grid's header sort), injected ahead of
   *  the personal/created defaults. */
  protected extraOrderClauses(): Array<{ field: string; direction: 'ASC' | 'DESC' }> {
    return [];
  }
  /** Hook: a subclass reacts to a fresh card list (the Grid rebuilds columns). */
  protected onCardsLanded(_rows: CardWithAttrs[]): void {}

  /* ---- core wiring (subclass render() calls these) ------------------------- */

  protected wireList(): void {
    this.vlist = virtualList<GroupItem<CardWithAttrs>>({
      container: this.listEl,
      rowHeight: this.rowHeight,
      data: () => {
        const rows = (this.ctx.tree.at(this.rowsPath).get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
        this.ctx.tree.at(this.px('groupVersion')).get();
        this.items = this.computeItems(rows);
        return this.items;
      },
      create: (el) => {
        el.style.height = `${this.rowHeight}px`;
      },
      update: (el, item) => this.fillItem(el, item),
      name: 'cardList.rows',
    });
    this.onDestroy(() => this.vlist?.dispose());
  }

  protected wireCoreEffects(): void {
    if (this.config.group === true) {
      this.effect(() => {
        const next = this.ctx.tree.at(['screen', 'groupAxis']).get<GroupAttr | null>() ?? null;
        if ((next?.attr ?? null) !== (this.group?.attr ?? null)) this.groupDir = 'asc';
        this.group = next;
        this.rebuildItems();
        this.applyFilterAndOrder();
        this.bumpQuery();
      }, 'cardList.group');
    }
    if (this.config.delegate === true || this.config.viewToggles === true) {
      this.effect(() => {
        this.ctx.tree.at([...AUTH_USER_PATH]).get<AuthUser | undefined>();
        const me = this.resolveUserId();
        if (this.config.delegate === true) {
          const node = this.ctx.tree.at(this.px('parentUserId'));
          if (node.peek<bigint | null>() !== me) node.set(me);
        }
      }, 'cardList.identity');
    }
    this.effect(() => {
      this.ctx.tree.at(['screen', 'cardType']).get();
      this.ctx.tree.at(['scope', 'projectId']).get();
      this.ctx.tree.at(['screen', 'predicate']).get();
      this.ctx.tree.at(['screen', 'search']).get();
      this.ctx.tree.at(['screen', 'searchFields']).get();
      if (this.config.viewToggles === true) {
        this.ctx.tree.at(['inbox', 'mineOnly']).get();
        this.ctx.tree.at(['inbox', 'routedToMe']).get();
        this.ctx.tree.at([...AUTH_USER_PATH]).get();
      }
      this.applyFilterAndOrder();
      this.bumpQuery();
    }, 'cardList.query');
  }

  protected wireListInteractions(): void {
    if (this.emptyEl !== null) {
      this.effect(() => {
        const rows = (this.ctx.tree.at(this.rowsPath).get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
        this.emptyEl!.textContent = this.loaded ? 'Nothing in this view.' : 'Loading…';
        this.emptyEl!.style.display = rows.length === 0 ? '' : 'none';
      }, 'cardList.empty');
    }
    this.effect(() => {
      const n = this.ctx.tree.at(['screen', 'enterBodyNonce']).get<number>() ?? 0;
      if (n === 0 || this.rowCount() === 0) return;
      if (this.selectedIndex < 0 || this.selectedIndex >= this.rowCount()) this.selectedIndex = 0;
      this.repaintSelection();
      this.el.focus();
    }, 'cardList.enterBody');
    this.listen(this.el, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key !== 'Enter' && e.key !== 'o') return;
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest(this.rowSelector())) return;
      e.preventDefault();
      this.openRowIndex(this.selectedIndex);
    });
    this.wireRowDrag();
  }

  /** Container-level drag-to-reorder wiring (personalSort lists only). The grip
   *  on each row (see {@link makeRowGrip}) is the native-DnD source; the scroll
   *  viewport is the drop zone: dragover glides the insertion bar to the gap
   *  under the pointer, drop commits the move via {@link reorderTo}. Wired once;
   *  reads the dragged id + live slot off instance state, never a captured row. */
  private wireRowDrag(): void {
    if (this.config.personalSort !== true) return;
    this.dropBar = new DropPlaceholder(this.listEl);
    this.onDestroy(() => this.dropBar?.destroy());
    this.listen(this.listEl, 'dragover', (ev) => {
      if (this.draggingRowId === null) return;
      ev.preventDefault(); // mark the viewport a valid drop target
      const t = this.dropTargetFor((ev as DragEvent).clientY, this.draggingRowId);
      this.dropSlot = t.insertAt;
      this.dropBar?.showAtY(t.y);
    });
    this.listen(this.listEl, 'drop', (ev) => {
      if (this.draggingRowId === null) return;
      ev.preventDefault();
      if (this.dropSlot !== null) {
        this.reorderTo(BigInt(this.draggingRowId), this.dropSlot);
        this.dropBar?.pulse();
        // Land the cursor on the row that just moved so Shift+J/K continues there.
        const moved = this.draggingRowId;
        const idx = this.displayRows().findIndex((r) => r.id.toString() === moved);
        if (idx >= 0) {
          this.selectedIndex = idx;
          this.repaintSelection();
          this.rememberCursor();
        }
      }
      this.draggingRowId = null;
      this.dropSlot = null;
    });
  }

  /** Resolve the insertion point + bar-y for a pointer at `clientY`. Ungrouped:
   *  the slot among all other rows. Grouped: the slot is taken among the dragged
   *  row's OWN group only (so the bar + drop clamp to that group's span), then
   *  offset by the group's start in the display order to land a full-list index. */
  private dropTargetFor(clientY: number, draggedId: string): { insertAt: number; y: number } {
    if (this.group === null) {
      const t = computeDropTarget(this.listEl, clientY, draggedId, this.rowSelector());
      return { insertAt: t.slot, y: t.y };
    }
    const display = this.displayRows();
    const dragged = display.find((r) => r.id.toString() === draggedId);
    const gk = dragged !== undefined ? this.groupKeyOf(dragged) : '';
    const same = new Set(display.filter((r) => this.groupKeyOf(r) === gk).map((r) => r.id.toString()));
    const lo = display.findIndex((r) => this.groupKeyOf(r) === gk);
    const t = computeDropTarget(this.listEl, clientY, draggedId, this.rowSelector(), (id) => same.has(id));
    return { insertAt: Math.max(0, lo) + t.slot, y: t.y };
  }

  /** Build a drag grip for a personalSort row — the native-DnD source. ensureRowMode
   *  appends it (lifted above the stretched row link via z-index in styles.css).
   *  Reads the live card id off the row's dataset at drag time, never captured:
   *  the pooled node recycles to a different card on scroll. */
  protected makeRowGrip(el: HTMLElement): HTMLElement {
    const grip = document.createElement('span');
    grip.className = 'card-list__grip';
    grip.dataset.role = 'grip';
    grip.textContent = '⋮⋮';
    grip.setAttribute('aria-hidden', 'true');
    grip.draggable = true;
    // A click on the grip must never open the row (it sits over the row link).
    this.listen(grip, 'click', (ev) => ev.stopPropagation());
    this.listen(grip, 'dragstart', (ev) => {
      const id = el.dataset.cardId;
      // No linear order to rewrite while grouped, or a row with no id → no drag.
      if (!this.reorderEnabled() || id === undefined || id === '') {
        ev.preventDefault();
        return;
      }
      this.draggingRowId = id;
      el.classList.add('card-list__row--dragging');
      const dt = (ev as DragEvent).dataTransfer;
      if (dt) {
        dt.effectAllowed = 'move';
        dt.setData('text/plain', id); // textContent only — never markup
        dt.setDragImage?.(el, 12, 12); // ghost the whole row, not the tiny grip
      }
    });
    this.listen(grip, 'dragend', () => {
      el.classList.remove('card-list__row--dragging');
      // A drop already cleared these; this also covers a cancelled / outside drop.
      if (this.draggingRowId !== null) {
        this.draggingRowId = null;
        this.dropSlot = null;
        this.dropBar?.hide();
      }
    });
    return grip;
  }

  protected coreHotkeys(): import('../core/hotkeys.js').HotkeyBinding[] {
    const base: import('../core/hotkeys.js').HotkeyBinding[] = [
      { binding: 'j', run: () => this.moveSelection(1), label: 'Next' },
      { binding: 'k', run: () => this.moveSelection(-1), label: 'Previous' },
      { binding: 'ArrowDown', run: () => this.moveSelection(1), label: 'Next' },
      { binding: 'ArrowUp', run: () => this.moveSelection(-1), label: 'Previous' },
    ];
    if (this.config.personalSort === true) {
      base.push(
        { binding: ['Shift+j', 'Shift+ArrowDown'], run: () => this.reorderSelected(1), label: 'Move down' },
        { binding: ['Shift+k', 'Shift+ArrowUp'], run: () => this.reorderSelected(-1), label: 'Move up' },
      );
    }
    return base;
  }

  /* ---- data handlers ------------------------------------------------------- */

  protected registerCoreHandlers(): void {
    this.handler('landCards', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      this.loaded = true;
      let restored = false;
      if (!this.cursorRestored) {
        this.cursorRestored = true;
        const want = this.rememberedCursorId();
        if (want !== undefined) {
          const ordered = this.orderRows(rows);
          const i = ordered.findIndex((c) => c.id === want);
          if (i >= 0) {
            this.selectedIndex = i;
            restored = true;
          }
        }
      }
      if (this.selectedIndex >= rows.length) this.selectedIndex = Math.max(0, rows.length - 1);
      this.ctx.tree.at(this.rowsPath).set(rows);
      this.onCardsLanded(rows);
      if (restored) {
        queueMicrotask(() => {
          if (!this.isAlive()) return;
          this.scrollSelectedIntoView();
          this.repaintSelection();
        });
      }
    });

    const landLabels = (name: string) => (out: unknown) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const map: LabelMap = {};
      for (const r of rows) map[r.id.toString()] = labelOf(r);
      this.ctx.tree.at(this.px('lookups', name)).set(map);
      this.refreshView();
    };
    this.handler('landStatuses', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      this.statusInfo.clear();
      const map: LabelMap = {};
      for (const r of rows) {
        this.statusInfo.set(r.id.toString(), { label: labelOf(r), phase: r.phase ?? '' });
        map[r.id.toString()] = labelOf(r);
      }
      this.ctx.tree.at(this.px('lookups', 'statuses')).set(map);
      this.refreshView();
    });
    this.handler('landPersons', landLabels('persons'));
    this.handler('landMilestones', landLabels('milestones'));
    this.handler('landComponents', landLabels('components'));
    this.handler('landTags', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const paths: LabelMap = {};
      const colors: LabelMap = {};
      for (const r of rows) {
        const id = r.id.toString();
        const path = r.attributes['path'];
        paths[id] = typeof path === 'string' && path.length > 0 ? path : `#${id}`;
        const color = r.attributes['color'];
        if (typeof color === 'string' && color.length > 0) colors[id] = color;
      }
      this.ctx.tree.at(this.px('lookups', 'tags')).set(paths);
      this.ctx.tree.at(this.px('lookups', 'tagColors')).set(colors);
      this.refreshView();
    });
    this.handler('landParents', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      this.parentTitles.clear();
      for (const r of rows) this.parentTitles.set(r.id.toString(), labelOf(r));
      this.refreshView();
    });
    this.handler('landAgents', (out) => {
      const rows = ((out ?? {}) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const agents: AgentOption[] = rows.map((r) => ({ id: asId(r['id']), label: agentLabel(r) }));
      this.ctx.tree.at(this.px('agents')).set(agents);
      this.refreshView();
    });
    this.handler('agentsLoadFailed', () => {
      this.ctx.tree.at(this.px('agents')).set([]);
      this.refreshView();
    });
    this.handler('landRouting', (out) => {
      const routing = ((out ?? {}) as { routing?: Record<string, bigint> }).routing ?? {};
      this.ctx.tree.at(this.px('routing')).set(routing);
      this.refreshView();
    });
    this.handler('routingLoadFailed', () => this.refreshView());
  }

  /* ---- query composition --------------------------------------------------- */

  protected orderRows(rows: CardWithAttrs[]): CardWithAttrs[] {
    if (this.group !== null) return sortGrouped(rows.slice(), this.group.attr, this.groupDir);
    const base = this.config.personalSort === true ? sortByPersonal(rows.slice()) : rows.slice();
    return this.idFirst(base);
  }

  /** When the active search is a bare card id (NNNN), surface the exact-id row
   *  first — the "jump to #ID" affordance the search bar advertises. A no-op for
   *  any non-numeric search or when no loaded row matches. (Grouping keeps its
   *  bucket order; the id match still appears, just inside its bucket.) */
  protected idFirst(rows: CardWithAttrs[]): CardWithAttrs[] {
    const needle = (this.ctx.tree.at(['screen', 'search']).peek<string>() ?? '').trim();
    if (!/^\d+$/.test(needle)) return rows;
    const want = BigInt(needle);
    const i = rows.findIndex((r) => r.id === want);
    if (i <= 0) return rows;
    const out = rows.slice();
    const [hit] = out.splice(i, 1);
    out.unshift(hit!);
    return out;
  }

  protected computeItems(rows: CardWithAttrs[]): GroupItem<CardWithAttrs>[] {
    if (this.group === null) return walkGrouped(this.orderRows(rows), null, () => '');
    const ordered = sortGrouped(rows.slice(), this.group.attr, this.groupDir);
    return walkGrouped(ordered, this.group.attr, (key) => this.groupKeyLabel(key, this.group?.lookup ?? null));
  }

  protected rebuildItems(): void {
    const node = this.ctx.tree.at(this.px('groupVersion'));
    node.set((node.peek<number>() ?? 0) + 1);
  }

  protected applyFilterAndOrder(): void {
    const search = this.ctx.tree.at(['screen', 'search']).peek<string>() ?? '';
    const fields = this.ctx.tree.at(['screen', 'searchFields']).peek<string[]>() ?? ['title'];
    const predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    const { where, tree } = applySearchFilter(search, fields, predicate);
    let outWhere = where as WireNode[] | undefined;
    let outTree = tree;

    const extra: WireNode[] = [];
    if (this.flaggedOnly && this.config.flagAttr !== undefined) {
      extra.push({ attr: this.config.flagAttr, op: 'eq', values: [false] });
    }
    if (this.config.viewToggles === true) {
      const mineOnly = this.ctx.tree.at(['inbox', 'mineOnly']).peek<boolean>() ?? false;
      const me = this.resolveUserId();
      if (mineOnly && me !== null) extra.push({ attr: 'assignee', op: '=', values: [me] });
    }
    for (const leaf of extra) {
      if (outTree === undefined) outWhere = [...(outWhere ?? []), leaf];
      else if (outTree.connective === 'and' && Array.isArray(outTree.children))
        outTree = { connective: 'and', children: [...outTree.children, leaf] };
      else outTree = { connective: 'and', children: [outTree, leaf] };
    }
    this.ctx.tree.at(this.px('where')).set(outWhere);
    this.ctx.tree.at(this.px('tree')).set(outTree);

    const order: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
    if (this.group !== null && this.group.tagPrefix === undefined) {
      order.push({ field: `attributes.${this.group.attr}`, direction: this.groupDir === 'asc' ? 'ASC' : 'DESC' });
    }
    for (const o of this.extraOrderClauses()) if (!order.some((x) => x.field === o.field)) order.push(o);
    if (this.config.personalSort === true) {
      order.push({ field: 'personal_sort_order', direction: 'ASC' });
      order.push({ field: 'created_at', direction: 'DESC' });
    }
    if (order.length === 0) order.push(...(this.config.order ?? [{ field: 'created_at', direction: 'DESC' }]));
    this.ctx.tree.at(this.px('order')).set(order);

    this.ctx.tree.at(this.px('withPersonalSort')).set(this.config.personalSort === true ? true : undefined);
    const routed = this.config.viewToggles === true && (this.ctx.tree.at(['inbox', 'routedToMe']).peek<boolean>() ?? false);
    this.ctx.tree.at(this.px('routedToMe')).set(routed ? true : undefined);
  }

  protected bumpQuery(): void {
    const node = this.ctx.tree.at(this.px('queryVersion'));
    node.set((node.peek<number>() ?? 0) + 1);
  }

  protected resolveUserId(): bigint | null {
    if (this.config.currentUserId !== undefined) return this.config.currentUserId;
    return peekCurrentUserId(this.ctx.tree);
  }

  protected getLookup(name: string): LabelMap {
    return (this.ctx.tree.at(this.px('lookups', name)).peek<LabelMap>() ?? {}) as LabelMap;
  }

  /* ---- item dispatch ------------------------------------------------------- */

  protected fillItem(el: HTMLElement, item: GroupItem<CardWithAttrs>): void {
    if (item.kind === 'group') {
      this.makeHeaderMode(el);
      el.dataset.groupKey = item.key;
      const arrow = el.querySelector('[data-role="group-arrow"]') as HTMLElement | null;
      if (arrow) arrow.textContent = this.groupDir === 'asc' ? '↑' : '↓';
      const label = el.querySelector('[data-role="group-label"]') as HTMLElement | null;
      if (label) label.textContent = item.label;
      const count = el.querySelector('[data-role="group-count"]') as HTMLElement | null;
      if (count) count.textContent = `· ${item.count}`;
      return;
    }
    this.ensureRowMode(el);
    this.fillRowCard(el, item.row, item.idx);
  }

  protected makeHeaderMode(el: HTMLElement): void {
    if (el.dataset.cardGroup !== undefined) return;
    delete el.dataset.cardRow;
    delete el.dataset.gridRow;
    delete el.dataset.cardId;
    el.className = 'card-list__group-header';
    el.dataset.cardGroup = '';
    el.tabIndex = 0;
    el.draggable = false;
    el.replaceChildren();
    const arrow = document.createElement('span');
    arrow.className = 'card-list__group-arrow';
    arrow.dataset.role = 'group-arrow';
    const label = document.createElement('span');
    label.className = 'card-list__group-label';
    label.dataset.role = 'group-label';
    const count = document.createElement('span');
    count.className = 'card-list__group-count muted';
    count.dataset.role = 'group-count';
    el.append(arrow, label, count);
    this.listen(el, 'click', () => this.toggleGroupDir());
  }

  protected groupKeyLabel(key: unknown, lookup: string | null): string {
    if (lookup !== null) {
      const id = asAttrId(key);
      if (id !== null) {
        const map = this.getLookup(lookup);
        return map[id.toString()] ?? `#${id.toString()}`;
      }
    }
    return String(key);
  }

  protected toggleGroupDir(): void {
    if (this.group === null) return;
    this.groupDir = this.groupDir === 'asc' ? 'desc' : 'asc';
    this.rebuildItems();
    this.applyFilterAndOrder();
    this.bumpQuery();
  }

  /* ---- cursor (single-select) + reorder + open ----------------------------- */

  protected displayRows(): CardWithAttrs[] {
    return this.items
      .filter((i): i is Extract<GroupItem<CardWithAttrs>, { kind: 'row' }> => i.kind === 'row')
      .map((i) => i.row);
  }
  protected rowCount(): number {
    return this.displayRows().length;
  }

  protected moveSelection(delta: number): void {
    const n = this.rowCount();
    if (n === 0) return;
    this.selectedIndex = Math.max(0, Math.min(n - 1, this.selectedIndex + delta));
    this.repaintSelection();
    this.rememberCursor();
    this.scrollSelectedIntoView();
    this.el.focus({ preventScroll: true });
  }

  protected reorderSelected(delta: number): void {
    if (!this.reorderEnabled()) return;
    const rows = this.displayRows();
    if (rows.length < 2 || this.selectedIndex < 0 || this.selectedIndex >= rows.length) return;
    const row = rows[this.selectedIndex];
    if (row === undefined) return;
    let newIdx = move(rows.length, this.selectedIndex, delta);
    if (this.group !== null) {
      // Grouped → clamp the move to the row's own group: Shift+J/K reorders
      // within the group and stops at its first / last row.
      const [lo, hi] = this.groupSpan(rows, this.groupKeyOf(row));
      newIdx = Math.max(lo, Math.min(hi - 1, newIdx));
    }
    if (newIdx === this.selectedIndex) return;
    this.reorderTo(row.id, newIdx);
    this.selectedIndex = newIdx;
    this.scrollSelectedIntoView();
    this.repaintSelection();
    this.rememberCursor();
  }

  /** Personal-sort reorder is available on any personalSort list. When grouped it
   *  reorders WITHIN the dragged/selected row's group (a drop can't cross a group
   *  boundary — that would mean changing the group attribute, not reordering).
   *  Gates both the keyboard Shift+J/K path and the drag grip. */
  protected reorderEnabled(): boolean {
    return this.config.personalSort === true;
  }

  /** A card's group key under the active group axis, matching {@link walkGrouped}
   *  (the unset / null / '' bucket → {@link GROUP_EMPTY_KEY}). '' when ungrouped. */
  protected groupKeyOf(card: CardWithAttrs): string {
    if (this.group === null) return '';
    const v = card.attributes[this.group.attr];
    return v === undefined || v === null || v === '' ? GROUP_EMPTY_KEY : String(v);
  }

  /** The half-open `[lo, hi)` span of `gk`'s rows within the display order. Groups
   *  are contiguous in the display sequence, so this is one run. `[0, 0]` if none. */
  protected groupSpan(rows: readonly CardWithAttrs[], gk: string): [number, number] {
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < rows.length; i++) {
      if (this.groupKeyOf(rows[i]!) === gk) {
        if (lo < 0) lo = i;
        hi = i + 1;
      }
    }
    return lo < 0 ? [0, 0] : [lo, hi];
  }

  /** Move `movedId` to `insertAt` (a slot among the OTHER rows — the same count
   *  {@link computeDropTarget} returns and the keyboard path's clamped index):
   *  optimistically re-stamp `personal_sort_order`, rebuild, and fire the minimal
   *  `reorderRow` writes. Shared by Shift+J/K and the drag grip. */
  protected reorderTo(movedId: bigint, insertAt: number): void {
    if (!this.reorderEnabled()) return;
    // Operate on the DISPLAY order (grouped or flat) for BOTH the plan and the
    // re-stamp, so a grouped reorder re-canonicalises `personal_sort_order` to
    // follow the grouped order — the moved row lands in its group, every other
    // row keeps its display position. displayRows() is the same set as rowsPath
    // (filtering is server-side), so writing it back loses nothing.
    const rows = this.displayRows();
    const updates = planPersonalReorder(rows, movedId, insertAt);
    const reordered = applyPersonalReorder(rows, movedId, insertAt);
    this.ctx.tree.at(this.rowsPath).set(reordered);
    this.rebuildItems();
    for (const u of updates) this.intent('reorderRow', { cardId: u.cardId, sortOrder: u.sortOrder });
  }

  protected repaintSelection(): void {
    const slots = this.listEl.querySelectorAll(this.rowSelector());
    for (const node of slots as unknown as HTMLElement[]) {
      const on = Number(node.dataset.index ?? '-1') === this.selectedIndex;
      node.classList.toggle(this.selectedClass(), on);
      node.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  protected scrollSelectedIntoView(): void {
    let itemIdx = 0;
    let seenRows = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i]!.kind === 'row') {
        if (seenRows === this.selectedIndex) {
          itemIdx = i;
          break;
        }
        seenRows++;
      }
    }
    const top = itemIdx * this.rowHeight;
    const bottom = top + this.rowHeight;
    const viewTop = this.listEl.scrollTop;
    const viewBottom = viewTop + this.listEl.clientHeight;
    if (top < viewTop) this.listEl.scrollTop = top;
    else if (bottom > viewBottom) this.listEl.scrollTop = bottom - this.listEl.clientHeight;
  }

  protected openRowIndex(index: number): void {
    const card = this.displayRows()[index];
    if (card === undefined) return;
    this.selectedIndex = index;
    this.rememberCardId(card.id);
    publishTaskNav(this.ctx.tree, this.displayRows().map((c) => c.id));
    const targetId = this.openTargetId(card);
    if (targetId !== undefined) navigate(taskUrl(targetId.toString()));
  }

  /** The card a row OPENS — itself, or its parent when `openTarget: 'parent'`
   *  (the comms screen opens the underlying task, not the comm row). Shared by
   *  the in-place open and the pop-out link so both always agree on a target. */
  protected openTargetId(card: CardWithAttrs): bigint | undefined {
    return this.config.openTarget === 'parent' ? card.parent_card_id : card.id;
  }

  /* ---- bulk selection mode (the Grid's checkbox multi-select) -------------- */

  protected get selectionPath(): string[] {
    return this.px('selection');
  }
  protected get selectionVersionPath(): string[] {
    return this.px('selectionVersion');
  }
  protected seedSelection(): void {
    const sel = this.ctx.tree.at(this.selectionPath);
    if (!(sel.peek() instanceof Set)) sel.set(new Set<string>());
    const ver = this.ctx.tree.at(this.selectionVersionPath);
    if (ver.peek<number>() === undefined) ver.set(0);
  }
  protected selection(): Set<string> {
    const s = this.ctx.tree.at(this.selectionPath).peek<Set<string>>();
    return s instanceof Set ? s : new Set<string>();
  }
  protected isSelected(id: bigint): boolean {
    return this.selection().has(id.toString());
  }
  protected setSelection(next: Set<string>): void {
    this.ctx.tree.at(this.selectionPath).set(next);
    const node = this.ctx.tree.at(this.selectionVersionPath);
    node.set((node.peek<number>() ?? 0) + 1);
  }
  protected orderedRowIds(): string[] {
    return this.displayRows().map((c) => c.id.toString());
  }
  protected toggleRowSelection(idStr: string, extend: boolean): void {
    if (idStr === '') return;
    if (extend && this.selectionAnchor !== null && this.selectionAnchor !== idStr) {
      const order = this.orderedRowIds();
      const a = order.indexOf(this.selectionAnchor);
      const b = order.indexOf(idStr);
      if (a !== -1 && b !== -1) {
        const next = new Set(this.selection());
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order[i]!);
        this.setSelection(next);
        this.selectionAnchor = idStr;
        return;
      }
    }
    const next = new Set(this.selection());
    if (next.has(idStr)) next.delete(idStr);
    else next.add(idStr);
    this.setSelection(next);
    this.selectionAnchor = idStr;
  }
  protected selectAllState(): 'none' | 'some' | 'all' {
    const ids = this.orderedRowIds();
    if (ids.length === 0) return 'none';
    const sel = this.selection();
    let hits = 0;
    for (const id of ids) if (sel.has(id)) hits += 1;
    if (hits === 0) return 'none';
    return hits === ids.length ? 'all' : 'some';
  }
  protected toggleSelectAll(): void {
    if (this.selectAllState() === 'all') {
      this.setSelection(new Set<string>());
      return;
    }
    const next = new Set(this.selection());
    for (const id of this.orderedRowIds()) next.add(id);
    this.setSelection(next);
  }

  /* ---- cursor persistence (by card id, per cardType+project) --------------- */

  protected cursorNode() {
    const pid = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
    const ct = this.ctx.tree.at(['screen', 'cardType']).peek<string>() ?? 'task';
    if (pid === null) return null;
    return this.ctx.tree.at(['session', 'cursor', ct, pid.toString()]);
  }
  protected rememberedCursorId(): bigint | undefined {
    const v = this.cursorNode()?.peek<bigint>();
    return typeof v === 'bigint' ? v : undefined;
  }
  protected rememberCardId(id: bigint): void {
    this.cursorNode()?.set(id);
  }
  protected rememberCursor(): void {
    const card = this.displayRows()[this.selectedIndex];
    if (card !== undefined) this.rememberCardId(card.id);
  }

  /* ---- delegate fill (any presentation with config.delegate) --------------- */

  protected fillDelegate(sel: HTMLSelectElement, card: CardWithAttrs): void {
    const agents = (this.ctx.tree.at(this.px('agents')).peek<AgentOption[]>() ?? []) as AgentOption[];
    if (agents.length === 0) {
      sel.style.display = 'none';
      sel.replaceChildren();
      return;
    }
    sel.style.display = '';
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
    const routing = (this.ctx.tree.at(this.px('routing')).peek<Record<string, bigint>>() ?? {}) as Record<string, bigint>;
    const routed = routing[card.id.toString()];
    sel.value = routed === undefined ? '' : routed.toString();
  }

  protected headingLabel(count?: number): string {
    const ct = this.ctx.tree.at(['screen', 'cardType']).peek<string>() ?? '';
    const base = ct === '' ? 'ITEMS' : `${ct.toUpperCase()}S`;
    return count !== undefined && count > 0 ? `${base} · ${count}` : base;
  }
}

/* -------------------------------------------------------------------------- */

export function labelOf(card: CardWithAttrs): string {
  const a = card.attributes;
  const t = a['title'] ?? a['name'];
  return typeof t === 'string' && t.length > 0 ? t : `#${card.id.toString()}`;
}
export function titleOf(card: CardWithAttrs): string {
  const t = card.attributes['title'];
  return typeof t === 'string' && t.length > 0 ? t : '(untitled)';
}
function agentLabel(r: Record<string, unknown>): string {
  const v = r['display_name'] ?? r['title'] ?? r['name'];
  if (typeof v === 'string' && v.length > 0) return v;
  return `#${asId(r['id']).toString()}`;
}
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}
export function idKey(v: unknown): string | null {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  return null;
}
function isMap(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

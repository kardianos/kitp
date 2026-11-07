/**
 * The data side the Calendar and Timeline layouts share
 * (docs/TIMELINE_AND_CALENDAR.md T4, T5, T7): the declarative query and
 * action tables, the filter composition, and the lookups they draw labels
 * from. Each view calls the builders with its own tree prefix ('calendar' /
 * 'timeline') and spreads the result into its `static queries` / `static
 * actions` — one table, two owners, no per-view branches.
 *
 * Tree leaves under the prefix `<p>`:
 *   <p>.queryVersion   bumped on scope / filter change and after a failed or
 *                      tray write — refires both task reads;
 *   <p>.datedTree      the screen's filter AND "has a start or a due date";
 *   <p>.undatedTree    the screen's filter AND "has neither";
 *   <p>.tasks          the dated tasks (CardWithAttrs[]);
 *   <p>.unscheduled    the tray's rows, at most UNSCHEDULED_LIMIT (+1 to tell
 *                      that there are more);
 *   <p>.lookups.<name> value-card lists (statuses / persons / milestones /
 *                      components / tags) for labels, status glyphs, bands
 *                      and milestone markers.
 *
 * Writes: a drag becomes the ordered writes of a ReschedulePlan, fired as
 * intents in one tick so they coalesce into one batch (one transaction). The
 * FIRST write carries the optimistic patch of the whole new pair; the rest
 * carry none, because two snapshots of one leaf can't roll back in order. On
 * any fault the view re-reads (the server's state wins), and the central fault
 * funnel shows the refusal.
 */

import type { ActionBinding, QueryBinding } from '../core/data.js';
import { SPEC } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { applySearchFilter, withScopeTree, type Predicate, type WireNode } from '../filter/predicate.js';
import { DUE_ATTR, START_ATTR, type TaskDates } from './placement.js';
import type { ReschedulePlan } from './reschedule.js';
import { isoDateOf } from './dates.js';

/** How many undated tasks the tray lists. One more is fetched to tell there are more. */
export const UNSCHEDULED_LIMIT = 200;

/** The value-card lists the views load, each by `card_type`. */
export const SCHEDULE_LOOKUPS: ReadonlyArray<{ name: string; cardType: string; scoped: boolean }> = [
  { name: 'statuses', cardType: 'status', scoped: true },
  { name: 'persons', cardType: 'person', scoped: false },
  { name: 'milestones', cardType: 'milestone', scoped: true },
  { name: 'components', cardType: 'component', scoped: true },
  { name: 'tags', cardType: 'tag', scoped: true },
];

/** "Has a start or a due date" — what a view draws. */
const DATED: WireNode = {
  connective: 'or',
  children: [
    { attr: START_ATTR, op: 'exists' },
    { attr: DUE_ATTR, op: 'exists' },
  ],
};

/** "Has neither" — the Unscheduled tray. */
const UNDATED: WireNode = {
  connective: 'and',
  children: [
    { attr: START_ATTR, op: 'not exists' },
    { attr: DUE_ATTR, op: 'not exists' },
  ],
};

/**
 * The screen's search + Advanced predicate + a personal screen's base filter,
 * ANDed with the dated / undated clause. Always trees: the server reads `tree`
 * over `where[]`.
 */
export function scheduleFilterTrees(
  search: string,
  fields: readonly string[],
  predicate: Predicate | null,
  scopeTree: WireNode | null,
): { dated: WireNode; undated: WireNode } {
  const base = applySearchFilter(search, fields, predicate);
  const scoped = withScopeTree(base.where, base.tree, scopeTree);
  if (scoped.tree === undefined && (scoped.where === undefined || scoped.where.length === 0)) {
    return { dated: DATED, undated: UNDATED };
  }
  return {
    dated: withScopeTree(scoped.where, scoped.tree, DATED).tree ?? DATED,
    undated: withScopeTree(scoped.where, scoped.tree, UNDATED).tree ?? UNDATED,
  };
}

/** The views' read table under prefix `p`. */
export function scheduleQueries(p: string): QueryBinding[] {
  const tasksInput = (treePath: string): QueryBinding['input'] => ({
    cardTypeName: { lit: 'task' },
    // Enclosing-project subtree, so subtasks under another task are listed.
    projectId: { from: 'scope.projectId' },
    // A personal screen lists every project (docs/PERSONAL_SCREENS.md).
    _allProjects: { from: 'scope.allProjects' },
    tree: { from: treePath },
    withWatch: { lit: true },
  });
  const queries: QueryBinding[] = [
    {
      name: 'tasks',
      spec: SPEC.selectWithAttributes,
      when: { signal: `${p}.queryVersion` },
      input: { ...tasksInput(`${p}.datedTree`), order: { lit: [{ field: `attributes.${DUE_ATTR}`, direction: 'ASC' }] } },
      skipWhenNull: ['projectId|_allProjects'],
      result: { method: 'landScheduleTasks' },
      onError: 'self',
    },
    {
      name: 'unscheduled',
      spec: SPEC.selectWithAttributes,
      when: { signal: `${p}.queryVersion` },
      input: {
        ...tasksInput(`${p}.undatedTree`),
        order: { lit: [{ field: 'last_activity_at', direction: 'DESC' }] },
        limit: { lit: UNSCHEDULED_LIMIT + 1 },
      },
      skipWhenNull: ['projectId|_allProjects'],
      result: { method: 'landUnscheduled' },
      onError: 'self',
    },
  ];
  for (const l of SCHEDULE_LOOKUPS) {
    queries.push({
      name: l.name,
      spec: SPEC.selectWithAttributes,
      when: { signal: 'scope.projectId' },
      input: l.scoped
        ? {
            cardTypeName: { lit: l.cardType },
            parentCardId: { from: 'scope.projectId' },
            _allProjects: { from: 'scope.allProjects' },
          }
        : { cardTypeName: { lit: l.cardType } },
      ...(l.scoped ? { skipWhenNull: ['parentCardId|_allProjects'] } : {}),
      result: { method: `landLookup:${l.name}` },
      onError: 'self',
    });
  }
  return queries;
}

/** The pair a write payload carries for the optimistic patch. */
interface WritePayload {
  cardId?: bigint;
  attr?: string;
  value?: string | null;
  next?: TaskDates;
  /** A tray row being dropped onto a day (scheduleDrop). */
  row?: CardWithAttrs;
}

/** `row` with its two dates set to `next` (a cleared date → null). */
export function withDates(row: CardWithAttrs, next: TaskDates): CardWithAttrs {
  return { ...row, attributes: { ...row.attributes, [START_ATTR]: next.start, [DUE_ATTR]: next.due } };
}

/** The optimistic patch of a reschedule: the moved task's new pair. */
export function patchDates(current: unknown, payload: unknown): CardWithAttrs[] {
  const rows = Array.isArray(current) ? (current as CardWithAttrs[]) : [];
  const p = (payload ?? {}) as WritePayload;
  if (p.cardId === undefined || p.next === undefined) return rows;
  const next = p.next;
  return rows.map((r) => (r.id === p.cardId ? withDates(r, next) : r));
}

/** The optimistic patch of a tray drop: the task joins the dated rows. */
export function patchDrop(current: unknown, payload: unknown): CardWithAttrs[] {
  const rows = Array.isArray(current) ? (current as CardWithAttrs[]) : [];
  const p = (payload ?? {}) as WritePayload;
  if (p.row === undefined || p.next === undefined) return rows;
  const id = p.row.id;
  return [...rows.filter((r) => r.id !== id), withDates(p.row, p.next)];
}

/** The views' write table under prefix `p`. */
export function scheduleActions(p: string): ActionBinding[] {
  const input = {
    cardId: { payload: 'cardId' },
    attributeName: { payload: 'attr' },
    value: { payload: 'value' },
  } as const;
  return [
    {
      // The first write of a drag: patches the whole new pair at once.
      intent: 'scheduleWrite',
      spec: SPEC.attributeUpdate,
      input,
      optimistic: { path: `${p}.tasks`, patch: patchDates },
      onError: { method: 'scheduleFailed' },
    },
    {
      // A tray drop: the row moves into the dated list; the tray re-reads after.
      intent: 'scheduleDrop',
      spec: SPEC.attributeUpdate,
      input,
      optimistic: { path: `${p}.tasks`, patch: patchDrop },
      result: { method: 'scheduleDropped' },
      onError: { method: 'scheduleFailed' },
    },
    {
      // Every later write of the same drag: no patch of its own (see above).
      intent: 'scheduleWriteThen',
      spec: SPEC.attributeUpdate,
      input,
      onError: { method: 'scheduleFailed' },
    },
  ];
}

/** Fire a plan's writes as intents, in order, in this tick (one batch). */
export function fireReschedule(
  intent: (name: string, payload: unknown) => void,
  cardId: bigint,
  plan: ReschedulePlan,
  trayRow?: CardWithAttrs,
): void {
  plan.writes.forEach((w, i) => {
    const first = trayRow !== undefined ? 'scheduleDrop' : 'scheduleWrite';
    const payload: WritePayload = { cardId, attr: w.attr, value: w.value, next: plan.next };
    if (trayRow !== undefined) payload.row = trayRow;
    intent(i === 0 ? first : 'scheduleWriteThen', payload);
  });
}

/* -------------------------------------------------------------------------- */
/* Lookups.                                                                    */
/* -------------------------------------------------------------------------- */

/** One value-card as the views use it. */
export interface LookupCard {
  id: bigint;
  label: string;
  sortOrder: number;
  /** Statuses: the phase. */
  phase?: string;
  /** Statuses: the workflow (parent), which groups the glyph ramp. */
  parentId?: bigint;
  /** Milestones: the date (T6), when set. */
  due?: string;
  /** Tags: the full path and the exclusive root. */
  path?: string;
  rootExclusiveAt?: string;
}

export function lookupCardOf(r: CardWithAttrs): LookupCard {
  const so = r.attributes['sort_order'];
  const t = r.attributes['title'] ?? r.attributes['name'];
  const out: LookupCard = {
    id: r.id,
    label: typeof t === 'string' && t !== '' ? t : `#${r.id.toString()}`,
    sortOrder: typeof so === 'number' && Number.isFinite(so) ? so : Number.POSITIVE_INFINITY,
  };
  if (r.phase !== undefined) out.phase = r.phase;
  if (r.parent_card_id !== undefined) out.parentId = r.parent_card_id;
  const due = isoDateOf(r.attributes[DUE_ATTR]);
  if (due !== null) out.due = due;
  const path = r.attributes['path'];
  if (typeof path === 'string' && path !== '') out.path = path;
  const root = r.attributes['root_exclusive_at'];
  if (typeof root === 'string' && root !== '') out.rootExclusiveAt = root;
  return out;
}

/** By `sort_order`, then id — the operator's order, stable across reads. */
export function sortLookups(cards: LookupCard[]): LookupCard[] {
  return cards.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The display title of a task row. */
export function taskTitle(row: CardWithAttrs): string {
  const t = row.attributes['title'];
  return typeof t === 'string' && t !== '' ? t : `Task #${row.id.toString()}`;
}

/**
 * Watch list specs (docs/WATCH_LISTS.md) — each account's own bookmark lists
 * of tasks and threads:
 *
 *   watch_list.list {cardId?}   → { lists: [{ id, title, symbol, description,
 *                                   count, hasCard }] } (the first call makes
 *                                   the account's Stars ★)
 *   watch_list.set {id?, title?, symbol?, description?} → { id }
 *   watch_list.delete {id}      → { id }
 *   watch.set {watchListId, cardId, on} → { on }
 *   watch.items {watchListId}   → { items: [{ cardId, cardType, title, taskId,
 *                                   projectId, projectTitle, status, phase,
 *                                   sortOrder, addedAt }] }
 *   watch.move {watchListId, cardId, sortOrder} → { sortOrder }
 *
 * Generic codec both ways (camelCase ↔ snake_case); ids are strings.
 */

import type { Api } from '../core/api.js';
import { decodeWire, encodeWire } from '../core/codec.js';

export const WATCH_SPEC = {
  lists: 'watch_list.list',
  setList: 'watch_list.set',
  deleteList: 'watch_list.delete',
  set: 'watch.set',
  items: 'watch.items',
  move: 'watch.move',
} as const;

export interface WatchList {
  id: string;
  title: string;
  symbol: string;
  description: string;
  count: number;
  /** With cardId: whether that card is on this list. */
  hasCard: boolean;
}

export interface WatchItem {
  cardId: string;
  /** 'task' or 'comm' (a thread). */
  cardType: string;
  title: string;
  /** For a thread on a task: the task, where it opens ('0' otherwise). */
  taskId: string;
  projectId: string;
  projectTitle: string;
  status: string;
  phase: string;
  sortOrder: number;
  addedAt: string;
}

export interface WatchListSetInput {
  id?: string;
  title?: string;
  symbol?: string;
  description?: string;
}

/** An id the wire may send as a number, string or bigint, as a string. */
function idStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  return '';
}

function normIds<T>(v: T): T {
  if (Array.isArray(v)) return v.map(normIds) as unknown as T;
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      o[k] = k === 'id' || k.endsWith('Id') ? idStr(x) : normIds(x);
    }
    return o as T;
  }
  return v;
}

/** Where an item opens: a task's page; a thread on a task opens on its task,
 *  a thread on its own on its own page. */
export function watchItemHref(item: Pick<WatchItem, 'cardId' | 'cardType' | 'taskId'>): string {
  if (item.cardType === 'comm') {
    return item.taskId !== '' && item.taskId !== '0' ? `/task/${item.taskId}` : `/thread/${item.cardId}`;
  }
  return `/task/${item.cardId}`;
}

/**
 * The sort_order for an item dropped at `slot` among the list's OTHER items
 * (in order): between its new neighbours — the midpoint, or one past an end.
 * The server lists items by it (lower first), as user_card_sort does.
 */
export function sortOrderForSlot(others: readonly number[], slot: number): number {
  const before = slot > 0 ? others[slot - 1] : undefined;
  const after = slot < others.length ? others[slot] : undefined;
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/** The filter picker's options for the watch_list field: your lists. */
export function watchListOptions(out: unknown): Array<{ value: string; label: string }> {
  const lists = ((out as { lists?: WatchList[] } | null)?.lists ?? []) as WatchList[];
  return lists.map((l) => ({ value: l.id, label: `${l.symbol} ${l.title}`.trim() }));
}

export function registerWatchSpecs(api: Api): void {
  const define = <I, O>(endpoint: string, action: string): void => {
    if (api.registry.has({ endpoint, action })) return;
    api.define<I, O>({
      endpoint,
      action,
      encode: (i) => encodeWire(i),
      decode: (raw) => normIds(decodeWire(raw)) as O,
    });
  };
  define<{ cardId?: string | bigint }, { lists: WatchList[] }>('watch_list', 'list');
  define<WatchListSetInput, { id: string }>('watch_list', 'set');
  define<{ id: string | bigint }, { id: string }>('watch_list', 'delete');
  define<{ watchListId: string; cardId: string | bigint; on: boolean }, { on: boolean }>('watch', 'set');
  define<{ watchListId: string }, { items: WatchItem[] }>('watch', 'items');
  define<{ watchListId: string; cardId: string; sortOrder: number }, { sortOrder: number }>('watch', 'move');
}

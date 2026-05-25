/**
 * Pure helpers for the Inbox control — the per-user reorder math, ported from
 * the Svelte client's `client/src/screens/inbox_helpers.ts` (`planReorder` /
 * `move`) and re-expressed against the `web/` card model (`bigint` ids,
 * `personal_sort_order` a top-level field). NOTHING here touches the DOM or
 * signals — exercised directly by `node --test`.
 *
 * The Inbox shares the Kanban's `planSortRewrite` STRATEGY ("rewrite the
 * destination cell to canonical `(i+1)*STEP` spacing"), but it keys on the
 * per-user `personal_sort_order` TOP-LEVEL field rather than the shared
 * `sort_order` attribute — those are two distinct orderings (one is the kanban
 * board's column order, the other is the user's private inbox arrangement).
 * `planPersonalReorder` is that same minimal-rewrite plan over personal_sort.
 */

import { SORT_ORDER_STEP, type CardWithAttrs } from '../kanban/kanban-helpers.js';

export { SORT_ORDER_STEP };

/** Read `personal_sort_order` off a card; non-numeric → undefined. */
function personalSortOf(c: CardWithAttrs): number | undefined {
  const v = c.personal_sort_order;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** One pending `personal_sort_order` write produced by {@link planPersonalReorder}. */
export interface PersonalSortUpdate {
  cardId: bigint;
  sortOrder: number;
}

/**
 * Build the minimal list of `(cardId, sortOrder)` writes that places the card
 * identified by [movedID] into slot [insertAt] of the current row order and
 * leaves the whole list in canonical `(i+1) * STEP` `personal_sort_order`
 * spacing.
 *
 * [rows] is the current display order (with [movedID] still in it). [insertAt]
 * counts BEFORE the slot-th remaining card AFTER the moved card is removed;
 * `insertAt === rows.length - 1` (or larger) means "drop at the bottom".
 *
 * We rewrite the whole list rather than halfway-between math because halfway
 * math silently no-op'd against NULL siblings (ASC NULLS LAST keeps the moved
 * row visually fixed) — see the Svelte helper's doc comment. Only rows whose
 * existing `personal_sort_order` already equals the desired slot value are
 * omitted, so a steady-state single swap emits ~2 writes and a fresh all-NULL
 * seed emits N.
 */
export function planPersonalReorder(
  rows: readonly CardWithAttrs[],
  movedID: bigint,
  insertAt: number,
): PersonalSortUpdate[] {
  const moved = rows.find((r) => r.id === movedID);
  if (moved === undefined) return [];
  const without = rows.filter((r) => r.id !== movedID);
  let target = insertAt;
  if (target < 0) target = 0;
  if (target > without.length) target = without.length;
  const next = without.slice();
  next.splice(target, 0, moved);

  const updates: PersonalSortUpdate[] = [];
  for (let i = 0; i < next.length; i++) {
    const r = next[i];
    if (r === undefined) continue;
    const desired = (i + 1) * SORT_ORDER_STEP;
    if (personalSortOf(r) !== desired) {
      updates.push({ cardId: r.id, sortOrder: desired });
    }
  }
  return updates;
}

/**
 * Apply a planned reorder to a row list optimistically: move [movedID] to slot
 * [insertAt] and stamp every row with the synthetic `(i+1)*STEP`
 * `personal_sort_order` so the visible order matches the planned writes before
 * the server round-trip resolves. Returns a NEW array (callers keep the old one
 * for rollback).
 */
export function applyPersonalReorder(
  rows: readonly CardWithAttrs[],
  movedID: bigint,
  insertAt: number,
): CardWithAttrs[] {
  const moved = rows.find((r) => r.id === movedID);
  if (moved === undefined) return rows.slice();
  const without = rows.filter((r) => r.id !== movedID);
  let target = insertAt;
  if (target < 0) target = 0;
  if (target > without.length) target = without.length;
  const next = without.slice();
  next.splice(target, 0, moved);
  return next.map((r, i) => ({ ...r, personal_sort_order: (i + 1) * SORT_ORDER_STEP }));
}

/**
 * Clamp `current + delta` into `[0, visibleLen - 1]`. Mirrors the Svelte
 * inbox's `move`. Returns 0 for an empty list (the caller gates on empty
 * before issuing arrow-key moves).
 */
export function move(visibleLen: number, current: number, delta: number): number {
  if (visibleLen <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next >= visibleLen) return visibleLen - 1;
  return next;
}

/**
 * Stable sort by `personal_sort_order` ASC, with `id` as the tie-breaker; NULL
 * personal sorts rank last (matches the server's `ASC NULLS LAST`). Returns the
 * same array for chaining. Used to derive the display order the row reconciler
 * renders (the server already orders, but a late optimistic patch keeps the
 * client honest).
 */
export function sortByPersonal(cards: CardWithAttrs[]): CardWithAttrs[] {
  cards.sort((a, b) => {
    const sa = personalSortOf(a);
    const sb = personalSortOf(b);
    if (sa !== undefined && sb !== undefined) {
      const c = sa - sb;
      if (c !== 0) return c;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    if (sa === undefined && sb === undefined) {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    return sa === undefined ? 1 : -1; // nulls last
  });
  return cards;
}

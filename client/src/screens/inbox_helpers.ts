/**
 * Pure helpers for InboxScreen, extracted into a plain `.ts` module so they
 * can be unit-tested without DOM. Mirrors the math from the Dart
 * `_InboxScreenState` (see `client/lib/ui/screens/inbox_screen.dart`).
 */

import type { InboxRow } from '../reg/types.js';

/** Sort-order spacing — mirrors `_kSortOrderStep` from the Dart side. */
export const SORT_ORDER_STEP = 100;

/**
 * Compute the new `personal_sort_order` for a card dropped into slot
 * `dropIndex` (0..N) in `rows`. Slot N sits BEFORE row N; slot N === rows.length
 * means "drop at the bottom".
 *
 * Rules (match the Dart `_newSortOrderAt`):
 *   - empty list:                                     0
 *   - top   (dropIndex <= 0):                         (first ?? STEP) - STEP
 *   - bottom (dropIndex >= rows.length):              (last  ?? 0)    + STEP
 *   - between A and B (both have a personal sort):    (a + b) / 2
 *   - between with A nullish:                         b - STEP
 *   - between with B nullish:                         a + STEP
 *   - between both nullish:                           dropIndex * STEP (stable fallback)
 */
export function computeNewSortOrder(rows: InboxRow[], dropIndex: number): number {
  if (rows.length === 0) return 0;
  if (dropIndex <= 0) {
    const first = rows[0]?.personal_sort_order ?? SORT_ORDER_STEP;
    return first - SORT_ORDER_STEP;
  }
  if (dropIndex >= rows.length) {
    const last = rows[rows.length - 1]?.personal_sort_order ?? 0;
    return last + SORT_ORDER_STEP;
  }
  const a = rows[dropIndex - 1]?.personal_sort_order;
  const b = rows[dropIndex]?.personal_sort_order;
  if (a !== undefined && b !== undefined) return (a + b) / 2;
  if (a !== undefined) return a + SORT_ORDER_STEP;
  if (b !== undefined) return b - SORT_ORDER_STEP;
  return dropIndex * SORT_ORDER_STEP;
}

/**
 * For the Space-key "toggle done" shortcut. Spec says "toggle done", so any
 * non-`done` status target moves to `done`; `done` flips back to `todo`.
 *
 * Returns the target value plus the `attribute.update` payload shape so the
 * screen can hand it straight to the dispatcher.
 */
export function predicateToggleStatus(
  currentStatus: unknown,
): { targetStatus: 'todo' | 'done'; payload: { attributeName: 'status'; value: 'todo' | 'done' } } {
  const target: 'todo' | 'done' = currentStatus === 'done' ? 'todo' : 'done';
  return {
    targetStatus: target,
    payload: { attributeName: 'status', value: target },
  };
}

/**
 * Clamp `current + delta` into `[0, visibleLen - 1]`. Mirrors the small
 * helper used by the projects screen for `j` / `k` navigation.
 *
 * If `visibleLen` is 0 we return 0 — the caller is expected to gate on the
 * empty-list state before issuing arrow-key moves.
 */
export function move(visibleLen: number, current: number, delta: number): number {
  if (visibleLen <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next >= visibleLen) return visibleLen - 1;
  return next;
}

/** One pending sort-order write produced by {@link planReorder}. */
export interface ReorderUpdate {
  cardId: number;
  sortOrder: number;
}

/**
 * Build the minimal list of `(card_id, sort_order)` writes that
 * realises moving `movedID` into slot `insertAt` of the current row
 * order.
 *
 * The original `reorderToSlot` only wrote one row's `sort_order`, which
 * worked when every visible row already had a numeric sort_order but
 * silently no-op'd against a fresh seed where every row is NULL — the
 * moved row got a small sort_order while NULL siblings still ranked
 * after it (ASC NULLS LAST), so its visible position didn't change.
 *
 * The new plan walks the desired final order and emits an update for
 * every row whose existing sort_order doesn't match its new position
 * (`(i + 1) * STEP`). In practice:
 *
 *   - all-NULL initial state, move row 0 down: every row in the new
 *     order receives a fresh sort_order — N writes.
 *   - all rows have monotonic sort_orders (steady state), single
 *     swap: only the two swapped rows are written — 2 writes.
 *   - move within an already-numbered tail: just the moved row.
 *
 * The screen issues every update concurrently via dispatcher.request,
 * which coalesces them into one batch + one tx server-side. The
 * post-commit refresh then re-fetches the canonical order.
 */
export function planReorder(
  rows: InboxRow[],
  movedID: number,
  insertAt: number,
): ReorderUpdate[] {
  const moved = rows.find((r) => r.id === movedID);
  if (moved === undefined) return [];
  const without = rows.filter((r) => r.id !== movedID);
  let target = insertAt;
  if (target < 0) target = 0;
  if (target > without.length) target = without.length;
  const next = without.slice();
  next.splice(target, 0, moved);

  const updates: ReorderUpdate[] = [];
  for (let i = 0; i < next.length; i++) {
    const r = next[i];
    if (r === undefined) continue;
    const desired = (i + 1) * SORT_ORDER_STEP;
    if (r.personal_sort_order !== desired) {
      updates.push({ cardId: r.id, sortOrder: desired });
    }
  }
  return updates;
}

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

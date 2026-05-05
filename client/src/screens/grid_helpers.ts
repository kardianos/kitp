/**
 * Pure helpers for {@link GridScreen}. Extracted so the test suite can
 * exercise them under the node-only vitest runner without mounting a
 * Svelte component.
 *
 * Three responsibilities live here:
 *   - {@link cycleSort}: header-click sort cycling (asc → desc → off).
 *   - {@link buildOrderClauses}: project a {@link SortState} onto the
 *     `card.select_with_attributes` `order` payload shape.
 *   - {@link applyFilterToTree}: project the active predicate onto the
 *     `tree` payload shape, or pass through a caller-provided base tree.
 */

import { predicateToJson, type Predicate } from '../filter/predicate.js';
import type { CardOrderClause } from '../reg/types.js';

/* -------------------------------------------------------------------------- */
/* SortState                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The grid's active sort. `field` is the wire field name passed to the
 * server in `card.select_with_attributes` `order[].field` (e.g.
 * `attributes.title`, `created_at`); `direction` mirrors the server's
 * `ASC`/`DESC` convention but stored as the lower-case discriminator.
 */
export interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

/* -------------------------------------------------------------------------- */
/* cycleSort                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Header-click sort cycling.
 *
 * Behaviour mirrors the Dart `_toggleSort` (with the addition of an
 * explicit "off" stop so users can return to the server's default
 * `ORDER BY c.id`):
 *
 *   - `current === null`            → asc on [field]
 *   - `current.field === field`     → asc → desc, desc → null (off)
 *   - `current.field !== field`     → asc on [field] (switch column)
 *
 * Returns the next state. `null` means no sort is active and the caller
 * should send an empty `order: []`.
 */
export function cycleSort(
  current: SortState | null,
  field: string,
): SortState | null {
  if (current === null || current.field !== field) {
    return { field, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { field, direction: 'desc' };
  }
  // Already desc on this column — turn it off.
  return null;
}

/* -------------------------------------------------------------------------- */
/* buildOrderClauses                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Project a {@link SortState} onto the wire `order` array. Returns an
 * empty array (not undefined) so callers can spread the result without
 * branching; the encoder in `handlers.ts` already drops empty arrays.
 *
 * The server expects `direction: 'ASC' | 'DESC'`; we upper-case here.
 */
export function buildOrderClauses(sort: SortState | null): CardOrderClause[] {
  if (sort === null) return [];
  return [
    {
      field: sort.field,
      direction: sort.direction === 'asc' ? 'ASC' : 'DESC',
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* applyFilterToTree                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Project the active filter predicate onto the wire `tree` field.
 *
 * - `predicate === null`               → return [currentTree] unchanged
 *   (so callers can pass a base tree like `parent_card_id` they want
 *   preserved when no extra filter is set).
 * - flat predicate (single leaf)       → wrap in a one-child AND group
 *   (the server's `CardWhereGroup` requires a `connective` at the root).
 * - already a group                    → emit verbatim via `predicateToJson`.
 *
 * Returns `undefined` only when both the predicate and the base tree are
 * absent (callers omit the field entirely so the server applies its
 * default).
 */
export function applyFilterToTree(
  predicate: Predicate | null,
  currentTree: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (predicate === null) return currentTree;
  if (predicate.kind === 'group') {
    return predicateToJson(predicate) as Record<string, unknown>;
  }
  // Bare leaf — wrap in a single-child AND so the wire is always a group.
  return {
    connective: 'and',
    children: [predicateToJson(predicate)],
  };
}

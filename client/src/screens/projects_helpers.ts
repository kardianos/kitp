/**
 * Pure helpers for `ProjectsScreen`.
 *
 * Extracted into a TypeScript module so they can be unit-tested without
 * a Svelte component-mount runtime (the vitest setup is node-only).
 *
 * Three helpers:
 *   - `searchAndFilter` applies the (substring search, FilterBar predicate)
 *     pair over the loaded `card.select_with_attributes` rows.
 *   - `move` clamps the keyboard-driven `selectedIndex` into the visible
 *     range (defensive against out-of-bounds deltas).
 *   - `buildInitialBatch` returns the per-screen-mount fan-out the screen
 *     issues to the dispatcher: one `card.select_with_attributes` for
 *     `card_type_name='project'`, one `attribute_def.select` (cached via
 *     `AttributeSchemaCache.load()`), and one `user.select` (used so the
 *     filter bar can label `assignee` chips on per-project tasks). Tests
 *     assert the count is `3` so the initial-batch contract is locked.
 */

import type { Predicate } from '../filter/predicate.js';
import { isFlatAndOfLeaves, flattenLeaves } from '../filter/predicate.js';
import type { CardWithAttrs } from '../reg/types.js';

/** Lower-case substring match on `attributes.title` (or fallback string). */
function projectTitle(p: CardWithAttrs): string {
  const t = p.attributes['title'];
  if (typeof t === 'string') return t;
  return '';
}

/**
 * Apply `predicate` (top-level flat AND of leaves with `eq` / `ne` / `in`
 * / `notIn` / `exists` / `notExists`) and a substring `search` against
 * `attributes.title` over [projects].
 *
 * Predicate matching is intentionally minimal — the projects screen only
 * loads top-level project cards (server already filters on
 * `card_type_name='project'`); the FilterBar's palette is empty by
 * default, so most users never hit the predicate path. Advanced users
 * who hand-author leaves get correct semantics for the operators above
 * and a no-op fallback (returns row) for anything else, which matches
 * "show everything when the filter says nothing actionable" intent.
 */
export function searchAndFilter(
  projects: readonly CardWithAttrs[],
  search: string,
  predicate: Predicate | null,
): CardWithAttrs[] {
  const needle = search.trim().toLowerCase();
  const out: CardWithAttrs[] = [];
  for (const p of projects) {
    if (needle.length > 0) {
      const t = projectTitle(p).toLowerCase();
      if (!t.includes(needle)) continue;
    }
    if (predicate !== null && !matchPredicate(p, predicate)) continue;
    out.push(p);
  }
  return out;
}

/** Best-effort predicate evaluation on the client-side rows. */
function matchPredicate(card: CardWithAttrs, p: Predicate): boolean {
  if (p.kind === 'leaf') {
    const value = card.attributes[p.attr];
    const v0 = p.values?.[0];
    switch (p.op) {
      case 'eq':
        return value === v0;
      case 'ne':
        return value !== v0;
      case 'in':
        return (p.values ?? []).some((x) => x === value);
      case 'notIn':
        return !(p.values ?? []).some((x) => x === value);
      case 'exists':
        return value !== undefined && value !== null;
      case 'notExists':
        return value === undefined || value === null;
    }
  }
  // Flat AND. Anything else (OR / NOT / nested) we conservatively pass —
  // the FilterBar's quick-bar can only emit flat-AND, and the advanced
  // editor opens a Modal that callers can use to tighten as needed.
  if (isFlatAndOfLeaves(p)) {
    for (const leaf of flattenLeaves(p)) {
      if (!matchPredicate(card, leaf)) return false;
    }
    return true;
  }
  return true;
}

/**
 * Clamp `current + delta` into `[0, max(visibleLen-1, 0)]`. Returns 0
 * when `visibleLen === 0`.
 */
export function move(visibleLen: number, current: number, delta: number): number {
  if (visibleLen <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > visibleLen - 1) return visibleLen - 1;
  return next;
}

/**
 * Shape of the initial-batch contract. The screen mounts and fires three
 * dispatcher requests in the same render tick (the dispatcher coalesces
 * them into one HTTP `POST /api/v1/batch`):
 *
 *   1. `card.select_with_attributes` — top-level projects.
 *   2. `attribute_def.select` — schema for the FilterBar (cached).
 *   3. `user.select` — assignee labels for any per-project chips.
 *
 * Returning the descriptor shape here keeps the contract assert-able in
 * a unit test without standing up a real dispatcher.
 */
export interface InitialBatchSpec {
  endpoint: string;
  action: string;
}

export function buildInitialBatch(): InitialBatchSpec[] {
  return [
    { endpoint: 'card', action: 'select_with_attributes' },
    { endpoint: 'attribute_def', action: 'select' },
    { endpoint: 'user', action: 'select' },
  ];
}

/** Number of sub-requests the screen issues on mount. Tested explicitly. */
export const initialBatchCount = 3;

/**
 * Pure helpers for `ProjectDetailScreen`.
 *
 * Extracted into a TypeScript module so they can be unit-tested without
 * a Svelte component-mount runtime (the vitest setup is node-only).
 *
 * Two helpers:
 *   - `applyPredicateAndSort` filters a child-task list by an optional
 *     FilterBar predicate (flat AND of leaves with the MVP op set), then
 *     sorts the result by the named field. Pure, deterministic, stable.
 *   - `editingPayload` shapes the inline-edit save: returns
 *     `{changed:false}` when the value hasn't moved, or
 *     `{changed:true, payload}` with the `attribute.update` arguments the
 *     screen's commit-handler should pass to the dispatcher. Trimming
 *     comparison mirrors the inline-edit semantics on TaskDetailScreen.
 */

import type { Predicate } from '../filter/predicate.js';
import { isFlatAndOfLeaves, flattenLeaves } from '../filter/predicate.js';
import type { AttributeUpdateInput, CardWithAttrs } from '../reg/types.js';

/* -------------------------------------------------------------------------- */
/* applyPredicateAndSort                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Apply [predicate] (flat AND of leaves; MVP ops:
 * `eq`/`ne`/`in`/`notIn`/`exists`/`notExists`) to [tasks], then sort the
 * survivors by [sortField]. `predicate === null` returns every task in
 * input order; an empty list always returns `[]` regardless of inputs.
 *
 * Sort semantics:
 *   - Missing values sort AFTER present ones so the user always sees real
 *     data first.
 *   - String values use locale-insensitive lexicographic order; numeric
 *     values use numeric order; everything else falls back to `String()`.
 *   - Sort is STABLE (uses `Array.prototype.sort` which is stable since
 *     ES2019). Callers can chain calls to layer secondary sorts.
 *
 * Predicate-eval matches the lenient semantics from `projects_helpers.ts`:
 * non-flat-AND trees pass through (returning the row), keeping the
 * advanced editor's edge cases visible rather than silently empty.
 */
export function applyPredicateAndSort(
  tasks: readonly CardWithAttrs[],
  predicate: Predicate | null,
  sortField: string,
): CardWithAttrs[] {
  const filtered: CardWithAttrs[] = [];
  for (const t of tasks) {
    if (predicate !== null && !matchPredicate(t, predicate)) continue;
    filtered.push(t);
  }
  if (sortField.length === 0) return filtered;
  const out = filtered.slice();
  out.sort((a, b) => compareByField(a, b, sortField));
  return out;
}

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
  if (isFlatAndOfLeaves(p)) {
    for (const leaf of flattenLeaves(p)) {
      if (!matchPredicate(card, leaf)) return false;
    }
    return true;
  }
  // Non-flat-AND (OR / NOT / nested) — conservatively pass; matches the
  // posture of `projects_helpers.matchPredicate`.
  return true;
}

function fieldValue(card: CardWithAttrs, field: string): unknown {
  if (field === 'id') return card.id;
  if (field === 'card_type_name') return card.card_type_name;
  if (field === 'parent_card_id') return card.parent_card_id;
  return card.attributes[field];
}

function compareByField(a: CardWithAttrs, b: CardWithAttrs, field: string): number {
  const av = fieldValue(a, field);
  const bv = fieldValue(b, field);
  const aMissing = av === null || av === undefined;
  const bMissing = bv === null || bv === undefined;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof av === 'number' && typeof bv === 'number') {
    return av - bv;
  }
  if (typeof av === 'string' && typeof bv === 'string') {
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  }
  const as = String(av);
  const bs = String(bv);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

/* -------------------------------------------------------------------------- */
/* editingPayload                                                             */
/* -------------------------------------------------------------------------- */

/** Result of `editingPayload` — discriminated on `changed`. */
export type EditingPayloadResult =
  | { changed: false }
  | { changed: true; payload: AttributeUpdateInput };

/**
 * Compute the `attribute.update` payload for a committed inline edit.
 *
 * - `currentValue` is what the screen last loaded for the attribute (any
 *   JSON-encodable value; `undefined`/`null` mean "absent").
 * - `newValue` is the value the user typed. Strings are trimmed before
 *   comparison so trailing whitespace alone doesn't trigger a write.
 *
 * Returns `{changed:false}` when the trimmed values are equal — saves a
 * round-trip and keeps the activity log clean. Otherwise returns
 * `{changed:true, payload:{cardId, attributeName, value}}` ready to feed
 * into `dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>`.
 *
 * Note: an empty trimmed `newValue` translates to `value: null`, which
 * the server interprets as "clear attribute" (matches the wire contract
 * documented on `attribute.update` — `null` means clear, missing means
 * no-op).
 */
export function editingPayload(
  cardId: number,
  attributeName: string,
  currentValue: unknown,
  newValue: unknown,
): EditingPayloadResult {
  const cur = normalizeForCompare(currentValue);
  const next = normalizeForCompare(newValue);
  if (cur === next) return { changed: false };
  // Re-derive the wire value (not the normalized comparable). Empty
  // trimmed string -> null (clear); otherwise pass the trimmed string
  // (or non-string value) straight through.
  let wire: unknown;
  if (typeof newValue === 'string') {
    const trimmed = newValue.trim();
    wire = trimmed.length === 0 ? null : trimmed;
  } else {
    wire = newValue;
  }
  return {
    changed: true,
    payload: { cardId, attributeName, value: wire },
  };
}

/** Reduce a value to its comparable form: trim strings, coalesce
 * `undefined`/`null`/empty-string to a single sentinel so blanking an
 * already-empty attribute is a no-op. */
function normalizeForCompare(v: unknown): unknown {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  return v;
}

/* -------------------------------------------------------------------------- */
/* Initial-batch contract                                                     */
/* -------------------------------------------------------------------------- */

/** Shape of the initial-batch contract (mirrors `projects_helpers`). */
export interface InitialBatchSpec {
  endpoint: string;
  action: string;
}

/**
 * The screen mounts and fires SIX dispatcher sub-requests in the same
 * render tick (the dispatcher coalesces them into one HTTP call):
 *
 *   1. `card.select_with_attributes` — the project itself.
 *   2. `card.select_with_attributes` — child tasks under the project.
 *   3. `user.select` — assignee labels.
 *   4. `card.select_with_attributes` — milestones (`card_type='milestone'`).
 *   5. `card.select_with_attributes` — components (`card_type='component'`).
 *   6. `card.select_with_attributes` — tags (`card_type='tag'`).
 *   7. `attribute_def.select` — schema for FilterBar / AttributeSidePanel.
 *
 * The shape is asserted in `project_detail.test.ts` so any future agent
 * can see the contract drift in CI before it lands as a regression.
 */
export function buildInitialBatch(): InitialBatchSpec[] {
  return [
    { endpoint: 'card', action: 'select_with_attributes' }, // project
    { endpoint: 'card', action: 'select_with_attributes' }, // tasks
    { endpoint: 'user', action: 'select' },
    { endpoint: 'card', action: 'select_with_attributes' }, // milestones
    { endpoint: 'card', action: 'select_with_attributes' }, // components
    { endpoint: 'card', action: 'select_with_attributes' }, // tags
    { endpoint: 'attribute_def', action: 'select' },
  ];
}

/** Number of sub-requests the screen issues on mount. Tested explicitly. */
export const initialBatchCount = 7;

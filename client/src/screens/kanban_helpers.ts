/**
 * Pure helpers for {@link KanbanScreen}.
 *
 * Extracted into a TypeScript module so the helpers can be unit-tested
 * under the node-only vitest runner without mounting a Svelte component.
 * Mirrors the math from the Dart `_KanbanScreenState` (see
 * `client/lib/ui/screens/kanban_screen.dart`).
 *
 * The five helpers exported here cover the kanban's pure logic surface:
 *
 *   - {@link groupCardsByColumn} / {@link groupCardsByLane} bucket cards
 *     by attribute value (nulls land in the `''` bucket).
 *   - {@link computeNewSortOrder} computes a halfway sort_order for a
 *     drop slot — same shape as `inbox_helpers.computeNewSortOrder`.
 *   - {@link computeMoveBatch} builds the array of `attribute.update`
 *     ops for one drop, omitting updates whose value did not change.
 *   - {@link nextColumnIndex} clamps `current + dir` into
 *     `[0, columnsLen-1]` for `Mod+Arrow` column navigation.
 */

import type { AttributeUpdateInput, CardWithAttrs } from '../reg/types.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Sort-order spacing — mirrors `_kSortOrderStep` from the Dart side. */
export const SORT_ORDER_STEP = 100;

/* -------------------------------------------------------------------------- */
/* Bucket key helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Map an attribute value to a string bucket key. `null` / `undefined`
 * collapse to `''` so the (un-set) bucket is keyable. Numbers / bools are
 * stringified; strings pass through.
 */
function keyOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return String(v);
}

/* -------------------------------------------------------------------------- */
/* groupCardsByColumn / groupCardsByLane                                      */
/* -------------------------------------------------------------------------- */

/**
 * Bucket [cards] by the value of [columnAttr]. Cards whose attribute is
 * unset (or null/undefined) land in the `''` bucket. The returned record
 * keeps insertion order of buckets (first-seen wins) so callers can
 * iterate `Object.entries` deterministically when there is no canonical
 * column ordering yet.
 */
export function groupCardsByColumn(
  cards: readonly CardWithAttrs[],
  columnAttr: string,
): Record<string, CardWithAttrs[]> {
  const out: Record<string, CardWithAttrs[]> = {};
  for (const c of cards) {
    const k = keyOf(c.attributes[columnAttr]);
    const bucket = out[k];
    if (bucket === undefined) {
      out[k] = [c];
    } else {
      bucket.push(c);
    }
  }
  return out;
}

/**
 * Same shape as {@link groupCardsByColumn} but keyed on the swim-lane
 * attribute. Kept as a separate function (not an alias) so callers can
 * grep for the lane-grouping callsite distinctly from the column one and
 * because the Dart source models them as two distinct axes.
 */
export function groupCardsByLane(
  cards: readonly CardWithAttrs[],
  laneAttr: string,
): Record<string, CardWithAttrs[]> {
  return groupCardsByColumn(cards, laneAttr);
}

/* -------------------------------------------------------------------------- */
/* computeNewSortOrder                                                        */
/* -------------------------------------------------------------------------- */

/** Pull the `sort_order` attribute off a card; non-numeric → undefined. */
function sortOrderOf(c: CardWithAttrs): number | undefined {
  const v = c.attributes['sort_order'];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/**
 * Compute the new sort_order for a card dropped at [slotIndex] (0..N) in
 * [stack]. The list must already be in display order (sort_order ASC).
 *
 * Rules (mirror `inbox_helpers.computeNewSortOrder` and the Dart
 * `_newSortOrderAt`):
 *   - empty stack:                                       0
 *   - top   (slotIndex <= 0):                            (first ?? STEP) - STEP
 *   - bottom (slotIndex >= stack.length):                (last  ?? 0)    + STEP
 *   - between A and B (both have a sort_order):          (a + b) / 2
 *   - between with A nullish:                            b - STEP
 *   - between with B nullish:                            a + STEP
 *   - between both nullish:                              slotIndex * STEP
 */
export function computeNewSortOrder(
  stack: readonly CardWithAttrs[],
  slotIndex: number,
): number {
  if (stack.length === 0) return 0;
  if (slotIndex <= 0) {
    const firstCard = stack[0];
    const first = firstCard !== undefined ? sortOrderOf(firstCard) : undefined;
    return (first ?? SORT_ORDER_STEP) - SORT_ORDER_STEP;
  }
  if (slotIndex >= stack.length) {
    const lastCard = stack[stack.length - 1];
    const last = lastCard !== undefined ? sortOrderOf(lastCard) : undefined;
    return (last ?? 0) + SORT_ORDER_STEP;
  }
  const aCard = stack[slotIndex - 1];
  const bCard = stack[slotIndex];
  const a = aCard !== undefined ? sortOrderOf(aCard) : undefined;
  const b = bCard !== undefined ? sortOrderOf(bCard) : undefined;
  if (a !== undefined && b !== undefined) return (a + b) / 2;
  if (a !== undefined) return a + SORT_ORDER_STEP;
  if (b !== undefined) return b - SORT_ORDER_STEP;
  return slotIndex * SORT_ORDER_STEP;
}

/* -------------------------------------------------------------------------- */
/* computeMoveBatch                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One `attribute.update` op the screen will hand to the dispatcher.
 *
 * `cardId` + `attributeName` + `value` mirror {@link AttributeUpdateInput}
 * exactly; we re-export the type via `Pick` instead of a fresh interface
 * so adding fields server-side surfaces here automatically.
 */
export type UpdateOp = Pick<
  AttributeUpdateInput,
  'cardId' | 'attributeName' | 'value'
>;

/**
 * Build the array of `attribute.update` ops for one drag-drop. ONE batch
 * combines:
 *   1. The new `sort_order` for the dragged card. Always emitted unless
 *      the card's existing sort_order already matches [newSortOrder]
 *      exactly (rare; same-cell, unchanged-position drops).
 *   2. The new column attribute value, if it changed.
 *   3. The new lane attribute value, if [laneAttrName] is non-null and
 *      the value changed.
 *
 * Updates whose value did not change are OMITTED — the spec ("changing
 * only sort returns 1 op; changing column + sort returns 2 ops; changing
 * all three returns 3") asserts this directly.
 *
 * The dispatcher batches these into ONE `POST /api/v1/batch` when issued
 * synchronously in the same tick.
 */
export function computeMoveBatch(
  card: CardWithAttrs,
  targetColumnAttrValue: unknown,
  targetLaneAttrValue: unknown,
  newSortOrder: number,
  columnAttrName: string,
  laneAttrName: string | null,
): UpdateOp[] {
  const ops: UpdateOp[] = [];

  // sort_order — emit unless the existing value already matches.
  const currentSort = sortOrderOf(card);
  if (currentSort !== newSortOrder) {
    ops.push({
      cardId: card.id,
      attributeName: 'sort_order',
      value: newSortOrder,
    });
  }

  // Column attribute — emit only when the destination key differs from
  // the current one. Comparison happens on the bucket-key shape so the
  // assignee=7 (number) → '7' (string) round-trip from the picker still
  // collapses to "no change".
  const currentColKey = keyOf(card.attributes[columnAttrName]);
  const targetColKey = keyOf(targetColumnAttrValue);
  if (currentColKey !== targetColKey) {
    ops.push({
      cardId: card.id,
      attributeName: columnAttrName,
      value: targetColumnAttrValue,
    });
  }

  // Lane attribute — only when a lane axis is active AND the value changed.
  if (laneAttrName !== null) {
    const currentLaneKey = keyOf(card.attributes[laneAttrName]);
    const targetLaneKey = keyOf(targetLaneAttrValue);
    if (currentLaneKey !== targetLaneKey) {
      ops.push({
        cardId: card.id,
        attributeName: laneAttrName,
        value: targetLaneAttrValue,
      });
    }
  }

  return ops;
}

/* -------------------------------------------------------------------------- */
/* nextColumnIndex                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Clamp `currentIdx + dir` into `[0, columnsLen - 1]`. Returns 0 when
 * `columnsLen <= 0` (defensive — the caller should gate on the empty
 * board state before issuing arrow-key column moves).
 *
 * `dir` is conventionally `+1` or `-1` (Mod+Right / Mod+Left); larger
 * deltas are accepted and clamped just like the {@link move} helper used
 * by the inbox / projects screens.
 */
export function nextColumnIndex(
  currentIdx: number,
  columnsLen: number,
  dir: number,
): number {
  if (columnsLen <= 0) return 0;
  const next = currentIdx + dir;
  if (next < 0) return 0;
  if (next > columnsLen - 1) return columnsLen - 1;
  return next;
}

/* -------------------------------------------------------------------------- */
/* Sorting helper (used by the screen)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Sort [cards] in place by `sort_order` ASC with `id` as the tie-breaker
 * (nulls last). Exported so the screen can sort cells before rendering;
 * not part of the spec's required helper set but reused by the test for
 * fixture stability.
 */
export function sortByOrder(cards: CardWithAttrs[]): CardWithAttrs[] {
  cards.sort((a, b) => {
    const sa = sortOrderOf(a);
    const sb = sortOrderOf(b);
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

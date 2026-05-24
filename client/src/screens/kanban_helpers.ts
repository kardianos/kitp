/**
 * Pure helpers for {@link KanbanScreen}.
 *
 * Extracted into a TypeScript module so the helpers can be unit-tested
 * under the node-only vitest runner without mounting a Svelte component.
 *
 * Surface:
 *
 *   - {@link groupCardsByColumn} / {@link groupCardsByLane} bucket cards
 *     by attribute value (nulls land in the `''` bucket).
 *   - {@link planSortRewrite} returns the `sort_order` rewrites for one
 *     drop into a (lane, column) cell — same "rewrite the destination"
 *     strategy as `inbox_helpers.planReorder`. Replaces the older
 *     `computeNewSortOrder` halfway approach, which silently no-op'd
 *     against NULL or float-collapsed neighbours.
 *   - {@link computeMoveBatch} builds the array of `attribute.update`
 *     ops for one drop, omitting updates whose value did not change.
 *   - {@link nextColumnIndex} clamps `current + dir` into
 *     `[0, columnsLen-1]` for `Mod+Arrow` column navigation.
 */

import type { AttributeUpdateInput, CardWithAttrs, ID } from '../reg/types.js';

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
/* planSortRewrite                                                            */
/* -------------------------------------------------------------------------- */

/** Pull the `sort_order` attribute off a card; non-numeric → undefined. */
function sortOrderOf(c: CardWithAttrs): number | undefined {
  const v = c.attributes['sort_order'];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/** One pending `sort_order` write produced by {@link planSortRewrite}. */
export interface SortUpdate {
  cardId: ID;
  sortOrder: number;
}

/**
 * Build the minimal list of `(card_id, sort_order)` writes that places
 * [movedCard] into slot [slot] of [destStack] and leaves the rest of
 * the (lane, column) cell in canonical `(i+1) * STEP` spacing.
 *
 * [destStack] is the cell's current display order with [movedCard]
 * already excluded (so the moved card can come from another cell — the
 * cross-column move case). [slot] sits BEFORE the slot-th remaining
 * card; `slot === destStack.length` means "drop at the bottom" of the
 * cell.
 *
 * Why we rewrite the whole cell instead of halfway-between math (the
 * old `computeNewSortOrder` approach):
 *
 *   - Halfway math silently no-op'd against NULL siblings. The numeric
 *     value would land somewhere, but `ORDER BY sort_order ASC NULLS
 *     LAST` ranks the moved row before the unranked rest regardless of
 *     where the user dropped it.
 *   - Repeated halfway-between-the-same-two-cards drops converge in
 *     floating point and eventually collide, so subsequent drops into
 *     the same gap become no-ops (`currentSort === newSortOrder`).
 *   - Same-self drops compute the same value the moved card already
 *     held, so the move emitted zero ops and the card didn't visibly
 *     move.
 *
 * This mirrors `inbox_helpers.planReorder` — see its doc comment for
 * the original motivation. Cost is N writes worst-case for an N-card
 * cell, all coalesced into a single batch.
 */
export function planSortRewrite(
  destStack: readonly CardWithAttrs[],
  movedCard: CardWithAttrs,
  slot: number,
): SortUpdate[] {
  let target = slot;
  if (target < 0) target = 0;
  if (target > destStack.length) target = destStack.length;

  const finalOrder: CardWithAttrs[] = [
    ...destStack.slice(0, target),
    movedCard,
    ...destStack.slice(target),
  ];

  const updates: SortUpdate[] = [];
  for (let i = 0; i < finalOrder.length; i++) {
    const card = finalOrder[i];
    if (card === undefined) continue;
    const desired = (i + 1) * SORT_ORDER_STEP;
    if (sortOrderOf(card) !== desired) {
      updates.push({ cardId: card.id, sortOrder: desired });
    }
  }
  return updates;
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
 *   1. One `sort_order` op per entry in [sortUpdates] (already
 *      filtered by {@link planSortRewrite} to omit cards whose
 *      existing sort_order matches the desired slot).
 *   2. The new column attribute value, if it changed.
 *   3. The new lane attribute value, if [laneAttrName] is non-null and
 *      the value changed.
 *
 * Updates whose value did not change are OMITTED. The dispatcher batches
 * these into ONE `POST /api/v1/batch` when issued synchronously in the
 * same tick.
 */
export function computeMoveBatch(
  card: CardWithAttrs,
  targetColumnAttrValue: unknown,
  targetLaneAttrValue: unknown,
  sortUpdates: readonly SortUpdate[],
  columnAttrName: string,
  laneAttrName: string | null,
): UpdateOp[] {
  const ops: UpdateOp[] = [];

  for (const u of sortUpdates) {
    ops.push({
      cardId: u.cardId,
      attributeName: 'sort_order',
      value: u.sortOrder,
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

/**
 * Framework-agnostic Kanban board helpers — lifted from the Svelte client's
 * `client/src/screens/kanban_helpers.ts` and re-expressed against the `web/`
 * card model (ids as `bigint`, attributes as a plain record). NOTHING here
 * imports from `client/` or touches the DOM / signals — these are pure
 * functions exercised directly by `node --test`.
 *
 * Surface (parity with the Svelte helpers):
 *   - {@link bucketByKey}         group cards by a caller-supplied per-card key
 *                                 (scalar axis value or tag-prefix tag id);
 *                                 unset lands in the `UNSET_KEY` bucket.
 *   - {@link planSortRewrite}     the minimal `sort_order` writes that place a
 *                                 moved card into a destination cell, rewriting
 *                                 the whole cell to canonical `(i+1)*STEP`
 *                                 spacing (the "rewrite the destination"
 *                                 strategy — avoids halfway-math no-ops).
 *   - {@link computeMoveBatch}    the `attribute.update` ops for one drop
 *                                 (sort writes + the column-attr change),
 *                                 omitting unchanged values.
 *   - {@link sortByOrder}         stable `sort_order` ASC, id tie-break.
 *   - {@link columnOrder}         the canonical column key order = the axis
 *                                 value-card ids, then extra keys seen on
 *                                 tasks, then a trailing `UNSET_KEY`.
 */

/* -------------------------------------------------------------------------- */
/* Card model (the `web/` shape — bigint ids, attribute record).              */
/* -------------------------------------------------------------------------- */

/** A task card with its decoded attributes (bigint ids already revived). */
export interface CardWithAttrs {
  id: bigint;
  card_type_id: bigint;
  card_type_name: string;
  parent_card_id?: bigint;
  phase?: 'triage' | 'active' | 'terminal';
  attributes: Record<string, unknown>;
  /**
   * The signed-in user's personal sort order for this card — a TOP-LEVEL wire
   * field (NOT an attribute), populated only when the request set
   * `with_personal_sort: true`. `card_select_with_attributes_batch.sql` joins
   * `user_card_sort` and emits `ucs.sort_order AS personal_sort_order` (NULL
   * for rows the user has not personally ordered). The Inbox reads it to order
   * the list and to rewrite it on a drag/keyboard reorder.
   */
  personal_sort_order?: number;
  /** Row-level audit timestamps (ISO-8601), top-level wire fields — the server
   *  sets them from `card.created_at` / `card.last_activity_at`. The Grid's
   *  Created / Last-activity columns read these. */
  created_at?: string;
  last_activity_at?: string;
}

/** Sentinel column key for cards whose grouping attribute is unset. */
export const UNSET_KEY = '__unset__';

/** Sort-order spacing — mirrors `SORT_ORDER_STEP` from the Svelte side. */
export const SORT_ORDER_STEP = 100;

/* -------------------------------------------------------------------------- */
/* Bucket key.                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Map an attribute value to a string bucket key. `null` / `undefined`
 * collapse to {@link UNSET_KEY}. bigint / number / boolean stringify; strings
 * pass through. Using a canonical string form (rather than `===` on a bigint)
 * sidesteps the boot-ordering bigint-revival pitfall the Svelte client hit
 * (see `client/src/reg/types.ts` `sameId`): `42`, `42n`, and `"42"` all key to
 * `"42"`.
 */
export function bucketKeyOf(v: unknown): string {
  if (v === null || v === undefined) return UNSET_KEY;
  if (typeof v === 'string') return v === '' ? UNSET_KEY : v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return String(v);
}

/**
 * Coerce a wire-side card_ref attribute value (the value at
 * `card.attributes[attr]` for a card_ref-typed attr_def) to a positive bigint,
 * or null when absent / malformed. The dispatcher's id-revival is hand-keyed
 * by attribute name (see `core/dispatch.ts` CARD_REF_ATTR_KEYS) so an
 * un-primed card_ref attr (e.g. `originator`) arrives as a digit-string.
 *
 * EVERY consumer that reads a card_ref attribute — the Grid's ref-cell
 * renderer + group-label resolver, the Inbox's group-label resolver, the
 * TaskDetail panel — funnels through this helper so a new card_ref attr
 * "just works" without each call site needing its own bigint-typeof gate or
 * a one-off addition to the dispatcher registry.
 */
export function asAttrId(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v > 0n ? v : null;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      const n = BigInt(v);
      return n > 0n ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* bucketByKey.                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Bucket [cards] by a per-card KEY function. The board's only bucketer: the
 * caller supplies `keyOf` — the scalar value of an axis attribute for an
 * ordinary axis (`c => bucketKeyOf(c.attributes[attr])`), or the id of the
 * single tag a card carries under an exclusive root for a tag-prefix axis.
 * Cards with no value land in {@link UNSET_KEY} (the caller's keyOf returns it).
 * Keeps first-seen key order; a card maps to exactly ONE bucket (no fan-out —
 * an axis whose value is multi-valued is modelled as a tag-prefix axis, which
 * is single-valued by exclusivity).
 */
export function bucketByKey(
  cards: readonly CardWithAttrs[],
  keyOf: (card: CardWithAttrs) => string,
): Record<string, CardWithAttrs[]> {
  const out: Record<string, CardWithAttrs[]> = {};
  for (const c of cards) {
    const k = keyOf(c);
    const bucket = out[k];
    if (bucket === undefined) out[k] = [c];
    else bucket.push(c);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* columnOrder.                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Canonical column key order for the board:
 *   1. every value-card id of the grouping attribute (so an empty project
 *      still shows every known column), in their given order;
 *   2. any extra keys actually present on tasks but not in the value cards;
 *   3. a trailing {@link UNSET_KEY} bucket — always last, always present.
 *
 * [valueCardIds] are the ids of the axis's value cards (e.g. milestone card
 * ids); [seenKeys] are the bucket keys observed on the loaded tasks.
 */
export function columnOrder(
  valueCardIds: readonly bigint[],
  seenKeys: readonly string[],
): string[] {
  const out: string[] = [];
  const seenSet = new Set<string>();
  for (const id of valueCardIds) {
    const k = id.toString();
    if (!seenSet.has(k)) {
      seenSet.add(k);
      out.push(k);
    }
  }
  for (const k of seenKeys) {
    if (k === UNSET_KEY) continue;
    if (!seenSet.has(k)) {
      seenSet.add(k);
      out.push(k);
    }
  }
  out.push(UNSET_KEY);
  return out;
}

/* -------------------------------------------------------------------------- */
/* planSortRewrite.                                                            */
/* -------------------------------------------------------------------------- */

/** Pull `sort_order` off a card; non-numeric → undefined. */
function sortOrderOf(c: CardWithAttrs): number | undefined {
  const v = c.attributes['sort_order'];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/** One pending `sort_order` write produced by {@link planSortRewrite}. */
export interface SortUpdate {
  cardId: bigint;
  sortOrder: number;
}

/**
 * Build the minimal list of `(cardId, sortOrder)` writes that places
 * [movedCard] into slot [slot] of [destStack] and leaves the rest of the
 * destination cell in canonical `(i+1) * STEP` spacing.
 *
 * [destStack] is the cell's current display order with [movedCard] already
 * excluded (so the moved card may come from another cell — the cross-column
 * case). [slot] sits BEFORE the slot-th remaining card; `slot ===
 * destStack.length` means "drop at the bottom".
 *
 * We rewrite the whole cell rather than halfway-between math because halfway
 * math silently no-op'd against NULL siblings and converged/collided on
 * repeated drops (see the Svelte helper's doc comment). Only cards whose
 * existing `sort_order` already equals the desired slot value are omitted.
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
/* computeMoveBatch.                                                           */
/* -------------------------------------------------------------------------- */

/** One `attribute.update` op (card + attribute name + value). */
export interface UpdateOp {
  cardId: bigint;
  attributeName: string;
  value: unknown;
}

/**
 * Build the array of `attribute.update` ops for one drag-drop. ONE batch
 * combines:
 *   1. one `sort_order` op per entry in [sortUpdates] (already filtered by
 *      {@link planSortRewrite} to omit unchanged cards);
 *   2. the new column-attribute value, when the destination key differs from
 *      the moved card's current key.
 *
 * [targetColumnAttrValue] is the destination column's underlying value — a
 * `bigint` value-card id, or `null` for the {@link UNSET_KEY} column. Updates
 * whose value did not change are OMITTED, so a same-column reorder emits only
 * sort writes and a no-op drop emits nothing. The dispatcher coalesces these
 * into ONE `POST /api/v1/batch` when issued in the same tick.
 *
 * (The Svelte helper also threaded a lane axis; v1 of the web slice has no
 * swim lanes, so the lane arm is intentionally omitted — see kanban.ts TODO.)
 */
export function computeMoveBatch(
  card: CardWithAttrs,
  targetColumnAttrValue: bigint | null,
  sortUpdates: readonly SortUpdate[],
  columnAttrName: string,
): UpdateOp[] {
  const ops: UpdateOp[] = [];

  for (const u of sortUpdates) {
    ops.push({ cardId: u.cardId, attributeName: 'sort_order', value: u.sortOrder });
  }

  const currentColKey = bucketKeyOf(card.attributes[columnAttrName]);
  const targetColKey = targetColumnAttrValue === null ? UNSET_KEY : targetColumnAttrValue.toString();
  if (currentColKey !== targetColKey) {
    ops.push({
      cardId: card.id,
      attributeName: columnAttrName,
      // null clears the attribute (server treats JSON null as "remove").
      value: targetColumnAttrValue,
    });
  }

  return ops;
}

/* -------------------------------------------------------------------------- */
/* sortByOrder + clamp.                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Sort [cards] in place by `sort_order` ASC with `id` as the tie-breaker
 * (nulls last). Returns the same array for chaining.
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

/** Clamp `currentIdx + dir` into `[0, columnsLen-1]`. */
export function nextColumnIndex(currentIdx: number, columnsLen: number, dir: number): number {
  if (columnsLen <= 0) return 0;
  const next = currentIdx + dir;
  if (next < 0) return 0;
  if (next > columnsLen - 1) return columnsLen - 1;
  return next;
}

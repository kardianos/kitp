/**
 * Framework-agnostic Project-detail helpers — pure functions exercised directly
 * by `node --test`. NOTHING here touches the DOM or signals.
 *
 * {@link matchesLeaves} is the CLIENT-SIDE fallback narrow the ProjectLayout
 * applies only when the active predicate is a structured tree (OR / NOT /
 * nesting) it didn't push to the server `where[]`. The common case (search +
 * the quick-chips / Advanced flat-AND) is pushed server-side; this just keeps a
 * structured filter from showing un-narrowed rows. It is intentionally a small
 * subset of the server's `card_compile_predicate.sql` op set — the ops the
 * flattened leaves carry (`=`, `!=`, `contains`, `in`).
 */

import type { CardWithAttrs } from '../kanban/kanban-helpers.js';

/** One flattened `where` leaf (the shape `toWhereLeaves` produces). */
export interface WhereLeaf {
  attr?: string;
  op?: string;
  value?: unknown;
  values?: unknown[];
}

/** Canonicalise a value to a comparable string (bigint/number/bool/string). */
function asKey(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return String(v);
}

/** Does a single leaf match a card's attribute value? Unknown ops pass (so an
 *  op we don't model never hides a row — the server is authoritative). */
export function matchesLeaf(card: CardWithAttrs, leaf: WhereLeaf): boolean {
  const attr = leaf.attr;
  if (attr === undefined) return true;
  const cur = card.attributes[attr];
  const op = leaf.op ?? '=';
  switch (op) {
    case '=':
    case 'eq':
      return asKey(cur) === asKey(leaf.value);
    case '!=':
    case 'ne':
      return asKey(cur) !== asKey(leaf.value);
    case 'contains': {
      const hay = asKey(cur).toLowerCase();
      const needle = asKey(leaf.value).toLowerCase();
      return needle.length === 0 || hay.includes(needle);
    }
    case 'in': {
      const set = new Set((leaf.values ?? []).map(asKey));
      if (Array.isArray(cur)) return cur.some((v) => set.has(asKey(v)));
      return set.has(asKey(cur));
    }
    default:
      return true;
  }
}

/** Match a card against ALL leaves (AND). Empty list → matches everything. */
export function matchesLeaves(card: CardWithAttrs, leaves: readonly WhereLeaf[]): boolean {
  return leaves.every((l) => matchesLeaf(card, l));
}

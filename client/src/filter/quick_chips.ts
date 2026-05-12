/**
 * Shared predicate helpers for filter mutations.
 *
 * Historically this file owned the "quick-chip" pre-defined leaf set that
 * the FilterBar rendered as one-click buttons. That UI was replaced by
 * the per-attribute dropdowns in {@link QuickFilterDropdown}, so the
 * chip generators and active-chip detector are gone; only the leaf-
 * replacement utility survives because the Grid's per-column filter
 * still relies on it to mutate the active predicate one attribute at a
 * time.
 */

import type { Predicate, PredicateLeaf } from './predicate';

/**
 * Replace the leaf for [newLeaf]'s attribute inside [predicate], or
 * append it. Caller MUST ensure [predicate] is null or a flat-AND of
 * leaves (`isFlatAndOfLeaves`); throws otherwise.
 */
export function replaceLeafForAttr(
  predicate: Predicate | null,
  newLeaf: Predicate,
): Predicate {
  if (newLeaf.kind !== 'leaf') {
    throw new Error('replaceLeafForAttr: newLeaf must be a leaf');
  }
  const existing = collectLeaves(predicate);
  const filtered: PredicateLeaf[] = existing.filter(
    (l) => l.attr !== newLeaf.attr,
  );
  filtered.push(newLeaf);
  if (filtered.length === 1) {
    return filtered[0] as PredicateLeaf;
  }
  return { kind: 'group', connective: 'and', children: filtered };
}

/** Walk a flat-AND predicate (or null) and return all leaves. */
function collectLeaves(predicate: Predicate | null): PredicateLeaf[] {
  if (predicate === null) return [];
  if (predicate.kind === 'leaf') return [predicate];
  if (predicate.connective !== 'and') {
    throw new Error('replaceLeafForAttr: predicate must be a flat AND of leaves');
  }
  const out: PredicateLeaf[] = [];
  for (const c of predicate.children) {
    if (c.kind !== 'leaf') {
      throw new Error('replaceLeafForAttr: predicate must be a flat AND of leaves');
    }
    out.push(c);
  }
  return out;
}

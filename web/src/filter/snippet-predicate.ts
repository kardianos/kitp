/**
 * Snippet-predicate helpers — the shape + snippet-id-keyed top-level operations
 * for "saved filter" (`predicate_snippet`) leaves on a shared {@link Predicate}
 * tree. Picking a saved filter toggles one top-level leaf carrying the snippet's
 * card id (`{ op:'snippet', values:[id] }` on the wire); the rest of the tree is
 * untouched, so a snippet AND-s alongside quick-chip and Advanced leaves, keyed
 * by snippet id (one leaf per snippet) so toggling the same one twice is
 * idempotent.
 *
 * The CLIENT NEVER expands a snippet: the leaf round-trips as the card id and the
 * server's `card_compile_predicate.sql` dispatches on `op='snippet'`, fetches the
 * referenced card's `predicate`, recurses, and cycle-guards. Expansion + cycle
 * detection live server-side; this module only builds/reads/replaces the leaves.
 *
 * These helpers back QuickChips's "Saved" filter section (which owns the snippet
 * card load + the on-bar snippet chips); the former standalone NamedFilters
 * control is merged into that menu.
 */

import { type Predicate, type PredicateLeaf } from './predicate.js';

/* -------------------------------------------------------------------------- */
/* Snippet leaf shape + snippet-id-keyed top-level helpers.                    */
/* -------------------------------------------------------------------------- */

/**
 * Sentinel `attr` carried by a snippet leaf. The SQL compiler's snippet branch
 * reads only `op` + `values[0]`, never `attr`, but `toWire` always emits an
 * `attr` for a leaf — so we carry this stable sentinel (matching the Svelte
 * client's `SNIPPET_ATTR`). It lets the editor's attribute combobox tell a
 * snippet leaf apart, and it never collides with a real task attribute name.
 */
export const SNIPPET_ATTR = '_snippet';

/**
 * Build a top-level snippet leaf for [snippetId]. The wire shape (via
 * {@link toWire}) is `{ attr:'_snippet', op:'snippet', values:[<id-as-string>] }`
 * — exactly what `card_compile_predicate.sql` dispatches on (it reads `op` +
 * `values[0]`). The id is stringified so it round-trips through JSON / the
 * card_ref-string wire convention the rest of the predicate layer uses (the SQL
 * compiler accepts a numeric string id).
 */
export function snippetLeaf(snippetId: bigint): PredicateLeaf {
  return { kind: 'leaf', attr: SNIPPET_ATTR, op: 'snippet', values: [snippetId.toString()] };
}

/** True when [p] is a leaf carrying a snippet reference. */
function isSnippetLeaf(p: Predicate): p is PredicateLeaf {
  return p.kind === 'leaf' && p.op === 'snippet';
}

/** The snippet id a snippet leaf references (string form, for set membership). */
function snippetIdOf(leaf: PredicateLeaf): string | null {
  const v = leaf.values?.[0];
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * The stringified snippet ids referenced by TOP-LEVEL snippet leaves in [p] (a
 * bare snippet leaf, or direct snippet-leaf children of a root AND). Snippet
 * leaves buried inside an OR / NOT subtree are NOT reflected — those are the
 * Advanced editor's domain, not the top-bar multi-select's. The same projection
 * the trigger label + the checkbox list use.
 */
export function selectedSnippetIds(p: Predicate | null): string[] {
  if (p === null) return [];
  if (p.kind === 'leaf') {
    if (!isSnippetLeaf(p)) return [];
    const id = snippetIdOf(p);
    return id === null ? [] : [id];
  }
  if (p.connective !== 'and') return [];
  const out: string[] = [];
  for (const c of p.children) {
    if (c.kind === 'leaf' && isSnippetLeaf(c)) {
      const id = snippetIdOf(c);
      if (id !== null) out.push(id);
    }
  }
  return out;
}

/** A normalised view of the root: its direct children as a flat AND. */
function rootChildren(p: Predicate | null): Predicate[] {
  if (p === null) return [];
  if (p.kind === 'leaf') return [p];
  if (p.connective === 'and') return p.children.slice();
  // A top-level OR / NOT — keep it as a single child so snippet leaves AND
  // alongside the whole tree (mirrors the quick-chips rootView posture).
  return [p];
}

/** Re-assemble flat-AND children into a {@link Predicate} (or null when empty). */
function fromRootChildren(children: Predicate[]): Predicate | null {
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: 'group', connective: 'and', children };
}

/**
 * Replace the TOP-LEVEL snippet leaves of [p] with exactly one leaf per id in
 * [ids]. Non-snippet top-level leaves, the search leaf, and any nested groups
 * the Advanced editor built are preserved verbatim; a non-AND root (OR / NOT)
 * is kept as a single child so the new snippet leaves AND alongside it.
 *
 *   - no leaves left → null
 *   - exactly one    → that bare leaf (no needless AND wrapper)
 *   - two or more    → a flat AND group
 *
 * Toggling the same id twice is idempotent (the old leaf is dropped first, then
 * re-added only if still in [ids]). This is the snippet-id analogue of
 * {@link upsertTopLevelLeaf} / {@link removeTopLevelLeaf}, keyed by snippet id
 * rather than attr (every snippet leaf shares the `_snippet` attr).
 */
export function setSelectedSnippets(p: Predicate | null, ids: bigint[]): Predicate | null {
  // Drop every existing top-level snippet leaf; keep the rest of the tree.
  const kept: Predicate[] = rootChildren(p).filter(
    (c) => !(c.kind === 'leaf' && c.op === 'snippet'),
  );
  for (const id of ids) kept.push(snippetLeaf(id));
  return fromRootChildren(kept);
}

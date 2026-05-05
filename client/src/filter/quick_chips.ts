/**
 * Quick-chip generation for the FilterBar.
 *
 * A "quick chip" is a one-click pre-defined filter the user can drop on
 * top of an existing predicate. Clicking a chip injects (or replaces) a
 * single leaf in the active flat-AND predicate.
 *
 * The generators here return a default set per attribute shape, derived
 * from the migration plan §5.9:
 *   - enum  → one chip per enum option (`<attr> = <option-value>`)
 *   - assignee → "Mine" (`assignee = currentUserId`)
 *   - date  → "Today", "Overdue", "This week" (best-effort with the
 *             current MVP op set; see TODOs)
 *   - ref:* → no auto-chips; callers supply their own
 *   - everything else → []
 *
 * Callers are free to ignore this and pass `quickChips` straight into
 * `<FilterBar>` themselves.
 */

import type { FilterAttribute } from './attribute_schema.svelte.js';
import {
  eq,
  exists,
  type Predicate,
  type PredicateLeaf,
} from './predicate.js';

/** A pre-defined filter the user can apply with one click. */
export interface QuickChip {
  /** Stable id (used as the {#each} key and to highlight active chips). */
  id: string;
  /** User-visible label rendered on the chip. */
  label: string;
  /**
   * Predicate emitted when the chip is clicked. For MVP this is always
   * a single leaf — `FilterBar` replaces any existing leaf for the same
   * attribute when injecting it.
   */
  predicate: Predicate;
}

/** ISO yyyy-mm-dd for [d] in the local timezone. */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Build the default quick-chip set for [attribute].
 *
 * For enum attrs we emit one chip per option, encoded as `<attr> = <value>`.
 * For the well-known `assignee` attr we emit a "Mine" chip when
 * [currentUserId] is supplied.
 * For date attrs we emit Today / This week / Overdue — note the date-range
 * encoding is approximate today (the predicate AST does not yet model
 * range ops); these chips emit a best-effort leaf and screens that need
 * exact semantics should override.
 *
 * Returns `[]` for `ref:*`, `text`, `number`, `bool`, and unknown types.
 */
export function defaultQuickChipsFor(
  attribute: FilterAttribute,
  currentUserId?: number,
): QuickChip[] {
  // Assignee → "Mine".
  if (attribute.name === 'assignee' && currentUserId !== undefined) {
    return [
      {
        id: `${attribute.name}:mine`,
        label: 'Mine',
        predicate: eq('assignee', currentUserId),
      },
    ];
  }

  // Enum → one chip per option.
  if (attribute.valueType === 'enum') {
    const opts = attribute.options ?? [];
    return opts.map((o) => ({
      id: `${attribute.name}:${String(o.value)}`,
      label: o.label,
      predicate: eq(attribute.name, o.value),
    }));
  }

  // Date → Today / This week / Overdue.
  // TODO: the predicate AST currently only supports eq/ne/in/notIn/exists.
  // "This week" and "Overdue" really want a date range; we approximate
  // here with the closest leaf shape the engine accepts and let screens
  // override when they need exact semantics.
  if (attribute.valueType === 'date') {
    const today = isoDate(new Date());
    return [
      {
        id: `${attribute.name}:today`,
        label: 'Today',
        predicate: eq(attribute.name, today),
      },
      {
        // TODO: encode as a range once the predicate engine supports it.
        // For MVP we surface "This week" only as a placeholder; the leaf
        // emitted is `<attr> exists` so the user at least sees a useful
        // filter (anything with the date set).
        id: `${attribute.name}:this-week`,
        label: 'This week',
        predicate: exists(attribute.name),
      },
      {
        // TODO: real "overdue" needs `<` which the AST does not model yet.
        // For MVP "Overdue" emits `<attr> exists` as a placeholder.
        id: `${attribute.name}:overdue`,
        label: 'Overdue',
        predicate: exists(attribute.name),
      },
    ];
  }

  // ref:* / text / number / bool / unknown → no defaults.
  return [];
}

/* -------------------------------------------------------------------------- */
/* Internal helpers (exported for unit tests)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Replace the leaf for [newLeaf]'s attribute inside [predicate], or
 * append it. Caller MUST ensure [predicate] is null or a flat-AND of
 * leaves (`isFlatAndOfLeaves`); throws otherwise.
 *
 * Used by `FilterBar` when the user clicks a quick chip — quick-chip
 * semantics from §5.9 of the plan: "replacing any existing leaf for the
 * same attribute".
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
    // Non-null because of the length check.
    return filtered[0] as PredicateLeaf;
  }
  return { kind: 'group', connective: 'and', children: filtered };
}

/**
 * `true` when [predicate] already contains a leaf with `attr === attr`
 * AND `op === 'eq'` AND `values[0] === value`. Used by `FilterBar` to
 * highlight active quick chips.
 */
export function quickChipIsActive(
  predicate: Predicate | null,
  chip: QuickChip,
): boolean {
  if (chip.predicate.kind !== 'leaf') return false;
  const target: PredicateLeaf = chip.predicate;
  let leaves: PredicateLeaf[];
  try {
    leaves = collectLeaves(predicate);
  } catch {
    // Predicate is not a flat-AND; quick chips can't be active in that case.
    return false;
  }
  for (const l of leaves) {
    if (l.attr !== target.attr) continue;
    if (l.op !== target.op) continue;
    const a = l.values ?? [];
    const b = target.values ?? [];
    if (a.length !== b.length) continue;
    let same = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
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

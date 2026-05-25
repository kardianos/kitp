/**
 * Activity-sink filter DSL — the `web/` mirror of the server-side `Predicate`
 * (`server/internal/dom/activitysink/predicate.go`) and the Svelte client's
 * `client/src/screens/admin/activity_predicate.ts`.
 *
 * Activity-sink filters apply to SINGLE activity rows (kind / attribute_name /
 * actor_id), NOT to the arbitrary attribute leaves the screen-filter
 * {@link import('../filter/predicate.js').Predicate} addresses — so this is a
 * deliberately separate, smaller DSL. The server keeps its own evaluator; this
 * is never compiled to SQL.
 *
 * Shape:
 *   - Composite: { kind:'composite', op:'and'|'or', items: ActivityPredicate[] }
 *   - Leaf:      { kind:'leaf', op:<leaf-op>, values: string[] }
 *   - Empty:     null / {} / { op:'' } → matches every row.
 *
 * Unknown ops fail closed server-side, so a typo cannot silently flood a
 * channel — keep this op list in sync with the Go switch.
 */

export const ACTIVITY_COMPOSITE_OPS = ['and', 'or'] as const;
export type ActivityCompositeOp = (typeof ACTIVITY_COMPOSITE_OPS)[number];

export const ACTIVITY_LEAF_OPS = [
  'kind_in',
  'kind_not_in',
  'attr_in',
  'attr_not_in',
  'actor_in',
  'actor_not_in',
] as const;
export type ActivityLeafOp = (typeof ACTIVITY_LEAF_OPS)[number];

export interface ActivityPredicateComposite {
  kind: 'composite';
  op: ActivityCompositeOp;
  items: ActivityPredicate[];
}
export interface ActivityPredicateLeaf {
  kind: 'leaf';
  op: ActivityLeafOp;
  values: string[];
}
export type ActivityPredicate = ActivityPredicateComposite | ActivityPredicateLeaf;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isCompositeOp(op: unknown): op is ActivityCompositeOp {
  return op === 'and' || op === 'or';
}
function isLeafOp(op: unknown): op is ActivityLeafOp {
  return (
    op === 'kind_in' ||
    op === 'kind_not_in' ||
    op === 'attr_in' ||
    op === 'attr_not_in' ||
    op === 'actor_in' ||
    op === 'actor_not_in'
  );
}

/**
 * Decode a JSON value into an {@link ActivityPredicate}. Returns `null` for the
 * empty / match-everything predicate (`null`, `{}`, `{op:''}`). Returns `null`
 * (rather than throwing) on a malformed shape so a corrupt attribute never
 * crashes the admin editor — the worst case is "match everything" until re-saved.
 */
export function activityPredicateFromJson(raw: unknown): ActivityPredicate | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) return null;
  const op = raw['op'];
  if (op === undefined || op === '' || op === null) return null;
  if (isCompositeOp(op)) {
    const itemsRaw = raw['items'];
    const items: ActivityPredicate[] = [];
    if (Array.isArray(itemsRaw)) {
      for (const child of itemsRaw) {
        const parsed = activityPredicateFromJson(child);
        if (parsed !== null) items.push(parsed);
      }
    }
    return { kind: 'composite', op, items };
  }
  if (isLeafOp(op)) {
    const valuesRaw = raw['values'];
    const values: string[] = [];
    if (Array.isArray(valuesRaw)) {
      for (const v of valuesRaw) {
        if (typeof v === 'string') values.push(v);
        else if (typeof v === 'number') values.push(String(v));
      }
    }
    return { kind: 'leaf', op, values };
  }
  return null;
}

/** Parse a JSON string. Empty / whitespace → `null` (match every row). */
export function activityPredicateFromString(raw: string): ActivityPredicate | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return activityPredicateFromJson(parsed);
}

/** Encode a predicate to its wire JSON shape (composite emits `items`, leaf
 *  emits `values`). `null` → `null`. */
export function activityPredicateToJson(p: ActivityPredicate | null): unknown {
  if (p === null) return null;
  if (p.kind === 'composite') {
    return { op: p.op, items: p.items.map(activityPredicateToJson) };
  }
  return { op: p.op, values: p.values.slice() };
}

/** Encode for storage in the `activity_filter` attribute. `null` → '' so the
 *  round-trip matches the "missing-or-blank → match everything" convention. */
export function activityPredicateToString(p: ActivityPredicate | null): string {
  if (p === null) return '';
  return JSON.stringify(activityPredicateToJson(p));
}

/** Friendly label for the operator selector. */
export function activityOpLabel(op: ActivityLeafOp | ActivityCompositeOp): string {
  switch (op) {
    case 'and':
      return 'AND';
    case 'or':
      return 'OR';
    case 'kind_in':
      return 'kind in';
    case 'kind_not_in':
      return 'kind not in';
    case 'attr_in':
      return 'attribute in';
    case 'attr_not_in':
      return 'attribute not in';
    case 'actor_in':
      return 'actor in';
    case 'actor_not_in':
      return 'actor not in';
  }
}

/** Human-readable summary. Empty / null → "Push every activity row". */
export function summarizeActivityPredicate(p: ActivityPredicate | null): string {
  if (p === null) return 'Push every activity row';
  if (p.kind === 'leaf') return summarizeLeaf(p);
  if (p.items.length === 0) {
    return p.op === 'and' ? 'Push every activity row' : 'Push nothing';
  }
  if (p.items.length === 1) {
    const only = p.items[0];
    if (only === undefined) return '—';
    return summarizeActivityPredicate(only);
  }
  const joiner = p.op === 'and' ? ' AND ' : ' OR ';
  return p.items.map((c) => `(${summarizeActivityPredicate(c)})`).join(joiner);
}

function summarizeLeaf(p: ActivityPredicateLeaf): string {
  const op = activityOpLabel(p.op);
  if (p.values.length === 0) return `${op} (none)`;
  return `${op} (${p.values.join(', ')})`;
}

/**
 * Append a leaf to (or create) the top-level AND group. Pure: returns a NEW
 * predicate. Used by the activity-filter editor's "+ Add leaf".
 */
export function appendLeaf(p: ActivityPredicate | null, leaf: ActivityPredicateLeaf): ActivityPredicate {
  if (p === null) return { kind: 'composite', op: 'and', items: [leaf] };
  if (p.kind === 'leaf') return { kind: 'composite', op: 'and', items: [p, leaf] };
  return { kind: 'composite', op: p.op, items: [...p.items, leaf] };
}

/** Remove the leaf at top-level index `i`. `null` when the result is empty. */
export function removeLeafAt(p: ActivityPredicate | null, i: number): ActivityPredicate | null {
  if (p === null || p.kind === 'leaf') return null;
  const items = p.items.filter((_, idx) => idx !== i);
  if (items.length === 0) return null;
  return { kind: 'composite', op: p.op, items };
}

/** Set the top-level connective (and / or). No-op for a leaf-only predicate. */
export function setConnective(p: ActivityPredicate | null, op: ActivityCompositeOp): ActivityPredicate | null {
  if (p === null) return null;
  if (p.kind === 'leaf') return { kind: 'composite', op, items: [p] };
  return { kind: 'composite', op, items: p.items };
}

/** Flatten a predicate's TOP-LEVEL leaves for the editor's row list. Nested
 *  composites (rare for sink filters) render as a single "(group)" summary row. */
export function topLevelLeaves(p: ActivityPredicate | null): Array<{ leaf: ActivityPredicateLeaf | null; summary: string }> {
  if (p === null) return [];
  if (p.kind === 'leaf') return [{ leaf: p, summary: summarizeLeaf(p) }];
  return p.items.map((it) =>
    it.kind === 'leaf'
      ? { leaf: it, summary: summarizeLeaf(it) }
      : { leaf: null, summary: `(${summarizeActivityPredicate(it)})` },
  );
}

/** The closed set of activity kinds the server emits (mirrors the Svelte list). */
export const ACTIVITY_KIND_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'card_create', label: 'Card created' },
  { value: 'attr_update', label: 'Attribute updated' },
  { value: 'comment', label: 'Comment' },
  { value: 'tag_apply', label: 'Tag applied' },
  { value: 'tag_remove', label: 'Tag removed' },
  { value: 'card_delete', label: 'Card deleted' },
];

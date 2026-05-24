/**
 * Activity-sink filter DSL — client-side mirror of the server-side
 * `Predicate` defined in `server/internal/dom/activitysink/predicate.go`.
 *
 * Used by the visual builder under the admin · activity-sinks screen.
 *
 * The DSL intentionally differs from the screen-filter `Predicate`
 * (`client/src/filter/predicate.ts`): activity-sink filters apply to
 * single activity rows (kind / attribute_name / actor_id), not to
 * arbitrary attribute leaves. The server keeps its own evaluator and
 * never compiles this to SQL.
 *
 * Shape:
 *   - Composite: { op: 'and' | 'or', items: ActivityPredicate[] }
 *   - Leaf:      { op: 'kind_in' | 'kind_not_in'
 *                    | 'attr_in' | 'attr_not_in'
 *                    | 'actor_in' | 'actor_not_in', values: string[] }
 *   - Empty:     {} or { op: '' } → matches every row.
 *
 * Unknown ops fail closed server-side so a typo cannot silently flood a
 * channel — keep this list in sync with the Go switch.
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

export type ActivityPredicateComposite = {
  kind: 'composite';
  op: ActivityCompositeOp;
  items: ActivityPredicate[];
};

export type ActivityPredicateLeaf = {
  kind: 'leaf';
  op: ActivityLeafOp;
  values: string[];
};

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
 * Decode a JSON value into an {@link ActivityPredicate}. Returns `null`
 * when the input represents the empty / match-everything predicate
 * (`null`, `{}`, `{op:''}` or the empty string).
 *
 * Throws on unknown ops / malformed shapes so a corrupted attribute
 * surfaces as a toast rather than silently mis-filtering.
 */
export function activityPredicateFromJson(raw: unknown): ActivityPredicate | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) {
    throw new Error('activity predicate must be a JSON object');
  }
  const op = raw.op;
  if (op === undefined || op === '' || op === null) {
    return null;
  }
  if (isCompositeOp(op)) {
    const itemsRaw = raw.items;
    const items: ActivityPredicate[] = [];
    if (itemsRaw !== undefined && itemsRaw !== null) {
      if (!Array.isArray(itemsRaw)) {
        throw new Error('activity predicate composite items must be an array');
      }
      for (const child of itemsRaw) {
        const parsed = activityPredicateFromJson(child);
        if (parsed !== null) items.push(parsed);
      }
    }
    return { kind: 'composite', op, items };
  }
  if (isLeafOp(op)) {
    const valuesRaw = raw.values;
    const values: string[] = [];
    if (valuesRaw !== undefined && valuesRaw !== null) {
      if (!Array.isArray(valuesRaw)) {
        throw new Error('activity predicate leaf values must be an array');
      }
      for (const v of valuesRaw) {
        if (typeof v === 'string') values.push(v);
        else if (typeof v === 'number') values.push(String(v));
        else throw new Error('activity predicate leaf values must be strings');
      }
    }
    return { kind: 'leaf', op, values };
  }
  throw new Error(`unknown activity predicate op: ${JSON.stringify(op)}`);
}

/**
 * Parse a JSON string into an {@link ActivityPredicate}. Empty /
 * whitespace input yields `null` (match every row), matching the
 * server's tolerant parser.
 */
export function activityPredicateFromString(raw: string): ActivityPredicate | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return activityPredicateFromJson(JSON.parse(trimmed));
}

/**
 * Encode a predicate to its wire JSON shape. A `null` input yields
 * `null` (callers should typically send the empty string `""` instead
 * of `null` over the wire — see {@link activityPredicateToString}).
 *
 * Composite nodes always emit `items` (possibly empty); leaves always
 * emit `values` (possibly empty). The server tolerates both.
 */
export function activityPredicateToJson(p: ActivityPredicate | null): unknown {
  if (p === null) return null;
  if (p.kind === 'composite') {
    return { op: p.op, items: p.items.map(activityPredicateToJson) };
  }
  return { op: p.op, values: p.values.slice() };
}

/**
 * Encode for storage in the `activity_filter` attribute. Returns the
 * empty string for `null` so the round-trip matches the
 * "missing-or-blank → match everything" convention the pump uses.
 */
export function activityPredicateToString(p: ActivityPredicate | null): string {
  if (p === null) return '';
  return JSON.stringify(activityPredicateToJson(p));
}

/** Friendly label for the operator combobox in the visual builder. */
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

/** Value-type a leaf operator carries — drives the value-picker. */
export type ActivityLeafValueKind = 'kind' | 'attr' | 'actor';

export function activityLeafValueKind(op: ActivityLeafOp): ActivityLeafValueKind {
  switch (op) {
    case 'kind_in':
    case 'kind_not_in':
      return 'kind';
    case 'attr_in':
    case 'attr_not_in':
      return 'attr';
    case 'actor_in':
    case 'actor_not_in':
      return 'actor';
  }
}

/**
 * Closed set of activity kinds the server emits. Mirrors
 * `KIND_OPTIONS` in `ActivityScreen.svelte` and the per-domain `Kind:`
 * constants in `server/internal/dom/`. Kept in this file so the
 * builder's combobox and the activity screen's filter share the same
 * canonical list.
 */
export const ACTIVITY_KIND_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'card_create', label: 'Card created' },
  { value: 'attr_update', label: 'Attribute updated' },
  { value: 'comment', label: 'Comment' },
  { value: 'tag_apply', label: 'Tag applied' },
  { value: 'tag_remove', label: 'Tag removed' },
  { value: 'card_delete', label: 'Card deleted' },
] as const;

/**
 * Human-readable summary of [p]. Used both as the empty-state caption
 * in the admin row and as the modal subtitle. Empty / null predicates
 * render as "Push every activity row".
 */
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

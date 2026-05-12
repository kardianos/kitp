/**
 * Predicate AST shared by the quick-filter bar and the advanced tree
 * editor. JSON-round-trippable so it can flow into URLs / saved views and
 * across the wire to `card.select_with_attributes` (`tree:` field).
 *
 * A `Predicate` is either:
 *   - `PredicateLeaf`: `<attr> <op> <value(s)>`
 *   - `PredicateGroup`: `(child1) AND (child2)` (or OR / NOT)
 *
 * NOT groups must have exactly one child; the constructor helpers and
 * {@link predicateFromJson} both enforce that invariant. Empty AND groups
 * are vacuously true; empty OR groups are vacuously false (server agrees).
 *
 * Ports `client/lib/ui/filter/predicate.dart`. The Dart sealed class becomes
 * a discriminated union here (`kind: 'leaf' | 'group'`); naming kept 1:1
 * (`in_` retains its trailing underscore for symmetry across the codebase
 * and because `in` is a JS reserved word).
 */

/* -------------------------------------------------------------------------- */
/* Operators                                                                  */
/* -------------------------------------------------------------------------- */

/** Operators understood by every layer (UI → wire → server SQL). */
export type Op =
  | 'eq'
  | 'ne'
  | 'in'
  | 'notIn'
  | 'exists'
  | 'notExists'
  | 'contains'
  | 'notTerminal';

/**
 * Wire-string for each operator. The values here MUST match the server's
 * `op` field on `card.select_with_attributes` / `inbox.select`. Don't
 * rename keys/values — they're part of the wire contract.
 */
export const OP_TO_WIRE: Readonly<Record<Op, string>> = {
  eq: '=',
  ne: '!=',
  in: 'in',
  notIn: 'not in',
  exists: 'exists',
  notExists: 'not exists',
  contains: 'contains',
  notTerminal: 'not terminal',
};

const WIRE_TO_OP: Readonly<Record<string, Op>> = {
  '=': 'eq',
  '!=': 'ne',
  in: 'in',
  'not in': 'notIn',
  exists: 'exists',
  'not exists': 'notExists',
  contains: 'contains',
  'not terminal': 'notTerminal',
};

/** Returns the wire string for [op]. Inverse of {@link opFromWire}. */
export function opToWire(op: Op): string {
  return OP_TO_WIRE[op];
}

/**
 * Parses a wire string into an {@link Op}. Throws on unknown operators so
 * server-issued JSON cannot silently smuggle in a new operator the client
 * cannot render.
 */
export function opFromWire(s: string): Op {
  const v = WIRE_TO_OP[s];
  if (v === undefined) {
    throw new Error(`unknown predicate operator: ${JSON.stringify(s)}`);
  }
  return v;
}

/** Whether [op] takes no value, a single value, or a list. */
export type OpArity = 'none' | 'single' | 'multi';

export function opArity(op: Op): OpArity {
  switch (op) {
    case 'eq':
    case 'ne':
    case 'contains':
      return 'single';
    case 'in':
    case 'notIn':
      return 'multi';
    case 'exists':
    case 'notExists':
    case 'notTerminal':
      return 'none';
  }
}

/* -------------------------------------------------------------------------- */
/* AST                                                                        */
/* -------------------------------------------------------------------------- */

export interface PredicateLeaf {
  kind: 'leaf';
  attr: string;
  op: Op;
  /** Single-value ops use values[0]; multi-value ops use values; no-value ops omit. */
  values?: unknown[];
}

export interface PredicateGroup {
  kind: 'group';
  connective: 'and' | 'or' | 'not';
  children: Predicate[];
}

export type Predicate = PredicateLeaf | PredicateGroup;

/* -------------------------------------------------------------------------- */
/* JSON encode / decode                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Encode a {@link Predicate} for the wire (`tree` field on
 * `card.select_with_attributes` / `inbox.select`).
 *
 * Leaves emit `{attr, op, values?}` (op uses {@link OP_TO_WIRE});
 * groups emit `{connective, children}`. Empty `values` arrays are
 * omitted to match the Dart `if (values.isNotEmpty) 'values': values`
 * encoder; this keeps `exists` / `not exists` payloads minimal.
 */
export function predicateToJson(p: Predicate): unknown {
  if (p.kind === 'leaf') {
    const m: Record<string, unknown> = {
      attr: p.attr,
      op: OP_TO_WIRE[p.op],
    };
    if (p.values !== undefined && p.values.length > 0) {
      m.values = p.values;
    }
    return m;
  }
  return {
    connective: p.connective,
    children: p.children.map(predicateToJson),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Inverse of {@link predicateToJson}. Throws on unknown shapes so server
 * drift surfaces immediately.
 */
export function predicateFromJson(raw: unknown): Predicate {
  if (!isPlainObject(raw)) {
    throw new Error('predicate JSON must be an object');
  }
  if ('connective' in raw) {
    const c = raw.connective;
    if (c !== 'and' && c !== 'or' && c !== 'not') {
      throw new Error(`unknown group connective: ${JSON.stringify(c)}`);
    }
    const childrenRaw = raw.children;
    const children: Predicate[] = [];
    if (childrenRaw !== undefined && childrenRaw !== null) {
      if (!Array.isArray(childrenRaw)) {
        throw new Error('group children must be an array');
      }
      for (const ch of childrenRaw) {
        children.push(predicateFromJson(ch));
      }
    }
    if (c === 'not' && children.length !== 1) {
      throw new Error(
        `NOT group must have exactly one child (got ${children.length})`,
      );
    }
    return { kind: 'group', connective: c, children };
  }
  // Leaf
  const attrRaw = raw.attr;
  const opRaw = raw.op;
  if (typeof attrRaw !== 'string') {
    throw new Error('leaf attr must be a string');
  }
  if (typeof opRaw !== 'string') {
    throw new Error('leaf op must be a string');
  }
  const op = opFromWire(opRaw);
  const valuesRaw = raw.values;
  const leaf: PredicateLeaf = { kind: 'leaf', attr: attrRaw, op };
  if (valuesRaw !== undefined && valuesRaw !== null) {
    if (!Array.isArray(valuesRaw)) {
      throw new Error('leaf values must be an array');
    }
    leaf.values = valuesRaw.slice();
  }
  return leaf;
}

/* -------------------------------------------------------------------------- */
/* Flat-AND helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `true` when [p] is a flat top-level AND of leaves — the shape the
 * quick-filter bar can edit. A bare leaf also qualifies.
 */
export function isFlatAndOfLeaves(p: Predicate): boolean {
  if (p.kind === 'leaf') return true;
  if (p.connective !== 'and') return false;
  for (const c of p.children) {
    if (c.kind !== 'leaf') return false;
  }
  return true;
}

/**
 * Returns the leaves of [p] when [p] is a flat AND of leaves (or a single
 * leaf). Throws otherwise — callers gate on {@link isFlatAndOfLeaves}.
 */
export function flattenLeaves(p: Predicate): PredicateLeaf[] {
  if (p.kind === 'leaf') return [p];
  if (p.connective === 'and') {
    const out: PredicateLeaf[] = [];
    for (const c of p.children) {
      if (c.kind !== 'leaf') {
        throw new Error('predicate is not a flat AND of leaves');
      }
      out.push(c);
    }
    return out;
  }
  throw new Error('predicate is not a flat AND of leaves');
}

/**
 * Wrap [leaves] in a top-level AND group. Single-leaf input returns the
 * leaf itself (no needless group wrapper); empty input returns an empty
 * AND group (vacuously true).
 *
 * NOTE: differs slightly from the Dart helper, which returned `null` for
 * empty input. The TS port returns the empty AND group so callers always
 * receive a {@link Predicate}; drop-the-`tree`-field decisions move to the
 * caller (e.g. `if (children.length === 0) omit`).
 */
export function predicateFromLeaves(leaves: PredicateLeaf[]): Predicate {
  if (leaves.length === 1) {
    // Non-null because of the length check; `noUncheckedIndexedAccess` needs
    // the explicit cast.
    return leaves[0] as PredicateLeaf;
  }
  return { kind: 'group', connective: 'and', children: leaves.slice() };
}

/* -------------------------------------------------------------------------- */
/* Constructor helpers                                                        */
/* -------------------------------------------------------------------------- */

export function eq(attr: string, value: unknown): PredicateLeaf {
  return { kind: 'leaf', attr, op: 'eq', values: [value] };
}

export function ne(attr: string, value: unknown): PredicateLeaf {
  return { kind: 'leaf', attr, op: 'ne', values: [value] };
}

// `in` is a reserved JS keyword in some contexts; the Dart source uses
// `in_` and we match for cross-codebase grep symmetry.
export function in_(attr: string, values: unknown[]): PredicateLeaf {
  return { kind: 'leaf', attr, op: 'in', values: values.slice() };
}

export function notIn(attr: string, values: unknown[]): PredicateLeaf {
  return { kind: 'leaf', attr, op: 'notIn', values: values.slice() };
}

export function exists(attr: string): PredicateLeaf {
  return { kind: 'leaf', attr, op: 'exists' };
}

export function notExists(attr: string): PredicateLeaf {
  return { kind: 'leaf', attr, op: 'notExists' };
}

export function andOf(children: Predicate[]): PredicateGroup {
  return { kind: 'group', connective: 'and', children: children.slice() };
}

export function orOf(children: Predicate[]): PredicateGroup {
  return { kind: 'group', connective: 'or', children: children.slice() };
}

export function notOf(child: Predicate): PredicateGroup {
  return { kind: 'group', connective: 'not', children: [child] };
}

/* -------------------------------------------------------------------------- */
/* Human-readable rendering                                                   */
/* -------------------------------------------------------------------------- */

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  return String(v);
}

/**
 * Human-readable, share-friendly textual rendering. Read-only; we do NOT
 * round-trip text back into the AST. Use {@link predicateToJson} /
 * {@link predicateFromJson} for that.
 *
 * Examples:
 *   `status != done`
 *   `milestone in (M1, M2)`
 *   `(status = doing) AND (NOT (assignee = alice))`
 */
export function toText(p: Predicate): string {
  if (p.kind === 'leaf') {
    const opTxt = OP_TO_WIRE[p.op];
    switch (opArity(p.op)) {
      case 'none':
        return `${p.attr} ${opTxt}`;
      case 'single': {
        const vs = p.values ?? [];
        const v = vs.length === 0 ? 'null' : renderValue(vs[0]);
        return `${p.attr} ${opTxt} ${v}`;
      }
      case 'multi': {
        const vs = p.values ?? [];
        return `${p.attr} ${opTxt} (${vs.map(renderValue).join(', ')})`;
      }
    }
  }
  if (p.connective === 'not') {
    // NOT groups always have exactly one child by construction (asserted
    // both in `predicateFromJson` and `notOf`).
    const child = p.children[0];
    if (child === undefined) {
      // Defensive: bare `NOT` with no child renders as the empty marker.
      return 'NOT ()';
    }
    return `NOT (${toText(child)})`;
  }
  if (p.children.length === 0) {
    // Empty AND is true; empty OR is false. Render the textual constant
    // so the rendering is unambiguous when the editor is in this state.
    return p.connective === 'and' ? 'true' : 'false';
  }
  const joiner = p.connective === 'and' ? ' AND ' : ' OR ';
  return p.children.map((c) => `(${toText(c)})`).join(joiner);
}

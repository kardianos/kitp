/**
 * Vitest suite for `src/filter/predicate.ts`.
 *
 * Coverage targets per the migration plan §5.9 + the parent-task brief:
 *   1. Round-trip every operator (eq, ne, in_, notIn, exists, notExists).
 *   2. Wire shape uses `OP_TO_WIRE` strings (not the TS-side `Op` names).
 *   3. Group nesting (AND/OR/NOT) round-trips identically.
 *   4. `isFlatAndOfLeaves` for leaves, AND-of-leaves, OR, and nested groups.
 *   5. `flattenLeaves` throws on non-flat (OR) groups.
 *   6. `predicateFromLeaves` shape: empty → empty AND group, one → leaf,
 *      many → AND group.
 *   7. `toText` for canonical leaf and group cases (with parens).
 */

import { describe, expect, it } from 'vitest';

import {
  andOf,
  eq,
  exists,
  flattenLeaves,
  in_,
  isFlatAndOfLeaves,
  isPhase,
  ne,
  notExists,
  notIn,
  notOf,
  opArity,
  opFromWire,
  opToWire,
  orOf,
  PHASES,
  predicateFromJson,
  predicateFromLeaves,
  predicateToJson,
  toText,
  type Op,
  type Phase,
  type Predicate,
  type PredicateLeaf,
} from '../../src/filter/predicate.js';

describe('predicate JSON round-trip', () => {
  function roundTrip(p: Predicate): Predicate {
    return predicateFromJson(predicateToJson(p));
  }

  it('round-trips eq', () => {
    const p = eq('status', 'todo');
    expect(roundTrip(p)).toEqual(p);
  });

  it('round-trips ne', () => {
    const p = ne('status', 'done');
    expect(roundTrip(p)).toEqual(p);
  });

  it('round-trips in_', () => {
    const p = in_('milestone', ['M1', 'M2']);
    expect(roundTrip(p)).toEqual(p);
  });

  it('round-trips notIn', () => {
    const p = notIn('component', ['core', 'api']);
    expect(roundTrip(p)).toEqual(p);
  });

  it('round-trips exists', () => {
    const p = exists('assignee');
    expect(roundTrip(p)).toEqual(p);
  });

  it('round-trips notExists', () => {
    const p = notExists('assignee');
    expect(roundTrip(p)).toEqual(p);
  });

  it('round-trips numeric and boolean values verbatim', () => {
    const p1 = eq('priority', 3);
    const p2 = eq('archived', true);
    expect(roundTrip(p1)).toEqual(p1);
    expect(roundTrip(p2)).toEqual(p2);
  });
});

describe('predicate wire shape', () => {
  it('emits the wire op string, not the TS Op name', () => {
    const json = predicateToJson({
      kind: 'leaf',
      attr: 'status',
      op: 'eq',
      values: ['todo'],
    });
    expect(json).toEqual({ attr: 'status', op: '=', values: ['todo'] });
    // Belt-and-suspenders: the JSON must NOT carry the TS-side discriminator.
    expect((json as Record<string, unknown>).op).toBe('=');
  });

  it('emits "!=" for ne, "in" / "not in" for the multi ops', () => {
    expect(predicateToJson(ne('a', 1))).toEqual({
      attr: 'a',
      op: '!=',
      values: [1],
    });
    expect(predicateToJson(in_('a', [1, 2]))).toEqual({
      attr: 'a',
      op: 'in',
      values: [1, 2],
    });
    expect(predicateToJson(notIn('a', [1, 2]))).toEqual({
      attr: 'a',
      op: 'not in',
      values: [1, 2],
    });
  });

  it('omits the values key for no-value ops (exists / not exists)', () => {
    expect(predicateToJson(exists('assignee'))).toEqual({
      attr: 'assignee',
      op: 'exists',
    });
    expect(predicateToJson(notExists('assignee'))).toEqual({
      attr: 'assignee',
      op: 'not exists',
    });
  });

  it('opToWire / opFromWire are exact inverses', () => {
    for (const op of [
      'eq',
      'ne',
      'in',
      'notIn',
      'exists',
      'notExists',
      'contains',
      'notTerminal',
      'hasPhase',
    ] as const) {
      expect(opFromWire(opToWire(op))).toBe(op);
    }
  });

  it('opFromWire throws on unknown wire operators', () => {
    expect(() => opFromWire('like')).toThrow();
  });
});

describe('predicate group nesting', () => {
  it('round-trips a deep AND/OR/NOT tree', () => {
    const p = andOf([
      orOf([eq('a', 1), eq('b', 2)]),
      notOf(eq('c', 3)),
    ]);
    const back = predicateFromJson(predicateToJson(p));
    expect(back).toEqual(p);
  });

  it('encodes group connective as the literal wire string', () => {
    const json = predicateToJson(andOf([eq('a', 1)])) as Record<string, unknown>;
    expect(json.connective).toBe('and');
    expect(Array.isArray(json.children)).toBe(true);
  });

  it('rejects NOT groups with a child count other than 1', () => {
    expect(() =>
      predicateFromJson({
        connective: 'not',
        children: [
          { attr: 'a', op: '=', values: [1] },
          { attr: 'b', op: '=', values: [2] },
        ],
      }),
    ).toThrow();
  });
});

describe('isFlatAndOfLeaves', () => {
  it('treats a bare leaf as flat', () => {
    expect(isFlatAndOfLeaves(eq('a', 1))).toBe(true);
  });

  it('returns true for an AND of leaves', () => {
    expect(isFlatAndOfLeaves(andOf([eq('a', 1), ne('b', 2)]))).toBe(true);
  });

  it('returns false for an OR of leaves', () => {
    expect(isFlatAndOfLeaves(orOf([eq('a', 1), eq('b', 2)]))).toBe(false);
  });

  it('returns false for an AND containing a nested group', () => {
    expect(
      isFlatAndOfLeaves(andOf([eq('a', 1), orOf([eq('b', 2), eq('c', 3)])])),
    ).toBe(false);
  });

  it('returns false for a NOT group', () => {
    expect(isFlatAndOfLeaves(notOf(eq('a', 1)))).toBe(false);
  });
});

describe('flattenLeaves', () => {
  it('returns [leaf] when the predicate is a single leaf', () => {
    const leaf = eq('a', 1);
    expect(flattenLeaves(leaf)).toEqual([leaf]);
  });

  it('returns the children in order for a flat AND group', () => {
    const a = eq('a', 1);
    const b = ne('b', 2);
    const c = in_('c', [3, 4]);
    expect(flattenLeaves(andOf([a, b, c]))).toEqual([a, b, c]);
  });

  it('throws when given an OR group', () => {
    expect(() => flattenLeaves(orOf([eq('a', 1), eq('b', 2)]))).toThrow(
      /flat AND of leaves/,
    );
  });

  it('throws when an AND group contains a non-leaf child', () => {
    expect(() =>
      flattenLeaves(andOf([eq('a', 1), orOf([eq('b', 2), eq('c', 3)])])),
    ).toThrow(/flat AND of leaves/);
  });
});

describe('predicateFromLeaves', () => {
  it('returns an empty AND group for an empty input', () => {
    const p = predicateFromLeaves([]);
    expect(p).toEqual({ kind: 'group', connective: 'and', children: [] });
  });

  it('returns the lone leaf when given exactly one', () => {
    const leaf: PredicateLeaf = eq('a', 1);
    const p = predicateFromLeaves([leaf]);
    expect(p).toEqual(leaf);
  });

  it('wraps multiple leaves in an AND group', () => {
    const a = eq('a', 1);
    const b = ne('b', 2);
    const p = predicateFromLeaves([a, b]);
    expect(p).toEqual({
      kind: 'group',
      connective: 'and',
      children: [a, b],
    });
  });
});

describe('toText', () => {
  it('renders single-value leaves as `attr op value`', () => {
    expect(toText(ne('status', 'done'))).toBe('status != done');
    expect(toText(eq('priority', 3))).toBe('priority = 3');
  });

  it('renders multi-value leaves with parens', () => {
    expect(toText(in_('milestone', ['M1', 'M2']))).toBe(
      'milestone in (M1, M2)',
    );
    expect(toText(notIn('component', ['core', 'api']))).toBe(
      'component not in (core, api)',
    );
  });

  it('renders no-value leaves without a value section', () => {
    expect(toText(exists('assignee'))).toBe('assignee exists');
    expect(toText(notExists('assignee'))).toBe('assignee not exists');
  });

  it('renders nested AND/NOT groups with parentheses', () => {
    const p = andOf([eq('status', 'doing'), notOf(eq('assignee', 'alice'))]);
    expect(toText(p)).toBe('(status = doing) AND (NOT (assignee = alice))');
  });

  it('renders an empty AND as "true" and an empty OR as "false"', () => {
    expect(toText(andOf([]))).toBe('true');
    expect(toText(orOf([]))).toBe('false');
  });
});

describe('hasPhase op', () => {
  it.each<{ phase: unknown; want: boolean }>([
    { phase: 'triage', want: true },
    { phase: 'active', want: true },
    { phase: 'terminal', want: true },
    { phase: 'done', want: false },
    { phase: '', want: false },
    { phase: 0, want: false },
    { phase: null, want: false },
    { phase: undefined, want: false },
  ])('isPhase($phase) → $want', ({ phase, want }) => {
    expect(isPhase(phase)).toBe(want);
  });

  it('PHASES lists the three canonical phases in admin order', () => {
    expect(PHASES).toEqual(['triage', 'active', 'terminal']);
  });

  it('opArity is multi (server takes a values list)', () => {
    expect(opArity('hasPhase' as Op)).toBe('multi');
  });

  it.each<{ op: Op; wire: string }>([
    { op: 'hasPhase', wire: 'has_phase' },
    { op: 'notTerminal', wire: 'not terminal' },
    { op: 'contains', wire: 'contains' },
  ])('opToWire($op) === $wire', ({ op, wire }) => {
    expect(opToWire(op)).toBe(wire);
  });

  it('round-trips through JSON with values intact', () => {
    const leaf: PredicateLeaf = {
      kind: 'leaf',
      attr: 'status',
      op: 'hasPhase',
      values: ['triage', 'active'] satisfies Phase[],
    };
    const out = predicateFromJson(predicateToJson(leaf));
    expect(out).toEqual(leaf);
    expect(predicateToJson(leaf)).toEqual({
      attr: 'status',
      op: 'has_phase',
      values: ['triage', 'active'],
    });
  });
});

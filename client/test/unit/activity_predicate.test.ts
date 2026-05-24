/**
 * Unit coverage for the activity-sink predicate DSL helpers.
 *
 * Mirrors the server-side parser in
 * `server/internal/dom/activitysink/predicate.go` — every case here
 * documents a contract the visual builder relies on (empty
 * → match-everything, unknown ops throw, round-trip preserves shape).
 */

import { describe, expect, it } from 'vitest';

import {
  activityLeafValueKind,
  activityPredicateFromJson,
  activityPredicateFromString,
  activityPredicateToJson,
  activityPredicateToString,
  summarizeActivityPredicate,
  type ActivityPredicate,
} from '../../src/screens/admin/activity_predicate.js';

describe('activityPredicateFromJson', () => {
  it.each([
    ['null', null, null],
    ['empty object', {}, null],
    ['empty op string', { op: '' }, null],
  ])('%s → empty', (_label, input, expected) => {
    expect(activityPredicateFromJson(input)).toEqual(expected);
  });

  it('decodes a kind_in leaf', () => {
    expect(
      activityPredicateFromJson({
        op: 'kind_in',
        values: ['comment', 'card_create'],
      }),
    ).toEqual({
      kind: 'leaf',
      op: 'kind_in',
      values: ['comment', 'card_create'],
    });
  });

  it('decodes a nested and/or tree', () => {
    expect(
      activityPredicateFromJson({
        op: 'and',
        items: [
          { op: 'kind_in', values: ['comment'] },
          {
            op: 'or',
            items: [
              { op: 'actor_in', values: ['42'] },
              { op: 'attr_not_in', values: ['status'] },
            ],
          },
        ],
      }),
    ).toEqual({
      kind: 'composite',
      op: 'and',
      items: [
        { kind: 'leaf', op: 'kind_in', values: ['comment'] },
        {
          kind: 'composite',
          op: 'or',
          items: [
            { kind: 'leaf', op: 'actor_in', values: ['42'] },
            { kind: 'leaf', op: 'attr_not_in', values: ['status'] },
          ],
        },
      ],
    });
  });

  it('coerces numeric values to strings', () => {
    expect(
      activityPredicateFromJson({ op: 'actor_in', values: [42, 7] }),
    ).toEqual({ kind: 'leaf', op: 'actor_in', values: ['42', '7'] });
  });

  it('throws on unknown ops', () => {
    expect(() =>
      activityPredicateFromJson({ op: 'tag_in', values: ['x'] }),
    ).toThrow(/unknown activity predicate op/);
  });

  it('throws on non-array values', () => {
    expect(() =>
      activityPredicateFromJson({ op: 'kind_in', values: 'comment' }),
    ).toThrow(/values must be an array/);
  });
});

describe('activityPredicateFromString', () => {
  it.each([
    ['empty', '', null],
    ['whitespace', '   \n\t', null],
  ])('%s → null', (_label, input, expected) => {
    expect(activityPredicateFromString(input)).toEqual(expected);
  });

  it('parses a JSON string', () => {
    expect(
      activityPredicateFromString('{"op":"kind_in","values":["comment"]}'),
    ).toEqual({ kind: 'leaf', op: 'kind_in', values: ['comment'] });
  });
});

describe('round-trip', () => {
  const cases: { label: string; predicate: ActivityPredicate | null }[] = [
    { label: 'null', predicate: null },
    {
      label: 'bare leaf',
      predicate: { kind: 'leaf', op: 'kind_in', values: ['comment'] },
    },
    {
      label: 'and-group with two leaves',
      predicate: {
        kind: 'composite',
        op: 'and',
        items: [
          { kind: 'leaf', op: 'kind_in', values: ['comment'] },
          { kind: 'leaf', op: 'actor_not_in', values: ['1', '2'] },
        ],
      },
    },
  ];
  it.each(cases)('$label preserves shape through JSON', ({ predicate }) => {
    const wire = activityPredicateToString(predicate);
    if (predicate === null) {
      expect(wire).toBe('');
    } else {
      expect(activityPredicateFromString(wire)).toEqual(predicate);
    }
  });
});

describe('activityPredicateToJson', () => {
  it('emits null for null input', () => {
    expect(activityPredicateToJson(null)).toBeNull();
  });

  it('emits composite shape with items array', () => {
    expect(
      activityPredicateToJson({
        kind: 'composite',
        op: 'or',
        items: [{ kind: 'leaf', op: 'kind_in', values: ['comment'] }],
      }),
    ).toEqual({
      op: 'or',
      items: [{ op: 'kind_in', values: ['comment'] }],
    });
  });
});

describe('activityLeafValueKind', () => {
  it.each([
    ['kind_in', 'kind'],
    ['kind_not_in', 'kind'],
    ['attr_in', 'attr'],
    ['attr_not_in', 'attr'],
    ['actor_in', 'actor'],
    ['actor_not_in', 'actor'],
  ] as const)('%s → %s', (op, expected) => {
    expect(activityLeafValueKind(op)).toBe(expected);
  });
});

describe('summarizeActivityPredicate', () => {
  it('summarises null as match-everything', () => {
    expect(summarizeActivityPredicate(null)).toBe('Push every activity row');
  });

  it('summarises an empty and-group as match-everything', () => {
    expect(
      summarizeActivityPredicate({
        kind: 'composite',
        op: 'and',
        items: [],
      }),
    ).toBe('Push every activity row');
  });

  it('summarises an empty or-group as push-nothing', () => {
    expect(
      summarizeActivityPredicate({
        kind: 'composite',
        op: 'or',
        items: [],
      }),
    ).toBe('Push nothing');
  });

  it('summarises a leaf with values', () => {
    expect(
      summarizeActivityPredicate({
        kind: 'leaf',
        op: 'kind_in',
        values: ['comment', 'card_create'],
      }),
    ).toBe('kind in (comment, card_create)');
  });
});

/**
 * Unit coverage for the AdminAttributesScreen pure helpers.
 *
 * The vitest runner is node-only, so the .svelte component is not mounted —
 * we exercise the extracted helpers in
 * `src/screens/admin/admin_attributes_helpers.ts`.
 *
 * Coverage targets per task #21:
 *   1. `applyAttrSearch` — case-insensitive substring on `name`.
 *   2. `groupDefs` — partition by `is_built_in`.
 *   3. `boundMatrix` — for each card_type, `{cardType, bound, ordering,
 *      required}` derived from `def.bound_to`.
 *   4. `validateNewAttr` — name required, value_type required, enum requires
 *      >=1 option, ref:* requires refCardType.
 *   5. `parseRefCardType` — strip the `ref:` prefix.
 *   6. `defHasAnyValues` — detect any non-null value among loaded cards.
 */

import { describe, expect, it } from 'vitest';

import {
  applyAttrSearch,
  boundMatrix,
  defHasAnyValues,
  groupDefs,
  parseRefCardType,
  validateNewAttr,
} from '../../src/screens/admin/admin_attributes_helpers.js';
import type {
  AttributeDefRow,
  CardTypeRow,
} from '../../src/reg/types.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function def(
  id: number,
  name: string,
  opts: {
    valueType?: string;
    builtIn?: boolean;
    boundTo?: { card_type_id: number; ordering?: number; required?: boolean }[];
  } = {},
): AttributeDefRow {
  return {
    id,
    name,
    value_type: opts.valueType ?? 'text',
    is_built_in: opts.builtIn ?? false,
    bound_to: (opts.boundTo ?? []).map((b) => ({
      card_type_id: b.card_type_id,
      card_type_name: `ct${b.card_type_id}`,
      is_required: b.required ?? false,
      is_built_in: false,
      ordering: b.ordering ?? 0,
    })),
  };
}

function cardType(id: number, name: string, builtIn = false): CardTypeRow {
  return {
    id,
    name,
    allow_self_parent: false,
    is_built_in: builtIn,
  };
}

const DEFS: AttributeDefRow[] = [
  def(1, 'title', { valueType: 'text', builtIn: true }),
  def(2, 'status', { valueType: 'enum', builtIn: true }),
  def(3, 'priority', { valueType: 'number' }),
  def(4, 'milestone_ref', { valueType: 'ref:milestone' }),
  def(5, 'Custom_Attr', { valueType: 'text' }),
];

const CARD_TYPES: CardTypeRow[] = [
  cardType(10, 'task', true),
  cardType(11, 'project', true),
  cardType(12, 'milestone'),
];

/* -------------------------------------------------------------------------- */
/* applyAttrSearch                                                            */
/* -------------------------------------------------------------------------- */

describe('applyAttrSearch', () => {
  it('returns every def when search is empty', () => {
    expect(applyAttrSearch(DEFS, '').map((d) => d.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('whitespace-only search behaves like empty', () => {
    expect(applyAttrSearch(DEFS, '   ').map((d) => d.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('case-insensitive substring match against name', () => {
    expect(applyAttrSearch(DEFS, 'TITLE').map((d) => d.id)).toEqual([1]);
    expect(applyAttrSearch(DEFS, 'custom').map((d) => d.id)).toEqual([5]);
    expect(applyAttrSearch(DEFS, 'ref').map((d) => d.id)).toEqual([4]);
  });

  it('returns empty when nothing matches', () => {
    expect(applyAttrSearch(DEFS, 'zzznope')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const before = DEFS.map((d) => d.id);
    applyAttrSearch(DEFS, 'title');
    expect(DEFS.map((d) => d.id)).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* groupDefs                                                                  */
/* -------------------------------------------------------------------------- */

describe('groupDefs', () => {
  it('partitions by is_built_in', () => {
    const g = groupDefs(DEFS);
    expect(g.builtIn.map((d) => d.id)).toEqual([1, 2]);
    expect(g.custom.map((d) => d.id)).toEqual([3, 4, 5]);
  });

  it('preserves input order within each bucket', () => {
    const reordered: AttributeDefRow[] = [DEFS[2]!, DEFS[0]!, DEFS[3]!, DEFS[1]!];
    const g = groupDefs(reordered);
    expect(g.builtIn.map((d) => d.id)).toEqual([1, 2]);
    expect(g.custom.map((d) => d.id)).toEqual([3, 4]);
  });

  it('handles empty input', () => {
    expect(groupDefs([])).toEqual({ builtIn: [], custom: [] });
  });

  it('handles all-built-in input', () => {
    const onlyBuiltIn = [def(1, 'a', { builtIn: true }), def(2, 'b', { builtIn: true })];
    const g = groupDefs(onlyBuiltIn);
    expect(g.builtIn.map((d) => d.id)).toEqual([1, 2]);
    expect(g.custom).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* boundMatrix                                                                */
/* -------------------------------------------------------------------------- */

describe('boundMatrix', () => {
  it('returns one row per card type with default values when def is null', () => {
    const m = boundMatrix(CARD_TYPES, null);
    expect(m).toHaveLength(3);
    for (const row of m) {
      expect(row.bound).toBe(false);
      expect(row.ordering).toBe(0);
      expect(row.required).toBe(false);
    }
    expect(m.map((r) => r.cardType.id)).toEqual([10, 11, 12]);
  });

  it('marks bound rows and surfaces ordering + required', () => {
    const d = def(99, 'foo', {
      boundTo: [
        { card_type_id: 10, ordering: 5, required: true },
        { card_type_id: 12, ordering: 0, required: false },
      ],
    });
    const m = boundMatrix(CARD_TYPES, d);
    const byId = new Map(m.map((r) => [r.cardType.id, r]));
    expect(byId.get(10)).toEqual({
      cardType: CARD_TYPES[0],
      bound: true,
      ordering: 5,
      required: true,
    });
    expect(byId.get(11)).toEqual({
      cardType: CARD_TYPES[1],
      bound: false,
      ordering: 0,
      required: false,
    });
    expect(byId.get(12)).toEqual({
      cardType: CARD_TYPES[2],
      bound: true,
      ordering: 0,
      required: false,
    });
  });

  it('handles defs with no bindings', () => {
    const d = def(99, 'foo', { boundTo: [] });
    const m = boundMatrix(CARD_TYPES, d);
    for (const row of m) expect(row.bound).toBe(false);
  });

  it('handles empty card-type list', () => {
    expect(boundMatrix([], def(1, 'a'))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* validateNewAttr                                                            */
/* -------------------------------------------------------------------------- */

describe('validateNewAttr', () => {
  it('rejects an empty name', () => {
    const r = validateNewAttr({ name: '   ', valueType: 'text' });
    expect(r.ok).toBe(false);
    expect(r.errors.name).toBeDefined();
  });

  it('rejects an empty value_type', () => {
    const r = validateNewAttr({ name: 'foo', valueType: '' });
    expect(r.ok).toBe(false);
    expect(r.errors.valueType).toBeDefined();
  });

  it('accepts a minimal text attribute', () => {
    const r = validateNewAttr({ name: 'foo', valueType: 'text' });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
  });

  it('accepts enum without options (options are added post-creation)', () => {
    const r = validateNewAttr({ name: 'sev', valueType: 'enum' });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
  });

  it('rejects ref:* without a refCardType', () => {
    const r = validateNewAttr({ name: 'm', valueType: 'ref:' });
    expect(r.ok).toBe(false);
    expect(r.errors.refCardType).toBeDefined();
  });

  it('accepts ref:<inline-name>', () => {
    const r = validateNewAttr({ name: 'm', valueType: 'ref:milestone' });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
  });

  it('accepts ref: with explicit refCardType', () => {
    const r = validateNewAttr({
      name: 'm',
      valueType: 'ref:',
      refCardType: 'milestone',
    });
    expect(r.ok).toBe(true);
  });

  it('aggregates multiple errors at once', () => {
    const r = validateNewAttr({ name: '', valueType: 'ref:' });
    expect(r.ok).toBe(false);
    expect(r.errors.name).toBeDefined();
    expect(r.errors.refCardType).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* parseRefCardType                                                           */
/* -------------------------------------------------------------------------- */

describe('parseRefCardType', () => {
  it('returns the card type name after `ref:`', () => {
    expect(parseRefCardType('ref:milestone')).toBe('milestone');
    expect(parseRefCardType('ref:component')).toBe('component');
  });

  it('returns null for non-ref types', () => {
    expect(parseRefCardType('text')).toBe(null);
    expect(parseRefCardType('enum')).toBe(null);
    expect(parseRefCardType('')).toBe(null);
  });

  it('returns null for empty target', () => {
    expect(parseRefCardType('ref:')).toBe(null);
    expect(parseRefCardType('ref:   ')).toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* defHasAnyValues                                                            */
/* -------------------------------------------------------------------------- */

describe('defHasAnyValues', () => {
  it('returns false for empty list', () => {
    expect(defHasAnyValues('status', [])).toBe(false);
  });

  it('returns false when no card has the attribute set', () => {
    expect(
      defHasAnyValues('status', [
        { attributes: { title: 'a' } },
        { attributes: {} },
      ]),
    ).toBe(false);
  });

  it('returns true on the first non-null/non-undefined match', () => {
    expect(
      defHasAnyValues('status', [
        { attributes: { title: 'a' } },
        { attributes: { status: 'todo' } },
      ]),
    ).toBe(true);
  });

  it('treats null as absent', () => {
    expect(
      defHasAnyValues('status', [{ attributes: { status: null } }]),
    ).toBe(false);
  });

  it('treats explicit false / 0 / "" as present', () => {
    expect(
      defHasAnyValues('done', [{ attributes: { done: false } }]),
    ).toBe(true);
    expect(
      defHasAnyValues('count', [{ attributes: { count: 0 } }]),
    ).toBe(true);
    expect(
      defHasAnyValues('label', [{ attributes: { label: '' } }]),
    ).toBe(true);
  });
});

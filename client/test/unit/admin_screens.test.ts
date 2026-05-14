/**
 * Unit coverage for the AdminScreensScreen pure helpers.
 *
 * The vitest runner is node-only, so the .svelte component is not mounted —
 * we exercise the extracted helpers in
 * `src/screens/admin/admin_screens_helpers.ts`.
 *
 * Style mirrors `screen_preset.test.ts`: every helper gets an `it.each(...)`
 * data table — one assertion per row — so adding a case is a one-line edit
 * rather than a fresh `it(...)` block.
 */

import { describe, expect, it } from 'vitest';

import type { CardWithAttrs } from '../../src/reg/types.js';
import { LAYOUTS, type Layout } from '../../src/filter/screen_preset.svelte.js';
import {
  friendlyScreenLabel,
  missingLayouts,
  sortBySortOrder,
  uniqueSlug,
  validatePredicateJson,
  validateScreenHotkey,
  validateScreenSlug,
} from '../../src/screens/admin/admin_screens_helpers.js';
import { readFlowRef } from '../../src/filter/screen_preset.svelte.js';

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

function card(
  id: bigint,
  attributes: Record<string, unknown> = {},
): CardWithAttrs {
  return {
    id,
    card_type_id: 99n,
    card_type_name: 'screen',
    phase: 'active',
    attributes,
  };
}

function screen(id: bigint, layout: string, sortOrder?: number): CardWithAttrs {
  const attrs: Record<string, unknown> = { layout };
  if (sortOrder !== undefined) attrs.sort_order = sortOrder;
  return card(id, attrs);
}

/* -------------------------------------------------------------------------- */
/* missingLayouts                                                             */
/* -------------------------------------------------------------------------- */

describe('missingLayouts', () => {
  it.each<{
    label: string;
    screens: CardWithAttrs[];
    all: readonly Layout[];
    want: Layout[];
  }>([
    {
      label: 'empty screens → full all',
      screens: [],
      all: LAYOUTS,
      want: ['list', 'grid', 'kanban', 'pair'],
    },
    {
      label: 'all present → empty',
      screens: [
        screen(1n, 'list'),
        screen(2n, 'grid'),
        screen(3n, 'kanban'),
        screen(4n, 'pair'),
      ],
      all: LAYOUTS,
      want: [],
    },
    {
      label: 'one missing (kanban) → returns just kanban',
      screens: [screen(1n, 'list'), screen(2n, 'grid'), screen(4n, 'pair')],
      all: LAYOUTS,
      want: ['kanban'],
    },
    {
      label: 'duplicates in screens still reports the remainder correctly',
      screens: [screen(1n, 'list'), screen(2n, 'list'), screen(3n, 'grid')],
      all: LAYOUTS,
      want: ['kanban', 'pair'],
    },
    {
      label: 'preserves order of `all`',
      screens: [screen(1n, 'kanban')],
      all: ['pair', 'list', 'grid', 'kanban'] as const,
      want: ['pair', 'list', 'grid'],
    },
    {
      label: 'screens with no layout attribute are ignored',
      screens: [card(1n, {}), screen(2n, 'list')],
      all: LAYOUTS,
      want: ['grid', 'kanban', 'pair'],
    },
  ])('$label', ({ screens, all, want }) => {
    expect(missingLayouts(screens, all)).toEqual(want);
  });
});

/* -------------------------------------------------------------------------- */
/* sortBySortOrder                                                         */
/* -------------------------------------------------------------------------- */

describe('sortBySortOrder', () => {
  it.each<{
    label: string;
    input: CardWithAttrs[];
    wantIds: bigint[];
  }>([
    {
      label: 'numeric sort_orders → ascending',
      input: [
        screen(1n, 'list', 30),
        screen(2n, 'grid', 10),
        screen(3n, 'kanban', 20),
      ],
      wantIds: [2n, 3n, 1n],
    },
    {
      label: 'ties broken by id',
      input: [
        screen(3n, 'kanban', 10),
        screen(1n, 'list', 10),
        screen(2n, 'grid', 10),
      ],
      wantIds: [1n, 2n, 3n],
    },
    {
      label: 'missing sort_order → sorts last',
      input: [
        screen(1n, 'list'),
        screen(2n, 'grid', 10),
        screen(3n, 'kanban'),
      ],
      wantIds: [2n, 1n, 3n],
    },
    {
      label: 'mix of present/absent → present first, absent last (tied by id)',
      input: [
        screen(5n, 'list'),
        screen(1n, 'grid', 5),
        screen(3n, 'kanban'),
        screen(2n, 'pair', 1),
      ],
      wantIds: [2n, 1n, 3n, 5n],
    },
    {
      label: 'empty input → empty output',
      input: [],
      wantIds: [],
    },
    {
      label: 'non-numeric sort_order (string) treated as absent',
      input: [
        card(1n, { layout: 'list', sort_order: 'oops' }),
        screen(2n, 'grid', 10),
      ],
      wantIds: [2n, 1n],
    },
  ])('$label', ({ input, wantIds }) => {
    expect(sortBySortOrder(input).map((s) => s.id)).toEqual(wantIds);
  });

  it('does not mutate the input', () => {
    const input = [
      screen(3n, 'kanban', 30),
      screen(1n, 'list', 10),
      screen(2n, 'grid', 20),
    ];
    const before = input.map((s) => s.id);
    sortBySortOrder(input);
    expect(input.map((s) => s.id)).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* validatePredicateJson                                                      */
/* -------------------------------------------------------------------------- */

describe('validatePredicateJson', () => {
  it.each<{
    label: string;
    raw: string;
    wantOk: boolean;
    wantPredicateNull?: boolean;
  }>([
    { label: 'empty string → ok, null', raw: '', wantOk: true, wantPredicateNull: true },
    { label: 'whitespace → ok, null', raw: '   \n  ', wantOk: true, wantPredicateNull: true },
    { label: 'invalid JSON → not ok', raw: '{not-json', wantOk: false },
    {
      label: 'valid JSON but bad predicate shape → not ok',
      raw: '{"foo":"bar"}',
      wantOk: false,
    },
    {
      label: 'valid leaf predicate (wire op `=`) → ok',
      raw: '{"attr":"status","op":"=","values":["done"]}',
      wantOk: true,
      wantPredicateNull: false,
    },
    {
      label: 'valid group predicate → ok',
      raw: '{"connective":"and","children":[{"attr":"x","op":"=","values":[1]}]}',
      wantOk: true,
      wantPredicateNull: false,
    },
    {
      label: 'unknown operator → not ok',
      raw: '{"attr":"x","op":"~=","values":[1]}',
      wantOk: false,
    },
  ])('$label', ({ raw, wantOk, wantPredicateNull }) => {
    const got = validatePredicateJson(raw);
    expect(got.ok).toBe(wantOk);
    if (got.ok && wantPredicateNull !== undefined) {
      if (wantPredicateNull) {
        expect(got.predicate).toBeNull();
      } else {
        expect(got.predicate).not.toBeNull();
      }
    }
    if (!got.ok) {
      expect(typeof got.error).toBe('string');
      expect(got.error.length).toBeGreaterThan(0);
    }
  });

  it('round-trips the leaf shape (wire `=` → internal `eq`)', () => {
    const got = validatePredicateJson(
      '{"attr":"assignee","op":"=","values":[42]}',
    );
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.predicate).toEqual({
        kind: 'leaf',
        attr: 'assignee',
        op: 'eq',
        values: [42],
      });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* friendlyScreenLabel                                                        */
/* -------------------------------------------------------------------------- */

describe('friendlyScreenLabel', () => {
  it.each<{ input: string; want: string }>([
    { input: 'list', want: 'List' },
    { input: 'grid', want: 'Grid' },
    { input: 'kanban', want: 'Kanban' },
    { input: 'pair', want: 'Pair' },
    { input: 'multi_word_thing', want: 'Multi word thing' },
    { input: '', want: '' },
  ])('$input → $want', ({ input, want }) => {
    expect(friendlyScreenLabel(input)).toBe(want);
  });
});

/* -------------------------------------------------------------------------- */
/* validateScreenSlug                                                         */
/* -------------------------------------------------------------------------- */

describe('validateScreenSlug', () => {
  it.each<{ input: string; wantOk: boolean }>([
    { input: 'inbox', wantOk: true },
    { input: 'a', wantOk: true },
    { input: 'my-screen', wantOk: true },
    { input: 'my_screen', wantOk: true },
    { input: 'screen42', wantOk: true },
    { input: '  trimmed  ', wantOk: true },
    { input: '', wantOk: false },
    { input: '   ', wantOk: false },
    { input: 'Inbox', wantOk: false },
    { input: '1abc', wantOk: false },
    { input: 'has space', wantOk: false },
    { input: 'a/b', wantOk: false },
    { input: 'a.b', wantOk: false },
  ])('$input → ok=$wantOk', ({ input, wantOk }) => {
    expect(validateScreenSlug(input).ok).toBe(wantOk);
  });
});

/* -------------------------------------------------------------------------- */
/* validateScreenHotkey                                                       */
/* -------------------------------------------------------------------------- */

describe('validateScreenHotkey', () => {
  it.each<{ input: string; wantOk: boolean }>([
    { input: '', wantOk: true },
    { input: '  ', wantOk: true },
    { input: 'i', wantOk: true },
    { input: 'G', wantOk: true },
    { input: '7', wantOk: true },
    { input: 'gg', wantOk: false },
    { input: '!', wantOk: false },
    { input: ' i ', wantOk: true },
    { input: 'i j', wantOk: false },
  ])('$input → ok=$wantOk', ({ input, wantOk }) => {
    expect(validateScreenHotkey(input).ok).toBe(wantOk);
  });
});

/* -------------------------------------------------------------------------- */
/* uniqueSlug                                                                 */
/* -------------------------------------------------------------------------- */

describe('uniqueSlug', () => {
  it.each<{ base: string; taken: string[]; want: string }>([
    { base: 'grid', taken: [], want: 'grid' },
    { base: 'grid', taken: ['list'], want: 'grid' },
    { base: 'grid', taken: ['grid'], want: 'grid-2' },
    { base: 'grid', taken: ['grid', 'grid-2'], want: 'grid-3' },
    { base: 'grid', taken: ['grid', 'grid-2', 'grid-3'], want: 'grid-4' },
    // Gap in the numbering is filled (we walk monotonically, so we
    // return the first free number — `grid-2` here, not `grid-4`).
    { base: 'grid', taken: ['grid', 'grid-3'], want: 'grid-2' },
  ])('$base + $taken → $want', ({ base, taken, want }) => {
    expect(uniqueSlug(base, new Set(taken))).toBe(want);
  });
});

/* -------------------------------------------------------------------------- */
/* readFlowRef                                                                */
/* -------------------------------------------------------------------------- */

describe('readFlowRef', () => {
  it.each<{ label: string; attrs: Record<string, unknown>; want: bigint | null }>([
    { label: 'absent → null', attrs: {}, want: null },
    { label: 'bigint → bigint', attrs: { flow_ref: 42n }, want: 42n },
    { label: 'bigint 0n → null', attrs: { flow_ref: 0n }, want: null },
    { label: 'number → bigint', attrs: { flow_ref: 7 }, want: 7n },
    { label: 'number 0 → null', attrs: { flow_ref: 0 }, want: null },
    { label: 'string of digits → bigint', attrs: { flow_ref: '99' }, want: 99n },
    { label: 'string "0" → null', attrs: { flow_ref: '0' }, want: null },
    { label: 'non-numeric string → null', attrs: { flow_ref: 'abc' }, want: null },
    { label: 'NaN → null', attrs: { flow_ref: Number.NaN }, want: null },
  ])('$label', ({ attrs, want }) => {
    expect(readFlowRef(card(1n, attrs))).toBe(want);
  });
});

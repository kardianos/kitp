/**
 * Data-table coverage for the typed accessors in screen_preset. Each
 * helper reads one attribute off a CardWithAttrs and returns a typed
 * shape; the matrix below pins every interesting variant (present,
 * missing, wrong type, empty string) without re-stating the test body.
 *
 * loadScreenAndFilters is exercised separately further down with a
 * stub dispatcher — same data-table approach: feed (fixture, expected)
 * pairs.
 */

import { describe, expect, it } from 'vitest';

import type { CardWithAttrs } from '../../src/reg/types.js';
import {
  loadScreenAndFilters,
  readColumnAttr,
  readDefaultFilterID,
  readLaneAttr,
  readPredicate,
  readScreenType,
  readTitle,
  SCREEN_TYPES,
} from '../../src/filter/screen_preset.svelte.js';
import type { Dispatcher } from '../../src/dispatch/dispatcher.js';

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
    card_type_name: 'filter',
    phase: 'active',
    attributes,
  };
}

/* -------------------------------------------------------------------------- */
/* SCREEN_TYPES exhaustiveness                                                */
/* -------------------------------------------------------------------------- */

describe('SCREEN_TYPES', () => {
  it('lists exactly the four screens the application supports', () => {
    expect(SCREEN_TYPES).toEqual([
      'inbox',
      'grid',
      'kanban',
      'project_detail',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* String / id accessors                                                      */
/* -------------------------------------------------------------------------- */

describe.each<{
  name: string;
  fn: (c: CardWithAttrs) => unknown;
  attr: string;
}>([
  { name: 'readScreenType', fn: readScreenType, attr: 'screen_type' },
  { name: 'readColumnAttr', fn: readColumnAttr, attr: 'column_attr' },
  { name: 'readLaneAttr', fn: readLaneAttr, attr: 'lane_attr' },
])('$name (string accessor on `$attr`)', ({ fn, attr }) => {
  it.each<{
    label: string;
    value: unknown;
    want: unknown;
  }>([
    { label: 'absent', value: undefined, want: null },
    { label: 'empty string', value: '', want: null },
    { label: 'plain string', value: 'inbox', want: 'inbox' },
    { label: 'numeric (wrong type)', value: 42, want: null },
    { label: 'bigint (wrong type)', value: 5n, want: null },
    { label: 'null (cleared)', value: null, want: null },
  ])('$label → $want', ({ value, want }) => {
    const c = card(1n, value === undefined ? {} : { [attr]: value });
    expect(fn(c)).toBe(want);
  });
});

describe('readTitle', () => {
  it.each<{
    label: string;
    value: unknown;
    want: string;
  }>([
    { label: 'string', value: 'My filter', want: 'My filter' },
    { label: 'empty', value: '', want: '#1' },
    { label: 'absent', value: undefined, want: '#1' },
    { label: 'wrong type', value: 7n, want: '#1' },
  ])('$label → $want', ({ value, want }) => {
    const c = card(1n, value === undefined ? {} : { title: value });
    expect(readTitle(c)).toBe(want);
  });
});

describe('readDefaultFilterID', () => {
  it.each<{
    label: string;
    value: unknown;
    want: bigint | null;
  }>([
    { label: 'present (bigint)', value: 42n, want: 42n },
    { label: 'absent', value: undefined, want: null },
    { label: 'wrong type (number)', value: 42, want: null },
    { label: 'wrong type (string)', value: '42', want: null },
    { label: 'null', value: null, want: null },
  ])('$label → $want', ({ value, want }) => {
    const c = card(1n, value === undefined ? {} : { default_filter: value });
    expect(readDefaultFilterID(c)).toBe(want);
  });
});

/* -------------------------------------------------------------------------- */
/* readPredicate                                                              */
/* -------------------------------------------------------------------------- */

describe('readPredicate', () => {
  it.each<{
    label: string;
    raw: unknown;
    wantNull: boolean;
  }>([
    { label: 'absent', raw: undefined, wantNull: true },
    { label: 'empty string', raw: '', wantNull: true },
    { label: 'whitespace string', raw: '   ', wantNull: true },
    { label: 'invalid JSON', raw: 'not-json', wantNull: true },
    { label: 'wrong type (number)', raw: 7, wantNull: true },
    { label: 'valid JSON predicate (wire ops)', raw: '{"attr":"x","op":"=","values":["a"]}', wantNull: false },
  ])('$label → null=$wantNull', ({ raw, wantNull }) => {
    const c = card(1n, raw === undefined ? {} : { predicate: raw });
    const got = readPredicate(c);
    if (wantNull) expect(got).toBeNull();
    else expect(got).not.toBeNull();
  });

  it('round-trips the leaf shape (wire op `=` → internal `eq`)', () => {
    const c = card(1n, {
      predicate: '{"attr":"assignee","op":"=","values":[1]}',
    });
    const got = readPredicate(c);
    expect(got).toEqual({
      kind: 'leaf',
      attr: 'assignee',
      op: 'eq',
      values: [1],
    });
  });

  it('revives card_ref leaf values from JSON strings back to bigints', () => {
    // stringifyBigInt emits bigints as JSON strings ("3"); readPredicate
    // must restore them to bigints so FilterBar pickers (whose options
    // are bigints) light up the chip and the dispatcher re-encodes
    // round-trip writes the same way.
    const c = card(1n, {
      predicate: '{"attr":"milestone_ref","op":"=","values":["3"]}',
    });
    expect(readPredicate(c)).toEqual({
      kind: 'leaf',
      attr: 'milestone_ref',
      op: 'eq',
      values: [3n],
    });
  });

  it('revives tags array values from JSON strings back to bigints', () => {
    const c = card(1n, {
      predicate:
        '{"connective":"and","children":[{"attr":"tags","op":"in","values":["7","11"]}]}',
    });
    const got = readPredicate(c);
    expect(got).not.toBeNull();
    expect(got!.kind).toBe('group');
    if (got!.kind === 'group') {
      const leaf = got!.children[0]!;
      expect(leaf).toEqual({
        kind: 'leaf',
        attr: 'tags',
        op: 'in',
        values: [7n, 11n],
      });
    }
  });

  it('leaves non-ref leaf values alone', () => {
    const c = card(1n, {
      predicate: '{"attr":"title","op":"=","values":["123"]}',
    });
    const got = readPredicate(c);
    expect(got).toEqual({
      kind: 'leaf',
      attr: 'title',
      op: 'eq',
      values: ['123'],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* loadScreenAndFilters                                                       */
/*                                                                            */
/* The dispatcher is stubbed; each test feeds a (screensFetch, filtersFetch)  */
/* pair and checks the shape of the returned ScreenPresetSet.                 */
/* -------------------------------------------------------------------------- */

function makeDispatcher(
  screensRows: CardWithAttrs[],
  filtersRows: CardWithAttrs[] = [],
): Pick<Dispatcher, 'request'> {
  // The real Dispatcher.request is generic; the helper just routes by
  // cardTypeName so we can return narrowed rows. The unknown cast keeps
  // the stub aligned with the public signature without infecting the
  // tests with parameterised types.
  const request = async (args: unknown): Promise<unknown> => {
    const data = (args as { data?: { cardTypeName?: string } }).data;
    if (data?.cardTypeName === 'screen') return { rows: screensRows };
    if (data?.cardTypeName === 'filter') return { rows: filtersRows };
    throw new Error(
      `unexpected dispatcher call for cardTypeName=${data?.cardTypeName ?? '?'}`,
    );
  };
  return { request: request as Pick<Dispatcher, 'request'>['request'] };
}

describe('loadScreenAndFilters', () => {
  it.each<{
    label: string;
    screens: CardWithAttrs[];
    filters: CardWithAttrs[];
    screenType: 'inbox' | 'grid' | 'kanban' | 'project_detail';
    wantScreenId: bigint | null;
    wantFilterCount: number;
    wantDefaultId: bigint | null;
  }>([
    {
      label: 'no screen for type → empty',
      screens: [],
      filters: [],
      screenType: 'inbox',
      wantScreenId: null,
      wantFilterCount: 0,
      wantDefaultId: null,
    },
    {
      label: 'screen but no filters → screen + empty filter list',
      screens: [card(10n, { screen_type: 'inbox' })],
      filters: [],
      screenType: 'inbox',
      wantScreenId: 10n,
      wantFilterCount: 0,
      wantDefaultId: null,
    },
    {
      label: 'screen + filters, no default_filter set',
      screens: [card(11n, { screen_type: 'grid' })],
      filters: [card(20n, { title: 'A' }), card(21n, { title: 'B' })],
      screenType: 'grid',
      wantScreenId: 11n,
      wantFilterCount: 2,
      wantDefaultId: null,
    },
    {
      label: 'screen + filters + default_filter present',
      screens: [card(12n, { screen_type: 'kanban', default_filter: 21n })],
      filters: [card(20n, { title: 'A' }), card(21n, { title: 'B' })],
      screenType: 'kanban',
      wantScreenId: 12n,
      wantFilterCount: 2,
      wantDefaultId: 21n,
    },
    {
      label: 'default_filter points at a missing card → null default',
      screens: [card(13n, { screen_type: 'kanban', default_filter: 99n })],
      filters: [card(20n, { title: 'A' })],
      screenType: 'kanban',
      wantScreenId: 13n,
      wantFilterCount: 1,
      wantDefaultId: null,
    },
    {
      label: 'screen_type filter picks the right screen out of many',
      screens: [
        card(30n, { screen_type: 'inbox' }),
        card(31n, { screen_type: 'grid' }),
        card(32n, { screen_type: 'kanban' }),
      ],
      filters: [],
      screenType: 'grid',
      wantScreenId: 31n,
      wantFilterCount: 0,
      wantDefaultId: null,
    },
  ])(
    '$label',
    async ({
      screens,
      filters,
      screenType,
      wantScreenId,
      wantFilterCount,
      wantDefaultId,
    }) => {
      const dispatcher = makeDispatcher(screens, filters);
      const out = await loadScreenAndFilters(dispatcher, 100n, screenType);
      expect(out.screen?.id ?? null).toBe(wantScreenId);
      expect(out.filters.length).toBe(wantFilterCount);
      expect(out.defaultFilter?.id ?? null).toBe(wantDefaultId);
    },
  );

  it('skips the filter fetch when no screen matches', async () => {
    let filterCalls = 0;
    const request = async (args: unknown): Promise<unknown> => {
      const data = (args as { data?: { cardTypeName?: string } }).data;
      if (data?.cardTypeName === 'screen') return { rows: [] };
      if (data?.cardTypeName === 'filter') {
        filterCalls++;
        return { rows: [] };
      }
      throw new Error('unexpected');
    };
    await loadScreenAndFilters(
      { request: request as Pick<Dispatcher, 'request'>['request'] },
      100n,
      'inbox',
    );
    expect(filterCalls).toBe(0);
  });
});

/**
 * Vitest suite for the GridScreen logic helpers in
 * `src/screens/grid_helpers.ts`. The Svelte component itself imports cleanly
 * (smoke import below); component-mount coverage will arrive with the e2e
 * pass that drives a real browser.
 *
 * Coverage targets per task #14 of the migration plan:
 *   1. `cycleSort`           — null → asc; asc → desc; desc → null;
 *                              switching column → asc on new column.
 *   2. `buildOrderClauses`   — empty array when null, single clause when set.
 *   3. `applyFilterToTree`   — pass-through if predicate is null; otherwise
 *                              convert via `predicateToJson`, wrapping bare
 *                              leaves in a one-child AND group.
 */

import { describe, expect, it } from 'vitest';

import {
  andOf,
  eq,
  in_,
  predicateToJson,
  type Predicate,
} from '../../src/filter/predicate.js';
import {
  applyFilterToTree,
  buildOrderClauses,
  compareGroupKey,
  compareTagPrefixValue,
  cycleSort,
  effectiveSort,
  expandRowsForArrayGroup,
  isTagPrefixSortField,
  pickTagForPrefix,
  sortStatesFromFilter,
  stripTagPrefix,
  type SortState,
  tagPrefixFromSortField,
  tagPrefixSortField,
  walkGrouped,
} from '../../src/screens/grid_helpers.js';

/* -------------------------------------------------------------------------- */
/* cycleSort                                                                  */
/* -------------------------------------------------------------------------- */

describe('cycleSort', () => {
  it('returns asc on the clicked field when no sort is active', () => {
    expect(cycleSort(null, 'attributes.title')).toEqual({
      field: 'attributes.title',
      direction: 'asc',
    });
  });

  it('cycles asc → desc on the same column', () => {
    const cur: SortState = { field: 'attributes.title', direction: 'asc' };
    expect(cycleSort(cur, 'attributes.title')).toEqual({
      field: 'attributes.title',
      direction: 'desc',
    });
  });

  it('cycles desc → null (off) on the same column', () => {
    const cur: SortState = { field: 'attributes.title', direction: 'desc' };
    expect(cycleSort(cur, 'attributes.title')).toBeNull();
  });

  it('switches to asc on a new column when a different column is active', () => {
    const cur: SortState = { field: 'attributes.title', direction: 'desc' };
    expect(cycleSort(cur, 'created_at')).toEqual({
      field: 'created_at',
      direction: 'asc',
    });
  });

  it('switches to asc when current is asc on a different column', () => {
    const cur: SortState = { field: 'attributes.status', direction: 'asc' };
    expect(cycleSort(cur, 'attributes.assignee')).toEqual({
      field: 'attributes.assignee',
      direction: 'asc',
    });
  });

  it('cycles deterministically through asc → desc → null → asc', () => {
    let s: SortState | null = null;
    s = cycleSort(s, 'created_at');
    expect(s).toEqual({ field: 'created_at', direction: 'asc' });
    s = cycleSort(s, 'created_at');
    expect(s).toEqual({ field: 'created_at', direction: 'desc' });
    s = cycleSort(s, 'created_at');
    expect(s).toBeNull();
    s = cycleSort(s, 'created_at');
    expect(s).toEqual({ field: 'created_at', direction: 'asc' });
  });
});

/* -------------------------------------------------------------------------- */
/* buildOrderClauses                                                          */
/* -------------------------------------------------------------------------- */

describe('buildOrderClauses', () => {
  it('returns an empty array when no sort is active', () => {
    expect(buildOrderClauses(null)).toEqual([]);
  });

  it('returns an empty array when given []', () => {
    expect(buildOrderClauses([])).toEqual([]);
  });

  it('returns a single ASC clause when sort is asc', () => {
    expect(
      buildOrderClauses({ field: 'attributes.title', direction: 'asc' }),
    ).toEqual([{ field: 'attributes.title', direction: 'ASC' }]);
  });

  it('returns a single DESC clause when sort is desc', () => {
    expect(
      buildOrderClauses({ field: 'created_at', direction: 'desc' }),
    ).toEqual([{ field: 'created_at', direction: 'DESC' }]);
  });

  it('preserves order of a multi-key sort list', () => {
    expect(
      buildOrderClauses([
        { field: 'attributes.status', direction: 'asc' },
        { field: 'attributes.title', direction: 'desc' },
      ]),
    ).toEqual([
      { field: 'attributes.status', direction: 'ASC' },
      { field: 'attributes.title', direction: 'DESC' },
    ]);
  });

  it('uppercases direction (server expects ASC/DESC, not asc/desc)', () => {
    const out = buildOrderClauses({
      field: 'attributes.status',
      direction: 'asc',
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe('ASC');
  });
});

/* -------------------------------------------------------------------------- */
/* sortStatesFromFilter                                                       */
/* -------------------------------------------------------------------------- */

describe('sortStatesFromFilter', () => {
  it('returns [] for an empty list', () => {
    expect(sortStatesFromFilter([])).toEqual([]);
  });

  it('prefixes attr names with `attributes.` and preserves direction', () => {
    expect(
      sortStatesFromFilter([
        { attr: 'status', dir: 'asc' },
        { attr: 'title', dir: 'desc' },
      ]),
    ).toEqual([
      { field: 'attributes.status', direction: 'asc' },
      { field: 'attributes.title', direction: 'desc' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* effectiveSort                                                              */
/* -------------------------------------------------------------------------- */

describe('effectiveSort', () => {
  const filterSort: SortState[] = [
    { field: 'attributes.status', direction: 'asc' },
    { field: 'attributes.title', direction: 'asc' },
  ];

  it('returns [] when both header and filter are empty', () => {
    expect(effectiveSort(null, [])).toEqual([]);
  });

  it('falls back to filter sort when header sort is null', () => {
    expect(effectiveSort(null, filterSort)).toEqual(filterSort);
  });

  it('header click overrides the entire filter sort', () => {
    const header: SortState = { field: 'created_at', direction: 'desc' };
    expect(effectiveSort(header, filterSort)).toEqual([header]);
  });

  it('clearing the header click (null) restores the filter sort', () => {
    // simulates cycleSort → null after a desc click
    expect(effectiveSort(null, filterSort)).toEqual(filterSort);
  });
});

/* -------------------------------------------------------------------------- */
/* applyFilterToTree                                                          */
/* -------------------------------------------------------------------------- */

describe('applyFilterToTree', () => {
  it('returns the base tree unchanged when predicate is null', () => {
    const base = { connective: 'and', children: [] };
    expect(applyFilterToTree(null, base)).toBe(base);
  });

  it('returns undefined when both predicate and base tree are absent', () => {
    expect(applyFilterToTree(null, undefined)).toBeUndefined();
  });

  it('wraps a bare leaf in a one-child AND group', () => {
    const leaf = eq('status', 'todo');
    const tree = applyFilterToTree(leaf, undefined);
    expect(tree).toEqual({
      connective: 'and',
      children: [predicateToJson(leaf)],
    });
  });

  it('emits a group predicate verbatim via predicateToJson', () => {
    const grp: Predicate = andOf([
      eq('status', 'doing'),
      in_('assignee', [1, 2]),
    ]);
    expect(applyFilterToTree(grp, undefined)).toEqual(predicateToJson(grp));
  });

  it('drops the base tree when an explicit predicate is provided', () => {
    // applyFilterToTree replaces the base when a predicate is supplied —
    // the base is only used as a passthrough when the user has no filter.
    const base = { connective: 'and', children: [] };
    const leaf = eq('status', 'done');
    const tree = applyFilterToTree(leaf, base);
    expect(tree).not.toBe(base);
    expect(tree).toEqual({
      connective: 'and',
      children: [predicateToJson(leaf)],
    });
  });

  it('round-trips through predicateToJson for a NOT group', () => {
    const grp: Predicate = {
      kind: 'group',
      connective: 'not',
      children: [eq('status', 'done')],
    };
    expect(applyFilterToTree(grp, undefined)).toEqual(predicateToJson(grp));
  });
});

/* -------------------------------------------------------------------------- */
/* walkGrouped                                                                */
/*                                                                            */
/* Walk-and-emit: takes rows in their input order (which under the unified    */
/* ordering pipeline is the server's order with group_attr prepended) and     */
/* emits a header whenever the group_attr value changes. Bucket order =       */
/* server order; no client-side resorting.                                    */
/* -------------------------------------------------------------------------- */

describe('walkGrouped', () => {
  type Row = { attributes: Record<string, unknown>; id: string };
  const r = (id: string, attrs: Record<string, unknown> = {}): Row => ({
    id,
    attributes: attrs,
  });
  const passthrough = (v: unknown): string => String(v);

  it('returns rows-only when attrName is null (no headers)', () => {
    const rows = [r('a'), r('b')];
    expect(walkGrouped(rows, null, passthrough)).toEqual([
      { kind: 'row', row: rows[0], idx: 0 },
      { kind: 'row', row: rows[1], idx: 1 },
    ]);
  });

  it('preserves input order exactly — bucket order = server order', () => {
    // Server already ordered by status, so the input arrives clustered
    // in server order. Walk emits headers on value change and rows in
    // place.
    const rows = [
      r('3', { status: 'closed' }),
      r('1', { status: 'open' }),
      r('2', { status: 'open' }),
    ];
    const headers = walkGrouped(rows, 'status', passthrough)
      .filter((e) => e.kind === 'header')
      .map((e) => (e.kind === 'header' ? e.label : ''));
    expect(headers).toEqual(['closed', 'open']);
  });

  it('reversing input order reverses bucket order (group direction flip)', () => {
    // Same input data as above with reverse server order — the walk
    // reflects it directly, no resort.
    const rows = [
      r('1', { status: 'open' }),
      r('2', { status: 'open' }),
      r('3', { status: 'closed' }),
    ];
    const headers = walkGrouped(rows, 'status', passthrough)
      .filter((e) => e.kind === 'header')
      .map((e) => (e.kind === 'header' ? e.label : ''));
    expect(headers).toEqual(['open', 'closed']);
  });

  it('row idx is the position in the rows-only sequence', () => {
    const rows = [r('1', { s: 'a' }), r('2', { s: 'a' }), r('3', { s: 'b' })];
    const out = walkGrouped(rows, 's', passthrough);
    const rowEntries = out.filter((e) => e.kind === 'row');
    expect(rowEntries.map((e) => (e.kind === 'row' ? e.idx : -1))).toEqual([0, 1, 2]);
  });

  it('null / undefined / empty values cluster in the "—" bucket', () => {
    const rows = [
      r('a', { milestone_ref: 'M1' }),
      r('b', {}),
      r('c', { milestone_ref: null }),
      r('d', { milestone_ref: '' }),
    ];
    const headers = walkGrouped(rows, 'milestone_ref', passthrough)
      .filter((e) => e.kind === 'header')
      .map((e) => (e.kind === 'header' ? e.label : ''));
    expect(headers).toEqual(['M1', '—']);
  });

  it('emits a fresh header when the same value reappears non-contiguously', () => {
    // Caller is responsible for pre-clustering. If they pass mixed
    // order, the walk emits a header for each run — that's the
    // contract (and what alerts the caller they forgot to sort).
    const rows = [r('1', { s: 'a' }), r('2', { s: 'b' }), r('3', { s: 'a' })];
    const headers = walkGrouped(rows, 's', passthrough)
      .filter((e) => e.kind === 'header')
      .map((e) => (e.kind === 'header' ? e.label : ''));
    expect(headers).toEqual(['a', 'b', 'a']);
  });

  it('labelOf resolves card_ref-shaped keys (bigint) to display titles', () => {
    const rows = [
      r('1', { milestone_ref: 5n }),
      r('2', { milestone_ref: 7n }),
    ];
    const titles: Record<string, string> = { '5': 'Alpha', '7': 'Bravo' };
    const headers = walkGrouped(
      rows,
      'milestone_ref',
      (v) => titles[String(v)] ?? String(v),
    )
      .filter((e) => e.kind === 'header')
      .map((e) => (e.kind === 'header' ? e.label : ''));
    expect(headers).toEqual(['Alpha', 'Bravo']);
  });
});

/* -------------------------------------------------------------------------- */
/* compareGroupKey                                                            */
/* -------------------------------------------------------------------------- */

describe('compareGroupKey', () => {
  it('sorts bigints numerically (not lexically)', () => {
    expect(compareGroupKey(10n, 2n)).toBeGreaterThan(0);
    expect(compareGroupKey(2n, 10n)).toBeLessThan(0);
    expect(compareGroupKey(5n, 5n)).toBe(0);
  });

  it('sorts strings lexically', () => {
    expect(compareGroupKey('alpha', 'beta')).toBeLessThan(0);
    expect(compareGroupKey('beta', 'alpha')).toBeGreaterThan(0);
  });

  it('treats empty values as last (regardless of the other side)', () => {
    expect(compareGroupKey(null, 'anything')).toBeGreaterThan(0);
    expect(compareGroupKey('anything', null)).toBeLessThan(0);
    expect(compareGroupKey(undefined, 5n)).toBeGreaterThan(0);
    expect(compareGroupKey('', 5n)).toBeGreaterThan(0);
    expect(compareGroupKey(null, undefined)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* expandRowsForArrayGroup                                                    */
/* -------------------------------------------------------------------------- */

describe('expandRowsForArrayGroup', () => {
  type Row = { id: string; attributes: Record<string, unknown> };
  const r = (id: string, attrs: Record<string, unknown>): Row => ({ id, attributes: attrs });

  it('expands a multi-tag row into one entry per tag', () => {
    const rows = [r('1', { tags: [1n, 2n], title: 'A' })];
    const out = expandRowsForArrayGroup(rows, 'tags', 'asc');
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.attributes['tags'])).toEqual([1n, 2n]);
    // Other attributes survive the expansion.
    expect(out.every((x) => x.attributes['title'] === 'A')).toBe(true);
    // Original id is preserved so the row click still opens the right card.
    expect(out.every((x) => x.id === '1')).toBe(true);
  });

  it('emits one "—" entry for an empty / missing array', () => {
    const rows = [r('1', { tags: [], title: 'A' }), r('2', { title: 'B' })];
    const out = expandRowsForArrayGroup(rows, 'tags', 'asc');
    expect(out).toHaveLength(2);
    expect(out.every((x) => x.attributes['tags'] === null)).toBe(true);
  });

  it('sorts the expansion by element value, respecting groupDir', () => {
    const rows = [
      r('1', { tags: [3n] }),
      r('2', { tags: [1n] }),
      r('3', { tags: [2n] }),
    ];
    const asc = expandRowsForArrayGroup(rows, 'tags', 'asc');
    expect(asc.map((x) => x.attributes['tags'])).toEqual([1n, 2n, 3n]);
    const desc = expandRowsForArrayGroup(rows, 'tags', 'desc');
    expect(desc.map((x) => x.attributes['tags'])).toEqual([3n, 2n, 1n]);
  });

  it('empties go to the end regardless of direction', () => {
    const rows = [
      r('1', { tags: [1n] }),
      r('2', {}),
      r('3', { tags: [2n] }),
    ];
    const asc = expandRowsForArrayGroup(rows, 'tags', 'asc');
    expect(asc.map((x) => x.attributes['tags'])).toEqual([1n, 2n, null]);
    const desc = expandRowsForArrayGroup(rows, 'tags', 'desc');
    expect(desc.map((x) => x.attributes['tags'])).toEqual([2n, 1n, null]);
  });
});

/* -------------------------------------------------------------------------- */
/* tag-prefix helpers                                                         */
/* -------------------------------------------------------------------------- */

describe('tagPrefixSortField / isTagPrefixSortField / tagPrefixFromSortField', () => {
  it('round-trips a prefix through the synthetic field marker', () => {
    const f = tagPrefixSortField('priority');
    expect(f).toBe('tag_prefix:priority');
    expect(isTagPrefixSortField(f)).toBe(true);
    expect(tagPrefixFromSortField(f)).toBe('priority');
  });

  it('returns false / null for real wire fields', () => {
    expect(isTagPrefixSortField('attributes.title')).toBe(false);
    expect(isTagPrefixSortField('created_at')).toBe(false);
    expect(tagPrefixFromSortField('attributes.title')).toBeNull();
  });
});

describe('pickTagForPrefix', () => {
  const tagPaths: Record<string, string> = {
    '1': 'priority/high',
    '2': 'area/frontend',
    '3': 'team/platform',
    '4': 'priority',
    '5': 'priorityX/strange',
  };

  it('returns the first tag whose path matches `<prefix>/<value>`', () => {
    expect(pickTagForPrefix([1n, 2n], tagPaths, 'priority')).toBe(
      'priority/high',
    );
  });

  it('matches a bare prefix path (path === prefix, no slash)', () => {
    expect(pickTagForPrefix([4n], tagPaths, 'priority')).toBe('priority');
  });

  it('does not match an adjacent prefix-like substring (priorityX)', () => {
    expect(pickTagForPrefix([5n], tagPaths, 'priority')).toBeUndefined();
  });

  it('returns undefined when no tag matches the prefix', () => {
    expect(pickTagForPrefix([2n, 3n], tagPaths, 'priority')).toBeUndefined();
  });

  it('returns undefined when the tag attribute is not an array', () => {
    expect(pickTagForPrefix(undefined, tagPaths, 'priority')).toBeUndefined();
    expect(pickTagForPrefix(null, tagPaths, 'priority')).toBeUndefined();
    expect(pickTagForPrefix('priority/high', tagPaths, 'priority')).toBeUndefined();
  });

  it('skips entries that are not bigint ids', () => {
    expect(
      pickTagForPrefix([null, undefined, 'priority/high', 1n], tagPaths, 'priority'),
    ).toBe('priority/high');
  });
});

describe('stripTagPrefix', () => {
  it('removes the leading `<prefix>/` from a matching path', () => {
    expect(stripTagPrefix('priority/high', 'priority')).toBe('high');
  });

  it('passes through paths that do not start with the prefix', () => {
    expect(stripTagPrefix('area/frontend', 'priority')).toBe('area/frontend');
  });

  it('handles a bare path equal to the prefix (no trailing slash)', () => {
    // The prefix-only path doesn't carry the trailing slash, so the
    // strip is a no-op — the caller renders the bare prefix as the
    // chip label, which is the only sensible thing to show.
    expect(stripTagPrefix('priority', 'priority')).toBe('priority');
  });
});

describe('compareTagPrefixValue', () => {
  it('sorts by the value portion (after the prefix is stripped)', () => {
    expect(compareTagPrefixValue('priority/high', 'priority/low', 'priority'))
      .toBeLessThan(0);
    expect(compareTagPrefixValue('priority/low', 'priority/high', 'priority'))
      .toBeGreaterThan(0);
  });

  it('treats undefined / empty as last (regardless of direction)', () => {
    expect(compareTagPrefixValue(undefined, 'priority/low', 'priority'))
      .toBeGreaterThan(0);
    expect(compareTagPrefixValue('priority/high', undefined, 'priority'))
      .toBeLessThan(0);
    expect(compareTagPrefixValue('', 'priority/low', 'priority'))
      .toBeGreaterThan(0);
    expect(compareTagPrefixValue(undefined, undefined, 'priority')).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Smoke import                                                               */
/* -------------------------------------------------------------------------- */

describe('GridLayout smoke import', () => {
  it('imports cleanly (component compiles)', async () => {
    const mod = await import('../../src/screens/GridLayout.svelte');
    expect(mod.default).toBeDefined();
  });
});

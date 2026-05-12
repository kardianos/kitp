/**
 * Unit coverage for the ProjectDetailScreen pure helpers.
 *
 * The vitest runner is node-only (no jsdom), so the .svelte component is
 * not mounted here — we exercise the extracted helpers in
 * `src/screens/project_detail_helpers.ts`. Real-DOM coverage of the
 * screen itself lands with the e2e journey suite.
 *
 * Coverage targets per task #17:
 *   1. `applyPredicateAndSort` — `predicate=null` returns input order
 *      unchanged when sort is degenerate; predicate filters; sort applies
 *      AFTER the filter.
 *   2. `editingPayload` — equal trimmed values yield `{changed:false}`;
 *      otherwise return the `attribute.update` payload (`cardId`,
 *      `attributeName`, `value`); empty trimmed `newValue` clears via
 *      `value: null`.
 *   3. `buildInitialBatch()` returns the locked sub-request count + shape.
 */

import { describe, expect, it } from 'vitest';

import { andOf, eq, exists, ne } from '../../src/filter/predicate.js';
import type { CardWithAttrs } from '../../src/reg/types.js';
import {
  applyPredicateAndSort,
  buildInitialBatch,
  editingPayload,
  initialBatchCount,
} from '../../src/screens/project_detail_helpers.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function task(
  id: bigint,
  title: string,
  attrs: Record<string, unknown> = {},
): CardWithAttrs {
  return {
    id,
    card_type_id: 2n,
    card_type_name: 'task',
    attributes: { title, ...attrs },
  };
}

const FIXTURES: CardWithAttrs[] = [
  task(3n, 'gamma', { status: 'doing', assignee: 1n }),
  task(1n, 'alpha', { status: 'todo' }),
  task(4n, 'delta', { status: 'done', assignee: 2n }),
  task(2n, 'beta', { status: 'doing', assignee: 1n }),
];

/* -------------------------------------------------------------------------- */
/* applyPredicateAndSort                                                      */
/* -------------------------------------------------------------------------- */

describe('applyPredicateAndSort', () => {
  it('predicate=null with empty sort field returns input order unchanged', () => {
    const out = applyPredicateAndSort(FIXTURES, null, '');
    expect(out.map((c) => c.id)).toEqual([3n, 1n, 4n, 2n]);
  });

  it('predicate=null + sort by id sorts ascending without filtering', () => {
    const out = applyPredicateAndSort(FIXTURES, null, 'id');
    expect(out.map((c) => c.id)).toEqual([1n, 2n, 3n, 4n]);
  });

  it('predicate filters by single leaf (eq)', () => {
    const out = applyPredicateAndSort(FIXTURES, eq('status', 'doing'), 'id');
    expect(out.map((c) => c.id)).toEqual([2n, 3n]);
  });

  it('predicate ne keeps non-matching rows', () => {
    const out = applyPredicateAndSort(FIXTURES, ne('status', 'doing'), 'id');
    expect(out.map((c) => c.id)).toEqual([1n, 4n]);
  });

  it('predicate exists discriminates on attribute presence', () => {
    const out = applyPredicateAndSort(FIXTURES, exists('assignee'), 'id');
    expect(out.map((c) => c.id)).toEqual([2n, 3n, 4n]);
  });

  it('predicate (flat AND) applies conjunctively, then sort', () => {
    // Filter to status='doing' AND assignee=1 → ids {2,3}; sort by id.
    const both = andOf([eq('status', 'doing'), eq('assignee', 1n)]);
    const out = applyPredicateAndSort(FIXTURES, both, 'id');
    expect(out.map((c) => c.id)).toEqual([2n, 3n]);
  });

  it('sort applies AFTER filter (not before)', () => {
    // status='doing' is matched by ids {2,3}; sort by title gives
    // [beta(2), gamma(3)]. If sort happened before filtering we'd get
    // a different sequence.
    const out = applyPredicateAndSort(FIXTURES, eq('status', 'doing'), 'title');
    expect(out.map((c) => c.id)).toEqual([2n, 3n]);
    expect(out.map((c) => c.attributes['title'])).toEqual(['beta', 'gamma']);
  });

  it('sort places missing values after present ones', () => {
    // assignee is absent on id=1; ids {2,3,4} have it.
    const out = applyPredicateAndSort(FIXTURES, null, 'assignee');
    const ids = out.map((c) => c.id);
    // Last must be id=1 (missing assignee). The first three have
    // assignee 1, 1, 2 → sort yields [2 or 3, 2 or 3, 4].
    expect(ids[ids.length - 1]).toBe(1n);
    // Sort bigints with a comparator (Array.sort default coerces to string).
    expect(
      ids.slice(0, 3).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual([2n, 3n, 4n]);
  });

  it('returns [] for an empty input regardless of predicate / sort', () => {
    expect(applyPredicateAndSort([], null, '')).toEqual([]);
    expect(applyPredicateAndSort([], eq('status', 'doing'), 'id')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* editingPayload                                                             */
/* -------------------------------------------------------------------------- */

describe('editingPayload', () => {
  it('returns {changed:false} when trimmed values are equal', () => {
    expect(editingPayload(7n, 'title', 'foo', 'foo')).toEqual({ changed: false });
    expect(editingPayload(7n, 'title', 'foo', '  foo  ')).toEqual({
      changed: false,
    });
    expect(editingPayload(7n, 'title', '  foo', 'foo  ')).toEqual({
      changed: false,
    });
  });

  it('returns {changed:false} when both sides are empty/null/undefined', () => {
    expect(editingPayload(7n, 'description', undefined, '')).toEqual({
      changed: false,
    });
    expect(editingPayload(7n, 'description', null, '   ')).toEqual({
      changed: false,
    });
    expect(editingPayload(7n, 'description', '', '')).toEqual({ changed: false });
  });

  it('returns the attribute.update payload when the value changes', () => {
    const r = editingPayload(42n, 'title', 'old', 'new');
    expect(r.changed).toBe(true);
    if (r.changed) {
      expect(r.payload).toEqual({
        cardId: 42n,
        attributeName: 'title',
        value: 'new',
      });
    }
  });

  it('trims the new value before sending it on the wire', () => {
    const r = editingPayload(42n, 'title', 'old', '  new  ');
    expect(r.changed).toBe(true);
    if (r.changed) {
      expect(r.payload.value).toBe('new');
    }
  });

  it('treats blank-out (current=present, new=empty) as a clear (value:null)', () => {
    const r = editingPayload(42n, 'description', 'something', '   ');
    expect(r.changed).toBe(true);
    if (r.changed) {
      expect(r.payload).toEqual({
        cardId: 42n,
        attributeName: 'description',
        value: null,
      });
    }
  });

  it('preserves non-string values (numbers, booleans) unchanged', () => {
    const r = editingPayload(42n, 'priority', 1, 5);
    expect(r.changed).toBe(true);
    if (r.changed) {
      expect(r.payload.value).toBe(5);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* buildInitialBatch                                                          */
/* -------------------------------------------------------------------------- */

describe('buildInitialBatch', () => {
  it('returns the documented sub-request count', () => {
    const batch = buildInitialBatch();
    expect(batch).toHaveLength(initialBatchCount);
  });

  it('covers the project, task, person, ref-card, and attribute_def fetches', () => {
    const batch = buildInitialBatch();
    const keys = batch.map((b) => `${b.endpoint}.${b.action}`);
    // 6 card.select_with_attributes (project, tasks, persons,
    // milestones, components, tags), 1 attribute_def.select. The
    // legacy user.select has been replaced by a persons fetch —
    // assignee is now a card_ref to a `person` card, not a
    // user_account ref.
    expect(
      keys.filter((k) => k === 'card.select_with_attributes').length,
    ).toBe(6);
    expect(keys.filter((k) => k === 'user.select').length).toBe(0);
    expect(keys.filter((k) => k === 'attribute_def.select').length).toBe(1);
  });
});

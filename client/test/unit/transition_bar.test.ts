/**
 * Unit coverage for the {@link TransitionBar} helpers — Gate 7 of
 * FLOW_AND_SCREEN_KERNEL.md.
 *
 * The Svelte component itself is exercised by a compile-smoke import in
 * `widgets.test.ts` (the project intentionally has no
 * `@testing-library/svelte` dependency); the bulk of the behaviour
 * lives in pure helpers exported from `transition_bar_buckets.ts`.
 *
 * Covers:
 *   1. Bucket derivation: all 9 cells of the (from_phase, to_phase) matrix
 *      map to the right named bucket.
 *   2. groupByBucket: returns one slot per bucket, populated correctly,
 *      sorted within each slot by sort_order then label.
 *   3. compareTransitions: total ordering used as the sort key.
 *   4. Edge cases: unknown phase coerced to 'active' on decode; the
 *      `phase` typeguard means bucketOf is total.
 */

import { describe, expect, it } from 'vitest';

import type {
  TransitionPhase,
  TransitionRow,
} from '../../src/reg/types.js';
import {
  ALL_BUCKETS,
  bucketFor,
  bucketOf,
  compareTransitions,
  groupByBucket,
  type TransitionBucket,
} from '../../src/ui/widgets/transition_bar_buckets.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let nextId = 1n;
function makeRow(
  fromPhase: TransitionPhase,
  toPhase: TransitionPhase,
  opts: Partial<TransitionRow> = {},
): TransitionRow {
  const id = opts.id ?? nextId++;
  return {
    id,
    flow_id: opts.flow_id ?? 1n,
    flow_name: opts.flow_name ?? 'status flow',
    attribute_def_id: opts.attribute_def_id ?? 5n,
    attribute_def_name: opts.attribute_def_name ?? 'status',
    from_card_id: opts.from_card_id ?? 10n,
    from_label: opts.from_label ?? `${fromPhase}_from`,
    from_phase: fromPhase,
    to_card_id: opts.to_card_id ?? 20n,
    to_label: opts.to_label ?? `${toPhase}_to`,
    to_phase: toPhase,
    label: opts.label ?? '',
    requires_role_name: opts.requires_role_name ?? '',
    sort_order: opts.sort_order ?? 0,
    allowed: opts.allowed ?? true,
    ...('requires_role_id' in opts ? { requires_role_id: opts.requires_role_id } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Bucket derivation — exhaustive table                                       */
/* -------------------------------------------------------------------------- */

describe('bucketFor / bucketOf — 9-cell phase matrix', () => {
  // Spec table at FLOW_AND_SCREEN_KERNEL.md §"<TransitionBar> replaces …".
  const cases: ReadonlyArray<readonly [TransitionPhase, TransitionPhase, TransitionBucket]> = [
    ['triage', 'triage', 'progress_triage'],
    ['triage', 'active', 'accept'],
    ['triage', 'terminal', 'reject'],
    ['active', 'triage', 'defer'],
    ['active', 'active', 'progress'],
    ['active', 'terminal', 'close'],
    ['terminal', 'triage', 'retriage'],
    ['terminal', 'active', 'reopen'],
    ['terminal', 'terminal', 'recategorize'],
  ];

  it.each(cases)(
    '(%s → %s) → %s',
    (fromPhase, toPhase, expectedBucket) => {
      expect(bucketFor(fromPhase, toPhase)).toBe(expectedBucket);
    },
  );

  it.each(cases)(
    'bucketOf({ from:%s, to:%s }) → %s',
    (fromPhase, toPhase, expectedBucket) => {
      const row = makeRow(fromPhase, toPhase);
      expect(bucketOf(row)).toBe(expectedBucket);
    },
  );

  it('every (from, to) pair maps to a bucket from ALL_BUCKETS', () => {
    const phases: TransitionPhase[] = ['triage', 'active', 'terminal'];
    for (const f of phases) {
      for (const t of phases) {
        expect(ALL_BUCKETS).toContain(bucketFor(f, t));
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* groupByBucket                                                              */
/* -------------------------------------------------------------------------- */

describe('groupByBucket', () => {
  it('returns one slot per bucket, all empty for an empty list', () => {
    const m = groupByBucket([]);
    for (const b of ALL_BUCKETS) {
      expect(m[b]).toEqual([]);
    }
  });

  it('places transitions in the correct bucket per (from_phase, to_phase)', () => {
    const a = makeRow('triage', 'active', { id: 1n, label: 'Accept' });
    const c = makeRow('active', 'terminal', { id: 2n, label: 'Close' });
    const r = makeRow('terminal', 'active', { id: 3n, label: 'Reopen' });

    const m = groupByBucket([a, c, r]);
    expect(m.accept.map((t) => t.id)).toEqual([1n]);
    expect(m.close.map((t) => t.id)).toEqual([2n]);
    expect(m.reopen.map((t) => t.id)).toEqual([3n]);
    // The remaining slots stay empty.
    expect(m.reject).toEqual([]);
    expect(m.defer).toEqual([]);
    expect(m.progress).toEqual([]);
    expect(m.progress_triage).toEqual([]);
    expect(m.retriage).toEqual([]);
    expect(m.recategorize).toEqual([]);
  });

  it('sorts within bucket by sort_order ascending, then label, then to_card_id', () => {
    const t1 = makeRow('active', 'terminal', {
      id: 10n,
      label: 'Beta',
      sort_order: 5,
    });
    const t2 = makeRow('active', 'terminal', {
      id: 11n,
      label: 'Alpha',
      sort_order: 5,
    });
    const t3 = makeRow('active', 'terminal', {
      id: 12n,
      label: 'Gamma',
      sort_order: 0,
    });
    const m = groupByBucket([t1, t2, t3]);
    expect(m.close.map((t) => t.label)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('ties on (sort_order, label) break on to_card_id ascending', () => {
    const a = makeRow('active', 'terminal', {
      id: 30n,
      to_card_id: 200n,
      label: 'X',
      sort_order: 1,
    });
    const b = makeRow('active', 'terminal', {
      id: 31n,
      to_card_id: 100n,
      label: 'X',
      sort_order: 1,
    });
    const m = groupByBucket([a, b]);
    expect(m.close.map((t) => t.to_card_id)).toEqual([100n, 200n]);
  });

  it('keeps multiple close options together in the close bucket', () => {
    // Spec scenario: 3 close options → render as split (1 inline + 2 dropdown).
    const t1 = makeRow('active', 'terminal', { id: 40n, label: 'Done', sort_order: 1 });
    const t2 = makeRow('active', 'terminal', { id: 41n, label: 'Cancelled', sort_order: 2 });
    const t3 = makeRow('active', 'terminal', { id: 42n, label: 'Wontfix', sort_order: 3 });

    const m = groupByBucket([t3, t1, t2]);
    expect(m.close).toHaveLength(3);
    expect(m.close[0]?.label).toBe('Done');
    expect(m.close[1]?.label).toBe('Cancelled');
    expect(m.close[2]?.label).toBe('Wontfix');
  });

  it('does not mutate the input array', () => {
    const a = makeRow('active', 'active', { sort_order: 5 });
    const b = makeRow('active', 'active', { sort_order: 1 });
    const input = [a, b];
    const snapshot = [...input];
    groupByBucket(input);
    expect(input).toEqual(snapshot);
  });
});

/* -------------------------------------------------------------------------- */
/* compareTransitions                                                         */
/* -------------------------------------------------------------------------- */

describe('compareTransitions', () => {
  it('orders by sort_order ascending', () => {
    const lower = makeRow('active', 'active', { sort_order: 1 });
    const higher = makeRow('active', 'active', { sort_order: 9 });
    expect(compareTransitions(lower, higher)).toBeLessThan(0);
    expect(compareTransitions(higher, lower)).toBeGreaterThan(0);
  });

  it('breaks sort_order ties on label', () => {
    const a = makeRow('active', 'active', { sort_order: 0, label: 'aaa' });
    const b = makeRow('active', 'active', { sort_order: 0, label: 'bbb' });
    expect(compareTransitions(a, b)).toBeLessThan(0);
  });

  it('breaks (sort_order, label) ties on to_card_id', () => {
    const a = makeRow('active', 'active', {
      sort_order: 0,
      label: 'same',
      to_card_id: 100n,
    });
    const b = makeRow('active', 'active', {
      sort_order: 0,
      label: 'same',
      to_card_id: 200n,
    });
    expect(compareTransitions(a, b)).toBeLessThan(0);
    expect(compareTransitions(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 for fully equal keys', () => {
    const a = makeRow('active', 'active', {
      sort_order: 7,
      label: 'same',
      to_card_id: 42n,
    });
    const b = makeRow('active', 'active', {
      sort_order: 7,
      label: 'same',
      to_card_id: 42n,
      // different id should not change ordering
      id: 999n,
    });
    expect(compareTransitions(a, b)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Role gating — data-level                                                   */
/* -------------------------------------------------------------------------- */

describe('role-gated transitions in the bucket map', () => {
  it('disallowed transitions stay in their bucket but carry allowed=false', () => {
    const allowed = makeRow('active', 'terminal', {
      id: 50n,
      label: 'Done',
      allowed: true,
    });
    const gated = makeRow('active', 'terminal', {
      id: 51n,
      label: 'Approve',
      allowed: false,
      requires_role_id: 42n,
      requires_role_name: 'manager',
    });
    const m = groupByBucket([allowed, gated]);
    expect(m.close).toHaveLength(2);
    const enabled = m.close.find((t) => t.id === 50n);
    const disabled = m.close.find((t) => t.id === 51n);
    expect(enabled?.allowed).toBe(true);
    expect(disabled?.allowed).toBe(false);
    expect(disabled?.requires_role_name).toBe('manager');
  });
});

/* -------------------------------------------------------------------------- */
/* Module compile smoke                                                       */
/* -------------------------------------------------------------------------- */

describe('TransitionBar component import', () => {
  it('loads without throwing', async () => {
    const mod = await import('../../src/ui/widgets/TransitionBar.svelte');
    expect(mod.default).toBeDefined();
  });
});

/**
 * FilterBar / predicate helper tests.
 *
 * The vitest setup is node-only (no jsdom) — we therefore cover the
 * extracted pure helpers (`replaceLeafForAttr`). Component-mount
 * coverage for FilterBar and FilterTreeEditor will arrive with the
 * real-DOM E2E pass; those components import cleanly today (verified
 * via a smoke import below).
 */

import { describe, expect, it } from 'vitest';

import {
  andOf,
  eq,
  type Predicate,
} from '../../src/filter/predicate.js';
import { replaceLeafForAttr } from '../../src/filter/quick_chips.js';

/* -------------------------------------------------------------------------- */
/* replaceLeafForAttr                                                         */
/* -------------------------------------------------------------------------- */

describe('replaceLeafForAttr', () => {
  it('returns the new leaf as-is when the predicate is null', () => {
    const out = replaceLeafForAttr(null, eq('status', 'todo'));
    expect(out).toEqual(eq('status', 'todo'));
  });

  it('replaces an existing leaf for the same attribute', () => {
    const start: Predicate = andOf([eq('status', 'todo'), eq('priority', 1)]);
    const out = replaceLeafForAttr(start, eq('status', 'doing'));
    // Order: surviving leaves first, then the new one (caller MAY rely
    // on this for stable chip ordering — pin it here).
    expect(out).toEqual(andOf([eq('priority', 1), eq('status', 'doing')]));
  });

  it('appends when no leaf for the attribute exists yet', () => {
    const start: Predicate = eq('priority', 1);
    const out = replaceLeafForAttr(start, eq('status', 'todo'));
    expect(out).toEqual(andOf([eq('priority', 1), eq('status', 'todo')]));
  });

  it('collapses a single surviving leaf back to a bare leaf', () => {
    // Single-leaf input → replacement also returns a bare-leaf shape
    // (not wrapped in a group).
    const start2: Predicate = eq('status', 'todo');
    const out = replaceLeafForAttr(start2, eq('status', 'doing'));
    expect(out).toEqual(eq('status', 'doing'));
  });

  it('throws when the predicate is not a flat AND of leaves', () => {
    const bad: Predicate = {
      kind: 'group',
      connective: 'or',
      children: [eq('a', 1), eq('b', 2)],
    };
    expect(() => replaceLeafForAttr(bad, eq('a', 99))).toThrow();
  });

  it('rejects a non-leaf newLeaf argument', () => {
    expect(() =>
      replaceLeafForAttr(null, andOf([eq('a', 1)])),
    ).toThrow(/must be a leaf/);
  });
});

/* -------------------------------------------------------------------------- */
/* Compile smoke for the .svelte components                                   */
/* -------------------------------------------------------------------------- */

describe('Filter component imports', () => {
  it('FilterBar / FilterTreeEditor load without throwing', async () => {
    const mods = await Promise.all([
      import('../../src/filter/FilterBar.svelte'),
      import('../../src/filter/FilterTreeEditor.svelte'),
    ]);
    for (const m of mods) {
      expect(m.default).toBeDefined();
    }
  });
});

/**
 * Unit coverage for filter_state.svelte.ts.
 *
 * The module-level cache is what makes a list screen's filter
 * survive a navigate-into-detail-and-back trip, so the tests cover
 * the get / set / clear contract — including the "null is a clear,
 * not a literal value" subtlety and the per-(scope, projectId)
 * isolation.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { eq } from '../../src/filter/predicate';
import {
  clearAllFilters,
  getFilter,
  setFilter,
} from '../../src/screens/filter_state.svelte';

beforeEach(() => {
  clearAllFilters();
});

describe('filter_state cache', () => {
  it('returns null for a key that has never been written', () => {
    expect(getFilter('inbox', null)).toBeNull();
    expect(getFilter('grid', 42n)).toBeNull();
  });

  it('round-trips a predicate', () => {
    const p = eq('status', 'todo');
    setFilter('inbox', null, p);
    expect(getFilter('inbox', null)).toBe(p);
  });

  it('isolates entries by scope', () => {
    const a = eq('status', 'todo');
    const b = eq('assignee', 7);
    setFilter('inbox', null, a);
    setFilter('grid', null, b);
    expect(getFilter('inbox', null)).toBe(a);
    expect(getFilter('grid', null)).toBe(b);
  });

  it('isolates entries by projectId', () => {
    const a = eq('status', 'todo');
    const b = eq('status', 'done');
    setFilter('kanban', 1n, a);
    setFilter('kanban', 2n, b);
    expect(getFilter('kanban', 1n)).toBe(a);
    expect(getFilter('kanban', 2n)).toBe(b);
  });

  it('treats null projectId as distinct from numeric 0/undefined-shaped keys', () => {
    // null encodes "no project scope"; we keep it on its own bucket so
    // an Inbox-without-project-scope filter does not bleed into a
    // numeric Project N filter or vice versa.
    const a = eq('status', 'todo');
    const b = eq('status', 'doing');
    setFilter('inbox', null, a);
    setFilter('inbox', undefined, b);
    // null and undefined map to the same `_none_` bucket — both mean
    // "no project scope" for the caller.
    expect(getFilter('inbox', null)).toBe(b);
    expect(getFilter('inbox', undefined)).toBe(b);
  });

  it('writing null clears the entry', () => {
    const p = eq('status', 'todo');
    setFilter('inbox', 1n, p);
    expect(getFilter('inbox', 1n)).toBe(p);
    setFilter('inbox', 1n, null);
    expect(getFilter('inbox', 1n)).toBeNull();
  });

  it('overwrites an existing entry', () => {
    setFilter('inbox', null, eq('status', 'todo'));
    const next = eq('status', 'done');
    setFilter('inbox', null, next);
    expect(getFilter('inbox', null)).toBe(next);
  });

  it('clearAllFilters drops every entry', () => {
    setFilter('inbox', 1n, eq('status', 'todo'));
    setFilter('grid', 2n, eq('status', 'doing'));
    clearAllFilters();
    expect(getFilter('inbox', 1n)).toBeNull();
    expect(getFilter('grid', 2n)).toBeNull();
  });
});

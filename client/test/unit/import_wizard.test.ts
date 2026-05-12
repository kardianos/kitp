/**
 * Unit coverage for the import-wizard helpers. The CSV upload path is
 * exercised end-to-end by the Go integration tests; here we focus on
 * the pure-TS pieces that the Svelte component delegates to.
 */

import { describe, expect, it } from 'vitest';

import {
  autoMapping,
  IGNORE_COLUMN,
  TARGET_ATTRS,
} from '../../src/screens/admin/import_wizard.js';

describe('autoMapping', () => {
  it('snake_case-matches every known target attribute', () => {
    const m = autoMapping([
      'id', 'title', 'status', 'assignee_email', 'assignee_name',
      'milestone', 'component', 'tags', 'description', 'sort_order',
    ]);
    for (const name of TARGET_ATTRS) {
      expect(m[name]).toBe(name);
    }
  });

  it('normalises spaces and hyphens to underscores', () => {
    const m = autoMapping(['Assignee Email', 'Assignee-Name', 'Sort Order']);
    expect(m['Assignee Email']).toBe('assignee_email');
    expect(m['Assignee-Name']).toBe('assignee_name');
    expect(m['Sort Order']).toBe('sort_order');
  });

  it('is case-insensitive on the header text', () => {
    const m = autoMapping(['TITLE', 'Milestone']);
    expect(m['TITLE']).toBe('title');
    expect(m['Milestone']).toBe('milestone');
  });

  it('routes unknown columns to the ignore sentinel', () => {
    const m = autoMapping(['weird', 'extra column', 'totally_unmapped']);
    expect(m['weird']).toBe(IGNORE_COLUMN);
    expect(m['extra column']).toBe(IGNORE_COLUMN);
    expect(m['totally_unmapped']).toBe(IGNORE_COLUMN);
  });

  it('preserves the original header text as the map key (case + spacing)', () => {
    // The wizard renders rows keyed by the CSV header text, so we
    // must not lose case/spaces — only the *target* on the right
    // side is normalised.
    const m = autoMapping(['Assignee Email']);
    expect(Object.keys(m)).toEqual(['Assignee Email']);
  });
});

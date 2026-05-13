/**
 * Unit coverage for the widget helpers in `src/ui/widgets/`.
 *
 * The vitest runner here is node-only (no jsdom), so the Svelte components
 * themselves are exercised by a compile-smoke import (matches the pattern
 * established by `ui.test.ts`). The bulk of the coverage lives on the
 * extracted .ts helpers — `time.ts`, `activity_text.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { ActivityRow } from '../../src/reg/types.js';
import {
  formatActivityText,
  humaniseAttribute,
  tagDiff,
} from '../../src/ui/widgets/activity_text.js';
import { formatRelativeTime } from '../../src/ui/widgets/time.js';

/* -------------------------------------------------------------------------- */
/* formatRelativeTime                                                         */
/* -------------------------------------------------------------------------- */

describe('formatRelativeTime', () => {
  // Anchor "now" so test deltas are deterministic.
  const now = new Date('2026-05-04T12:00:00Z');

  function isoMinus(seconds: number): string {
    return new Date(now.getTime() - seconds * 1000).toISOString();
  }

  it('30s -> just now', () => {
    expect(formatRelativeTime(isoMinus(30), now)).toBe('just now');
  });

  it('5m -> "5 minutes ago"', () => {
    expect(formatRelativeTime(isoMinus(5 * 60), now)).toBe('5 minutes ago');
  });

  it('1m -> "1 minute ago" (singular)', () => {
    expect(formatRelativeTime(isoMinus(60), now)).toBe('1 minute ago');
  });

  it('2h -> "2 hours ago"', () => {
    expect(formatRelativeTime(isoMinus(2 * 60 * 60), now)).toBe('2 hours ago');
  });

  it('1h -> "1 hour ago" (singular)', () => {
    expect(formatRelativeTime(isoMinus(60 * 60), now)).toBe('1 hour ago');
  });

  it('3d -> "3 days ago"', () => {
    expect(formatRelativeTime(isoMinus(3 * 86_400), now)).toBe('3 days ago');
  });

  it('1w -> "1 week ago"', () => {
    expect(formatRelativeTime(isoMinus(7 * 86_400), now)).toBe('1 week ago');
  });

  it('2w -> "2 weeks ago"', () => {
    expect(formatRelativeTime(isoMinus(14 * 86_400), now)).toBe('2 weeks ago');
  });

  it('60d -> "2 months ago"', () => {
    expect(formatRelativeTime(isoMinus(60 * 86_400), now)).toBe('2 months ago');
  });

  it('400d -> "1 year ago"', () => {
    expect(formatRelativeTime(isoMinus(400 * 86_400), now)).toBe('1 year ago');
  });

  it('clamps negative deltas to "just now"', () => {
    const future = new Date(now.getTime() + 60_000).toISOString();
    expect(formatRelativeTime(future, now)).toBe('just now');
  });

  it('returns the raw input on unparseable timestamps', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('not-a-date');
  });
});

/* -------------------------------------------------------------------------- */
/* humaniseAttribute                                                          */
/* -------------------------------------------------------------------------- */

describe('humaniseAttribute', () => {
  it('drops trailing _ref and replaces underscores with spaces', () => {
    expect(humaniseAttribute('milestone_ref')).toBe('milestone');
    expect(humaniseAttribute('component_ref')).toBe('component');
    expect(humaniseAttribute('sort_order')).toBe('sort order');
    expect(humaniseAttribute('status')).toBe('status');
  });
});

/* -------------------------------------------------------------------------- */
/* formatActivityText                                                         */
/* -------------------------------------------------------------------------- */

describe('formatActivityText', () => {
  const userNames: Record<number, string> = { 1: 'alice', 2: 'bob' };
  const cardTitles: Record<number, string> = { 100: 'M1', 200: 'API' };
  const tagPaths: Record<number, string> = { 10: 'priority/high', 11: 'area/ui' };

  function row(partial: Partial<ActivityRow>): ActivityRow {
    return {
      id: 1n,
      card_id: 999n,
      kind: 'card_create',
      actor_id: 1n,
      created_at: '2026-05-04T11:59:30Z',
      ...partial,
    };
  }

  it('card_create renders actor + verb', () => {
    expect(formatActivityText(row({ kind: 'card_create' }), userNames)).toBe(
      'alice created the card.',
    );
  });

  it('card_delete renders actor + verb', () => {
    expect(formatActivityText(row({ kind: 'card_delete' }), userNames)).toBe(
      'alice deleted the card.',
    );
  });

  it('comment renders actor + body', () => {
    const r = row({ kind: 'comment', comment_body: 'looks good!' });
    expect(formatActivityText(r, userNames)).toBe('alice commented: looks good!');
  });

  it('comment with missing body still renders cleanly', () => {
    const r = row({ kind: 'comment' });
    expect(formatActivityText(r, userNames)).toBe('alice commented: ');
  });

  it('attr_update on plain attribute uses humaniseAttribute', () => {
    const r = row({
      kind: 'attr_update',
      attribute_name: 'status',
      value_old: 'todo',
      value_new: 'doing',
    });
    expect(formatActivityText(r, userNames)).toBe(
      'alice changed status from todo to doing',
    );
  });

  it('attr_update on assignee resolves user ids', () => {
    const r = row({
      kind: 'attr_update',
      attribute_name: 'assignee',
      value_old: 1,
      value_new: 2,
    });
    expect(formatActivityText(r, userNames)).toBe(
      'alice changed assignee from alice to bob',
    );
  });

  it('attr_update on milestone_ref resolves card titles and humanises label', () => {
    const r = row({
      kind: 'attr_update',
      attribute_name: 'milestone_ref',
      value_old: null,
      value_new: 100,
    });
    expect(formatActivityText(r, userNames, cardTitles)).toBe(
      'alice changed milestone from ∅ to M1',
    );
  });

  it('attr_update description short-circuits to "edited the description"', () => {
    const r = row({ kind: 'attr_update', attribute_name: 'description' });
    expect(formatActivityText(r, userNames)).toBe('alice edited the description.');
  });

  it('attr_update sort_order short-circuits to "reordered the card"', () => {
    const r = row({ kind: 'attr_update', attribute_name: 'sort_order' });
    expect(formatActivityText(r, userNames)).toBe('alice reordered the card.');
  });

  it('tag_apply with a single new id uses "applied tag <name>"', () => {
    const r = row({
      kind: 'tag_apply',
      value_old: [],
      value_new: [10],
    });
    expect(formatActivityText(r, userNames, undefined, tagPaths)).toBe(
      'alice applied tag priority/high',
    );
  });

  it('tag_remove with a single removed id uses "removed tag <name>"', () => {
    const r = row({
      kind: 'tag_remove',
      value_old: [10, 11],
      value_new: [11],
    });
    expect(formatActivityText(r, userNames, undefined, tagPaths)).toBe(
      'alice removed tag priority/high',
    );
  });

  it('tag diff with both added and removed renders the combined form', () => {
    const r = row({
      kind: 'tag_apply',
      value_old: [10],
      value_new: [11],
    });
    expect(formatActivityText(r, userNames, undefined, tagPaths)).toBe(
      'alice applied area/ui and removed priority/high',
    );
  });

  it('tag diff with no-op falls back to "changed tags."', () => {
    const r = row({
      kind: 'tag_apply',
      value_old: [10],
      value_new: [10],
    });
    expect(formatActivityText(r, userNames, undefined, tagPaths)).toBe(
      'alice changed tags.',
    );
  });

  it('falls back to user#<id> when the user is missing', () => {
    const r = row({ actor_id: 99n, kind: 'card_create' });
    expect(formatActivityText(r)).toBe('user#99 created the card.');
  });

  it('unknown kind falls through to "<actor>: <kind>"', () => {
    const r = row({ kind: 'mystery_kind' });
    expect(formatActivityText(r, userNames)).toBe('alice: mystery_kind');
  });
});

/* -------------------------------------------------------------------------- */
/* tagDiff                                                                    */
/* -------------------------------------------------------------------------- */

describe('tagDiff', () => {
  const tagPaths: Record<number, string> = { 1: 'a', 2: 'b', 3: 'c' };

  function row(old_: unknown, new_: unknown): ActivityRow {
    return {
      id: 1n,
      card_id: 1n,
      kind: 'tag_apply',
      actor_id: 1n,
      created_at: '2026-01-01T00:00:00Z',
      value_old: old_,
      value_new: new_,
    };
  }

  it('returns added/removed display names', () => {
    const d = tagDiff(row([1, 2], [2, 3]), tagPaths);
    expect(d.added).toEqual(['c']);
    expect(d.removed).toEqual(['a']);
  });

  it('falls back to #<id> when path is missing', () => {
    const d = tagDiff(row([], [99]), tagPaths);
    expect(d.added).toEqual(['#99']);
    expect(d.removed).toEqual([]);
  });

  it('treats non-array fields as empty', () => {
    const d = tagDiff(row(undefined, [1]), tagPaths);
    expect(d.added).toEqual(['a']);
    expect(d.removed).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Compile smoke: every widget should import without throwing                 */
/* -------------------------------------------------------------------------- */

describe('widget imports', () => {
  it('every widget module loads', async () => {
    const mods = await Promise.all([
      import('../../src/ui/widgets/TaskRow.svelte'),
      import('../../src/ui/widgets/ActivityRow.svelte'),
      import('../../src/ui/widgets/AttributeChip.svelte'),
      import('../../src/ui/widgets/TagChip.svelte'),
      import('../../src/ui/widgets/AttributeSidePanel.svelte'),
      import('../../src/ui/widgets/TransitionBar.svelte'),
    ]);
    for (const m of mods) {
      expect(m.default).toBeDefined();
    }
  });
});

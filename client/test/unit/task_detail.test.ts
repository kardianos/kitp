/**
 * Vitest suite for `TaskDetailScreen` data-shaping helpers.
 *
 * The Svelte component itself is exercised by the e2e journey; the
 * project has no `@testing-library/svelte` dependency, so component
 * rendering is out of scope here. Instead we cover the pure helpers
 * extracted into `src/screens/task_detail_helpers.ts`:
 *
 *   1. `initialBatchSpec(taskId)` produces the seven-element ordered
 *      sub-request descriptor the screen uses on mount. Asserting the
 *      ordering + payload locks the dispatcher contract.
 *   2. `commitTitlePayload` and `commitDescriptionPayload` produce the
 *      attribute.update inputs (cardId + attributeName + value).
 *   3. `applyTagPayload` / `removeTagPayload` shape tag-mutation inputs.
 *   4. `commentInsertPayload` shapes the comment body.
 *   5. `sortActivityDesc` sorts a row list newest-first.
 *   6. `pickTaskById`, `userNameMap`, `cardTitleMap`, `tagPathMap`,
 *      `appliedTagIds` — small utility coverage so the screen's derived
 *      lookups have a tested baseline.
 */

import { describe, expect, it } from 'vitest';

import type { ActivityRow, CardWithAttrs, UserRow } from '../../src/reg/types.js';
import {
  ACTIVITY_LIMIT,
  appliedTagIds,
  applyTagPayload,
  attributeUpdatePayload,
  cardTitleMap,
  commentInsertPayload,
  commitDescriptionPayload,
  commitTitlePayload,
  initialBatchSpec,
  pickTaskById,
  removeTagPayload,
  sortActivityDesc,
  tagPathMap,
  userNameMap,
} from '../../src/screens/task_detail_helpers.js';

/* -------------------------------------------------------------------------- */
/* initialBatchSpec                                                            */
/* -------------------------------------------------------------------------- */

describe('initialBatchSpec', () => {
  const TASK_ID = 42;
  const spec = initialBatchSpec(TASK_ID);

  it('returns exactly seven sub-requests so the dispatcher coalesces one POST', () => {
    expect(spec).toHaveLength(7);
  });

  it('first sub-request is the task itself (card.select_with_attributes, type=task)', () => {
    expect(spec[0]).toMatchObject({
      endpoint: 'card',
      action: 'select_with_attributes',
      data: { cardTypeName: 'task' },
    });
  });

  it('second sub-request is the activity stream for this card', () => {
    expect(spec[1]).toMatchObject({
      endpoint: 'activity',
      action: 'select',
      data: { cardId: TASK_ID, limit: ACTIVITY_LIMIT },
    });
  });

  it('third sub-request fetches milestones', () => {
    expect(spec[2]).toMatchObject({
      endpoint: 'card',
      action: 'select_with_attributes',
      data: { cardTypeName: 'milestone' },
    });
  });

  it('fourth sub-request fetches components', () => {
    expect(spec[3]).toMatchObject({
      endpoint: 'card',
      action: 'select_with_attributes',
      data: { cardTypeName: 'component' },
    });
  });

  it('fifth sub-request fetches tags', () => {
    expect(spec[4]).toMatchObject({
      endpoint: 'card',
      action: 'select_with_attributes',
      data: { cardTypeName: 'tag' },
    });
  });

  it('sixth sub-request fetches users', () => {
    expect(spec[5]).toMatchObject({
      endpoint: 'user',
      action: 'select',
    });
  });

  it('seventh sub-request fetches the attribute_def schema', () => {
    expect(spec[6]).toMatchObject({
      endpoint: 'attribute_def',
      action: 'select',
    });
  });

  it('endpoint+action ordering is contractual', () => {
    const ids = spec.map((s) => `${s.endpoint}.${s.action}`);
    expect(ids).toEqual([
      'card.select_with_attributes', // task
      'activity.select',
      'card.select_with_attributes', // milestone
      'card.select_with_attributes', // component
      'card.select_with_attributes', // tag
      'user.select',
      'attribute_def.select',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* commitTitlePayload                                                          */
/* -------------------------------------------------------------------------- */

describe('commitTitlePayload', () => {
  it('shapes the attribute.update input for title', () => {
    expect(commitTitlePayload(7, 'New title')).toEqual({
      cardId: 7,
      attributeName: 'title',
      value: 'New title',
    });
  });

  it('preserves whitespace verbatim — trimming is the screen layer\'s job', () => {
    // The screen trims before reaching the helper; the helper itself is
    // a pure constructor with no side effects.
    expect(commitTitlePayload(1, '  spaced  ')).toEqual({
      cardId: 1,
      attributeName: 'title',
      value: '  spaced  ',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* commitDescriptionPayload                                                    */
/* -------------------------------------------------------------------------- */

describe('commitDescriptionPayload', () => {
  it('passes a non-empty description through unchanged', () => {
    expect(commitDescriptionPayload(9, 'hello\nworld')).toEqual({
      cardId: 9,
      attributeName: 'description',
      value: 'hello\nworld',
    });
  });

  it('clears the attribute (value=null) when the description is empty', () => {
    expect(commitDescriptionPayload(9, '')).toEqual({
      cardId: 9,
      attributeName: 'description',
      value: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* attributeUpdatePayload                                                      */
/* -------------------------------------------------------------------------- */

describe('attributeUpdatePayload', () => {
  it('shapes the wire input for arbitrary attributes', () => {
    expect(attributeUpdatePayload(11, 'status', 'doing')).toEqual({
      cardId: 11,
      attributeName: 'status',
      value: 'doing',
    });
  });

  it('round-trips null as a clear-attribute marker', () => {
    expect(attributeUpdatePayload(11, 'milestone_ref', null)).toEqual({
      cardId: 11,
      attributeName: 'milestone_ref',
      value: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* applyTagPayload / removeTagPayload                                          */
/* -------------------------------------------------------------------------- */

describe('applyTagPayload', () => {
  it('shapes tag.apply input as { targetCardId, tagCardId }', () => {
    expect(applyTagPayload(1, 99)).toEqual({
      targetCardId: 1,
      tagCardId: 99,
    });
  });
});

describe('removeTagPayload', () => {
  it('shapes tag.remove input as { targetCardId, tagCardId }', () => {
    expect(removeTagPayload(2, 88)).toEqual({
      targetCardId: 2,
      tagCardId: 88,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* commentInsertPayload                                                        */
/* -------------------------------------------------------------------------- */

describe('commentInsertPayload', () => {
  it('shapes comment.insert input', () => {
    expect(commentInsertPayload(7, 'looks good')).toEqual({
      cardId: 7,
      body: 'looks good',
    });
  });

  it('preserves whitespace and newlines verbatim', () => {
    expect(commentInsertPayload(7, 'a\n\nb ')).toEqual({
      cardId: 7,
      body: 'a\n\nb ',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* sortActivityDesc                                                            */
/* -------------------------------------------------------------------------- */

describe('sortActivityDesc', () => {
  function row(id: number, created_at: string): ActivityRow {
    return {
      id,
      card_id: 1,
      kind: 'comment',
      actor_id: 1,
      created_at,
    };
  }

  it('orders rows by created_at descending', () => {
    const out = sortActivityDesc([
      row(1, '2026-05-01T00:00:00Z'),
      row(2, '2026-05-03T00:00:00Z'),
      row(3, '2026-05-02T00:00:00Z'),
    ]);
    expect(out.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it('breaks ties by id descending', () => {
    const out = sortActivityDesc([
      row(1, '2026-05-01T00:00:00Z'),
      row(3, '2026-05-01T00:00:00Z'),
      row(2, '2026-05-01T00:00:00Z'),
    ]);
    expect(out.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('does not mutate the input array', () => {
    const input = [
      row(1, '2026-05-01T00:00:00Z'),
      row(2, '2026-05-02T00:00:00Z'),
    ];
    const snapshot = [...input];
    sortActivityDesc(input);
    expect(input).toEqual(snapshot);
  });

  it('handles an empty array', () => {
    expect(sortActivityDesc([])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* pickTaskById                                                                */
/* -------------------------------------------------------------------------- */

describe('pickTaskById', () => {
  function card(id: number): CardWithAttrs {
    return {
      id,
      card_type_id: 2,
      card_type_name: 'task',
      attributes: { title: `Task ${id}` },
    };
  }

  it('finds the matching id', () => {
    const found = pickTaskById([card(1), card(2), card(3)], 2);
    expect(found?.id).toBe(2);
  });

  it('returns null when no row matches', () => {
    expect(pickTaskById([card(1)], 99)).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(pickTaskById([], 1)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* userNameMap                                                                 */
/* -------------------------------------------------------------------------- */

describe('userNameMap', () => {
  it('keys the display name by user id', () => {
    const users: UserRow[] = [
      { id: 1, display_name: 'alice' },
      { id: 2, display_name: 'bob' },
    ];
    expect(userNameMap(users)).toEqual({ 1: 'alice', 2: 'bob' });
  });

  it('returns an empty object for empty input', () => {
    expect(userNameMap([])).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* cardTitleMap                                                                */
/* -------------------------------------------------------------------------- */

describe('cardTitleMap', () => {
  function card(id: number, attrs: Record<string, unknown>): CardWithAttrs {
    return {
      id,
      card_type_id: 1,
      card_type_name: 'milestone',
      attributes: attrs,
    };
  }

  it('keys title by card id when title is a non-empty string', () => {
    expect(
      cardTitleMap([card(10, { title: 'M1' }), card(11, { title: 'M2' })]),
    ).toEqual({ 10: 'M1', 11: 'M2' });
  });

  it('skips rows whose title is missing or non-string', () => {
    expect(
      cardTitleMap([card(10, { title: 'M1' }), card(11, {}), card(12, { title: 7 })]),
    ).toEqual({ 10: 'M1' });
  });

  it('skips rows whose title is the empty string', () => {
    expect(cardTitleMap([card(10, { title: '' })])).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* tagPathMap                                                                  */
/* -------------------------------------------------------------------------- */

describe('tagPathMap', () => {
  function tag(id: number, attrs: Record<string, unknown>): CardWithAttrs {
    return {
      id,
      card_type_id: 1,
      card_type_name: 'tag',
      attributes: attrs,
    };
  }

  it('prefers the path attribute', () => {
    expect(tagPathMap([tag(1, { path: 'priority/high' })])).toEqual({
      1: 'priority/high',
    });
  });

  it('falls back to title when path is absent', () => {
    expect(tagPathMap([tag(1, { title: 'urgent' })])).toEqual({ 1: 'urgent' });
  });

  it('skips rows with neither path nor title', () => {
    expect(tagPathMap([tag(1, {})])).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* appliedTagIds                                                               */
/* -------------------------------------------------------------------------- */

describe('appliedTagIds', () => {
  function card(attrs: Record<string, unknown>): CardWithAttrs {
    return {
      id: 1,
      card_type_id: 2,
      card_type_name: 'task',
      attributes: attrs,
    };
  }

  it('returns the numeric ids from attributes.tags', () => {
    expect(appliedTagIds(card({ tags: [10, 11, 12] }))).toEqual([10, 11, 12]);
  });

  it('filters non-number entries', () => {
    expect(appliedTagIds(card({ tags: [10, 'no', 11] }))).toEqual([10, 11]);
  });

  it('returns [] when tags is not an array', () => {
    expect(appliedTagIds(card({ tags: 7 }))).toEqual([]);
    expect(appliedTagIds(card({}))).toEqual([]);
  });

  it('returns [] for null task', () => {
    expect(appliedTagIds(null)).toEqual([]);
  });
});

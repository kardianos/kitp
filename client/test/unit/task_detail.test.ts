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
  personNameMap,
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
  const TASK_ID = 42n;
  const spec = initialBatchSpec(TASK_ID);

  it('returns exactly eight sub-requests so the dispatcher coalesces one POST', () => {
    expect(spec).toHaveLength(8);
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

  it('sixth sub-request fetches users (activity-stream actor labels)', () => {
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

  it('eighth sub-request fetches persons (assignee picker options)', () => {
    expect(spec[7]).toMatchObject({
      endpoint: 'card',
      action: 'select_with_attributes',
      data: { cardTypeName: 'person' },
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
      'card.select_with_attributes', // person
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* commitTitlePayload                                                          */
/* -------------------------------------------------------------------------- */

describe('commitTitlePayload', () => {
  it('shapes the attribute.update input for title', () => {
    expect(commitTitlePayload(7n, 'New title')).toEqual({
      cardId: 7n,
      attributeName: 'title',
      value: 'New title',
    });
  });

  it('preserves whitespace verbatim — trimming is the screen layer\'s job', () => {
    // The screen trims before reaching the helper; the helper itself is
    // a pure constructor with no side effects.
    expect(commitTitlePayload(1n, '  spaced  ')).toEqual({
      cardId: 1n,
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
    expect(commitDescriptionPayload(9n, 'hello\nworld')).toEqual({
      cardId: 9n,
      attributeName: 'description',
      value: 'hello\nworld',
    });
  });

  it('clears the attribute (value=null) when the description is empty', () => {
    expect(commitDescriptionPayload(9n, '')).toEqual({
      cardId: 9n,
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
    expect(attributeUpdatePayload(11n, 'status', 'doing')).toEqual({
      cardId: 11n,
      attributeName: 'status',
      value: 'doing',
    });
  });

  it('round-trips null as a clear-attribute marker', () => {
    expect(attributeUpdatePayload(11n, 'milestone_ref', null)).toEqual({
      cardId: 11n,
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
    expect(applyTagPayload(1n, 99n)).toEqual({
      targetCardId: 1n,
      tagCardId: 99n,
    });
  });
});

describe('removeTagPayload', () => {
  it('shapes tag.remove input as { targetCardId, tagCardId }', () => {
    expect(removeTagPayload(2n, 88n)).toEqual({
      targetCardId: 2n,
      tagCardId: 88n,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* commentInsertPayload                                                        */
/* -------------------------------------------------------------------------- */

describe('commentInsertPayload', () => {
  it('shapes comment.insert input', () => {
    expect(commentInsertPayload(7n, 'looks good')).toEqual({
      cardId: 7n,
      body: 'looks good',
    });
  });

  it('preserves whitespace and newlines verbatim', () => {
    expect(commentInsertPayload(7n, 'a\n\nb ')).toEqual({
      cardId: 7n,
      body: 'a\n\nb ',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* sortActivityDesc                                                            */
/* -------------------------------------------------------------------------- */

describe('sortActivityDesc', () => {
  function row(id: bigint, created_at: string): ActivityRow {
    return {
      id,
      card_id: 1n,
      kind: 'comment',
      actor_id: 1n,
      created_at,
    };
  }

  it('orders rows by created_at descending', () => {
    const out = sortActivityDesc([
      row(1n, '2026-05-01T00:00:00Z'),
      row(2n, '2026-05-03T00:00:00Z'),
      row(3n, '2026-05-02T00:00:00Z'),
    ]);
    expect(out.map((r) => r.id)).toEqual([2n, 3n, 1n]);
  });

  it('breaks ties by id descending', () => {
    const out = sortActivityDesc([
      row(1n, '2026-05-01T00:00:00Z'),
      row(3n, '2026-05-01T00:00:00Z'),
      row(2n, '2026-05-01T00:00:00Z'),
    ]);
    expect(out.map((r) => r.id)).toEqual([3n, 2n, 1n]);
  });

  it('does not mutate the input array', () => {
    const input = [
      row(1n, '2026-05-01T00:00:00Z'),
      row(2n, '2026-05-02T00:00:00Z'),
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
  function card(id: bigint): CardWithAttrs {
    return {
      id,
      card_type_id: 2n,
      card_type_name: 'task',
      attributes: { title: `Task ${id}` },
    };
  }

  it('finds the matching id', () => {
    const found = pickTaskById([card(1n), card(2n), card(3n)], 2n);
    expect(found?.id).toBe(2n);
  });

  it('returns null when no row matches', () => {
    expect(pickTaskById([card(1n)], 99n)).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(pickTaskById([], 1n)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* userNameMap                                                                 */
/* -------------------------------------------------------------------------- */

describe('userNameMap', () => {
  it('keys the display name by user id', () => {
    const users: UserRow[] = [
      { id: 1n, display_name: 'alice' },
      { id: 2n, display_name: 'bob' },
    ];
    expect(userNameMap(users)).toEqual({ 1: 'alice', 2: 'bob' });
  });

  it('returns an empty object for empty input', () => {
    expect(userNameMap([])).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* personNameMap                                                              */
/* -------------------------------------------------------------------------- */

describe('personNameMap', () => {
  function person(id: bigint, attrs: Record<string, unknown>): CardWithAttrs {
    return {
      id,
      card_type_id: 7n,
      card_type_name: 'person',
      attributes: attrs,
    };
  }

  it('keys the title by person card id', () => {
    expect(
      personNameMap([
        person(1n, { title: 'alice' }),
        person(2n, { title: 'bob' }),
      ]),
    ).toEqual({ 1: 'alice', 2: 'bob' });
  });

  it('skips rows whose title is missing or non-string', () => {
    expect(
      personNameMap([
        person(1n, { title: 'alice' }),
        person(2n, {}),
        person(3n, { title: 7 }),
      ]),
    ).toEqual({ 1: 'alice' });
  });

  it('skips rows whose title is the empty string', () => {
    expect(personNameMap([person(1n, { title: '' })])).toEqual({});
  });

  it('returns an empty object for empty input', () => {
    expect(personNameMap([])).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* cardTitleMap                                                                */
/* -------------------------------------------------------------------------- */

describe('cardTitleMap', () => {
  function card(id: bigint, attrs: Record<string, unknown>): CardWithAttrs {
    return {
      id,
      card_type_id: 1n,
      card_type_name: 'milestone',
      attributes: attrs,
    };
  }

  it('keys title by card id when title is a non-empty string', () => {
    expect(
      cardTitleMap([card(10n, { title: 'M1' }), card(11n, { title: 'M2' })]),
    ).toEqual({ 10: 'M1', 11: 'M2' });
  });

  it('skips rows whose title is missing or non-string', () => {
    expect(
      cardTitleMap([card(10n, { title: 'M1' }), card(11n, {}), card(12n, { title: 7 })]),
    ).toEqual({ 10: 'M1' });
  });

  it('skips rows whose title is the empty string', () => {
    expect(cardTitleMap([card(10n, { title: '' })])).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* tagPathMap                                                                  */
/* -------------------------------------------------------------------------- */

describe('tagPathMap', () => {
  function tag(id: bigint, attrs: Record<string, unknown>): CardWithAttrs {
    return {
      id,
      card_type_id: 1n,
      card_type_name: 'tag',
      attributes: attrs,
    };
  }

  it('prefers the path attribute', () => {
    expect(tagPathMap([tag(1n, { path: 'priority/high' })])).toEqual({
      1: 'priority/high',
    });
  });

  it('falls back to title when path is absent', () => {
    expect(tagPathMap([tag(1n, { title: 'urgent' })])).toEqual({ 1: 'urgent' });
  });

  it('skips rows with neither path nor title', () => {
    expect(tagPathMap([tag(1n, {})])).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* appliedTagIds                                                               */
/* -------------------------------------------------------------------------- */

describe('appliedTagIds', () => {
  function card(attrs: Record<string, unknown>): CardWithAttrs {
    return {
      id: 1n,
      card_type_id: 2n,
      card_type_name: 'task',
      attributes: attrs,
    };
  }

  it('returns the numeric ids from attributes.tags', () => {
    expect(appliedTagIds(card({ tags: [10n, 11n, 12n] }))).toEqual([10n, 11n, 12n]);
  });

  it('filters non-bigint entries', () => {
    expect(appliedTagIds(card({ tags: [10n, 'no', 11n] }))).toEqual([10n, 11n]);
  });

  it('returns [] when tags is not an array', () => {
    expect(appliedTagIds(card({ tags: 7 }))).toEqual([]);
    expect(appliedTagIds(card({}))).toEqual([]);
  });

  it('returns [] for null task', () => {
    expect(appliedTagIds(null)).toEqual([]);
  });
});

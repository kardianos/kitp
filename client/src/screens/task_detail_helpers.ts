/**
 * Pure helpers for `TaskDetailScreen.svelte`.
 *
 * Kept in a separate `.ts` module so they can be unit-tested without
 * spinning up a Svelte component (the test suite has no
 * `@testing-library/svelte` dependency, matching `login_helpers.ts`).
 *
 * Responsibilities:
 *   1. Spec the initial-batch sub-request shape so the dispatcher
 *      coalesces the seven reads into a single POST.
 *   2. Compose the dispatcher inputs for the half-dozen mutations the
 *      screen issues (title commit, description commit, comment post,
 *      tag apply / remove, generic attribute set).
 *   3. Sort an activity-row list newest-first.
 */
import type { RequestArgs } from '../dispatch/dispatcher.js';
import {
  activitySelect,
  attributeDefSelect,
  attributeUpdate,
  cardSelectWithAttributes,
  commentInsert,
  tagApply,
  tagRemove,
  userSelect,
} from '../reg/handlers.js';
import type {
  ActivityRow,
  ActivitySelectInput,
  AttributeDefSelectInput,
  AttributeUpdateInput,
  CardSelectWithAttributesInput,
  CardWithAttrs,
  CommentInsertInput,
  TagApplyInput,
  TagRemoveInput,
  UserSelectInput,
} from '../reg/types.js';

/** One element of the typed initial batch. */
export type Subrequest =
  | RequestArgs<CardSelectWithAttributesInput>
  | RequestArgs<ActivitySelectInput>
  | RequestArgs<UserSelectInput>
  | RequestArgs<AttributeDefSelectInput>;

/** Default activity rows pulled per task — matches the Dart screen. */
export const ACTIVITY_LIMIT = 50;

/**
 * Build the seven sub-requests the screen issues on mount. They go out
 * synchronously so the dispatcher batches them into ONE POST.
 *
 * Order is contractual — tests assert the exact ordering and matching
 * payloads so future refactors cannot silently flip a sub-response slot.
 */
export function initialBatchSpec(taskId: number): Subrequest[] {
  return [
    // 0: the task itself. The server's `where` filters on attribute_value
    // not card.id, so we pull every task type and pick by id in memory —
    // same approach as the Dart screen.
    {
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'task' } satisfies CardSelectWithAttributesInput,
    },
    // 1: this card's activity stream (newest first via sortActivityDesc).
    {
      endpoint: activitySelect.endpoint,
      action: activitySelect.action,
      data: { cardId: taskId, limit: ACTIVITY_LIMIT } satisfies ActivitySelectInput,
    },
    // 2: milestones — populates the "milestone_ref" attribute Combobox.
    {
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'milestone' } satisfies CardSelectWithAttributesInput,
    },
    // 3: components — populates the "component_ref" attribute Combobox.
    {
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'component' } satisfies CardSelectWithAttributesInput,
    },
    // 4: tags — populates the tag picker / chip row.
    {
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'tag' } satisfies CardSelectWithAttributesInput,
    },
    // 5: users — used by the activity stream + assignee combobox.
    {
      endpoint: userSelect.endpoint,
      action: userSelect.action,
      data: {} satisfies UserSelectInput,
    },
    // 6: attribute_def schema — drives the right-rail AttributeSidePanel.
    {
      endpoint: attributeDefSelect.endpoint,
      action: attributeDefSelect.action,
      data: {} satisfies AttributeDefSelectInput,
    },
  ];
}

/**
 * Build the dispatcher input for committing a title edit. The trimmed
 * value goes onto the wire as the new attribute value; an empty string
 * is rejected by the screen before this helper is reached, matching the
 * Dart `next.isEmpty || next == lastSaved` short-circuit.
 */
export function commitTitlePayload(
  cardId: number,
  newTitle: string,
): AttributeUpdateInput {
  return {
    cardId,
    attributeName: 'title',
    value: newTitle,
  };
}

/**
 * Build the dispatcher input for committing a description edit. Empty
 * descriptions clear the attribute (server treats `null` as remove).
 */
export function commitDescriptionPayload(
  cardId: number,
  newDescription: string,
): AttributeUpdateInput {
  return {
    cardId,
    attributeName: 'description',
    value: newDescription === '' ? null : newDescription,
  };
}

/** Generic attribute-set payload (status / assignee / milestone / component). */
export function attributeUpdatePayload(
  cardId: number,
  attributeName: string,
  value: unknown,
): AttributeUpdateInput {
  return { cardId, attributeName, value };
}

/** Build the dispatcher input for `comment.insert`. */
export function commentInsertPayload(
  cardId: number,
  body: string,
): CommentInsertInput {
  return { cardId, body };
}

/** Build the dispatcher input for `tag.apply`. */
export function applyTagPayload(taskId: number, tagCardId: number): TagApplyInput {
  return { targetCardId: taskId, tagCardId };
}

/** Build the dispatcher input for `tag.remove`. */
export function removeTagPayload(taskId: number, tagCardId: number): TagRemoveInput {
  return { targetCardId: taskId, tagCardId };
}

/**
 * Sort activity rows by `created_at` descending (newest first), with id
 * as a tiebreaker for rows minted in the same wall-clock millisecond.
 *
 * Returns a NEW array; the caller's input is not mutated.
 */
export function sortActivityDesc(rows: readonly ActivityRow[]): ActivityRow[] {
  return [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? 1 : -1;
    }
    return b.id - a.id;
  });
}

/**
 * Find the task row in the (full-table) `card.select_with_attributes`
 * output. Returns `null` if none matches; the screen then renders a
 * "Task not found" empty state.
 */
export function pickTaskById(
  rows: readonly CardWithAttrs[],
  id: number,
): CardWithAttrs | null {
  for (const r of rows) {
    if (r.id === id) return r;
  }
  return null;
}

/**
 * Build the `userNames` lookup the activity rows + AttributeSidePanel
 * `refOptions[assignee]` are derived from.
 */
export function userNameMap(
  rows: readonly { id: number; display_name: string }[],
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const u of rows) out[u.id] = u.display_name;
  return out;
}

/** Build the `cardTitles` lookup keyed by card id. */
export function cardTitleMap(rows: readonly CardWithAttrs[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const c of rows) {
    const t = c.attributes['title'];
    if (typeof t === 'string' && t.length > 0) {
      out[c.id] = t;
    }
  }
  return out;
}

/** Build the `tagPaths` lookup for tag cards (path attribute, fall back to title). */
export function tagPathMap(rows: readonly CardWithAttrs[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const t of rows) {
    const p = t.attributes['path'];
    if (typeof p === 'string' && p.length > 0) {
      out[t.id] = p;
      continue;
    }
    const title = t.attributes['title'];
    if (typeof title === 'string' && title.length > 0) {
      out[t.id] = title;
    }
  }
  return out;
}

/** Resolve the applied tag ids on a task — `attributes.tags`, defaulting to []. */
export function appliedTagIds(task: CardWithAttrs | null): number[] {
  if (task === null) return [];
  const raw = task.attributes['tags'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number');
}

// Re-export the spec records so callers can keep the registry plumbing
// in one place (mirrors what AttributeSidePanel does for attributeUpdate).
export {
  activitySelect,
  attributeDefSelect,
  attributeUpdate,
  cardSelectWithAttributes,
  commentInsert,
  tagApply,
  tagRemove,
  userSelect,
};

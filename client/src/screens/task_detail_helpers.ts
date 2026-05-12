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
  cardSearch,
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
  ID,
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
 * Build the eight sub-requests the screen issues on mount. They go out
 * synchronously so the dispatcher batches them into ONE POST.
 *
 * Order is contractual — tests assert the exact ordering and matching
 * payloads so future refactors cannot silently flip a sub-response slot.
 */
export function initialBatchSpec(taskId: ID): Subrequest[] {
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
    // 5: users — used by the activity stream to resolve actor labels
    // (activity.actor_id is a `user_account.id`).
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
    // 7: persons — populates the assignee Combobox. Post-refactor, the
    // `assignee` attribute is a card_ref to a `person` card, not a
    // user_account ref; the assignee picker reads from this list while
    // the activity stream keeps using `users` above for actor labels.
    {
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'person' } satisfies CardSelectWithAttributesInput,
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
  cardId: ID,
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
  cardId: ID,
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
  cardId: ID,
  attributeName: string,
  value: unknown,
): AttributeUpdateInput {
  return { cardId, attributeName, value };
}

/** Build the dispatcher input for `comment.insert`. */
export function commentInsertPayload(
  cardId: ID,
  body: string,
): CommentInsertInput {
  return { cardId, body };
}

/** Build the dispatcher input for `tag.apply`. */
export function applyTagPayload(taskId: ID, tagCardId: ID): TagApplyInput {
  return { targetCardId: taskId, tagCardId };
}

/** Build the dispatcher input for `tag.remove`. */
export function removeTagPayload(taskId: ID, tagCardId: ID): TagRemoveInput {
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
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
}

/**
 * Find the task row in the (full-table) `card.select_with_attributes`
 * output. Returns `null` if none matches; the screen then renders a
 * "Task not found" empty state.
 */
export function pickTaskById(
  rows: readonly CardWithAttrs[],
  id: ID,
): CardWithAttrs | null {
  for (const r of rows) {
    if (r.id === id) return r;
  }
  return null;
}

/**
 * Build the `userNames` lookup the activity rows use to render the
 * actor for each entry (`activity.actor_id` is a `user_account.id`).
 * Keys are id-as-string because bigint can't be a plain object key in
 * JS.
 */
export function userNameMap(
  rows: readonly { id: ID; display_name: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of rows) out[u.id.toString()] = u.display_name;
  return out;
}

/**
 * Build the `personNames` lookup the assignee picker / chip uses to
 * resolve a `person` card id to its display title. Mirrors {@link
 * userNameMap}'s key-as-string convention. Pulls the display name from
 * `card.attributes.title`; rows with no title are simply omitted so the
 * picker falls back to `#<id>` for them.
 */
export function personNameMap(
  rows: readonly CardWithAttrs[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of rows) {
    const t = p.attributes['title'];
    if (typeof t === 'string' && t.length > 0) out[p.id.toString()] = t;
  }
  return out;
}

/** Build the `cardTitles` lookup keyed by card-id-as-string. */
export function cardTitleMap(rows: readonly CardWithAttrs[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of rows) {
    const t = c.attributes['title'];
    if (typeof t === 'string' && t.length > 0) {
      out[c.id.toString()] = t;
    }
  }
  return out;
}

/** Build the `tagPaths` lookup for tag cards (path attribute, fall back to title). */
export function tagPathMap(rows: readonly CardWithAttrs[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of rows) {
    const p = t.attributes['path'];
    if (typeof p === 'string' && p.length > 0) {
      out[t.id.toString()] = p;
      continue;
    }
    const title = t.attributes['title'];
    if (typeof title === 'string' && title.length > 0) {
      out[t.id.toString()] = title;
    }
  }
  return out;
}

/** Resolve the applied tag ids on a task — `attributes.tags`, defaulting to []. */
export function appliedTagIds(task: CardWithAttrs | null): ID[] {
  if (task === null) return [];
  const raw = task.attributes['tags'];
  if (!Array.isArray(raw)) return [];
  const out: ID[] = [];
  for (const v of raw) {
    if (typeof v === 'bigint') out.push(v);
    else if (typeof v === 'number' && Number.isInteger(v)) out.push(BigInt(v));
  }
  return out;
}

// Re-export the spec records so callers can keep the registry plumbing
// in one place (mirrors what AttributeSidePanel does for attributeUpdate).
export {
  activitySelect,
  attributeDefSelect,
  attributeUpdate,
  cardSearch,
  cardSelectWithAttributes,
  commentInsert,
  tagApply,
  tagRemove,
  userSelect,
};

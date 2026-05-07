/**
 * Pure-function string composer for one ActivityRow.
 *
 * Mirrors the kind-by-kind switch in `client/lib/ui/widgets/activity_row.dart`
 * but produces a single human-readable string rather than a widget tree —
 * easier to unit test (no jsdom required) and keeps the Svelte component's
 * template tiny.
 *
 * Resolver maps are optional: when missing or when an id isn't present the
 * function falls back to `#<id>` / `user#<id>` so renders are never blank.
 */

import type { ActivityRow } from '../../reg/types.js';

export type IdMap = Record<number, string>;

/** Drop a trailing `_ref` and underscore-to-space the rest. */
export function humaniseAttribute(name: string): string {
  let n = name;
  if (n.endsWith('_ref')) n = n.slice(0, -4);
  return n.replace(/_/g, ' ');
}

function resolveActor(actorId: number, userNames?: IdMap): string {
  return userNames?.[actorId] ?? `user#${actorId}`;
}

function resolveTagId(id: number, tagPaths?: IdMap): string {
  return tagPaths?.[id] ?? `#${id}`;
}

function formatAttrValue(
  attrName: string | undefined,
  v: unknown,
  userNames?: IdMap,
  cardTitles?: IdMap,
  tagPaths?: IdMap,
): string {
  if (v === null || v === undefined) return '∅';
  switch (attrName) {
    case 'assignee':
      if (typeof v === 'number') return userNames?.[v] ?? `#${v}`;
      return String(v);
    case 'milestone_ref':
    case 'component_ref':
      if (typeof v === 'number') return cardTitles?.[v] ?? `#${v}`;
      return String(v);
    case 'tags':
      if (Array.isArray(v)) {
        if (v.length === 0) return '∅';
        return v
          .map((id) => (typeof id === 'number' ? resolveTagId(id, tagPaths) : String(id)))
          .join(', ');
      }
      return String(v);
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  return String(v);
}

function idSet(v: unknown): Set<number> {
  if (Array.isArray(v)) {
    const out = new Set<number>();
    for (const e of v) {
      if (typeof e === 'number') out.add(e);
    }
    return out;
  }
  return new Set<number>();
}

/**
 * Compute the (added, removed) tag display names between value_old and
 * value_new for a tag_apply / tag_remove activity.
 */
export function tagDiff(
  row: ActivityRow,
  tagPaths?: IdMap,
): { added: string[]; removed: string[] } {
  const oldIds = idSet(row.value_old);
  const newIds = idSet(row.value_new);
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of newIds) {
    if (!oldIds.has(id)) added.push(resolveTagId(id, tagPaths));
  }
  for (const id of oldIds) {
    if (!newIds.has(id)) removed.push(resolveTagId(id, tagPaths));
  }
  return { added, removed };
}

/**
 * Compose a one-line human-readable summary of an activity row.
 *
 * The `comment` kind embeds the comment body inline; callers that want
 * separate header/body rendering should branch on `row.kind === 'comment'`
 * themselves (the Svelte component does just that).
 */
export function formatActivityText(
  row: ActivityRow,
  userNames?: IdMap,
  cardTitles?: IdMap,
  tagPaths?: IdMap,
): string {
  const actor = resolveActor(row.actor_id, userNames);
  switch (row.kind) {
    case 'card_create':
      return `${actor} created the card.`;
    case 'card_delete':
      return `${actor} deleted the card.`;
    case 'card_undelete':
      return `${actor} restored the card.`;
    case 'card_move':
      return `${actor} moved the card.`;
    case 'comment': {
      const body = row.comment_body ?? '';
      return `${actor} commented: ${body}`;
    }
    case 'tag_apply':
    case 'tag_remove': {
      const { added, removed } = tagDiff(row, tagPaths);
      if (added.length === 0 && removed.length === 0) {
        return `${actor} changed tags.`;
      }
      if (removed.length === 0) {
        return `${actor} applied tag ${added.join(', ')}`;
      }
      if (added.length === 0) {
        return `${actor} removed tag ${removed.join(', ')}`;
      }
      return `${actor} applied ${added.join(', ')} and removed ${removed.join(', ')}`;
    }
    case 'attr_update': {
      const name = row.attribute_name ?? 'attribute';
      if (name === 'description') return `${actor} edited the description.`;
      if (name === 'sort_order') return `${actor} reordered the card.`;
      const label = humaniseAttribute(name);
      const oldS = formatAttrValue(name, row.value_old, userNames, cardTitles, tagPaths);
      const newS = formatAttrValue(name, row.value_new, userNames, cardTitles, tagPaths);
      return `${actor} changed ${label} from ${oldS} to ${newS}`;
    }
    case 'attachment_create': {
      const fn = readFilename(row.value_new);
      return fn !== '' ? `${actor} attached ${fn}` : `${actor} added an attachment.`;
    }
    case 'attachment_delete': {
      const fn = readFilename(row.value_old);
      return fn !== '' ? `${actor} removed ${fn}` : `${actor} removed an attachment.`;
    }
    default:
      return `${actor}: ${row.kind}`;
  }
}

/** Pull the `filename` field out of an activity payload, if any. */
function readFilename(v: unknown): string {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return '';
  const fn = (v as Record<string, unknown>)['filename'];
  return typeof fn === 'string' ? fn : '';
}

/** Status to color hint used by TaskRow's status chip. */
export function statusColor(s: unknown): 'gray' | 'blue' | 'amber' | 'green' {
  if (typeof s !== 'string') return 'gray';
  switch (s) {
    case 'todo':
      return 'gray';
    case 'doing':
      return 'blue';
    case 'review':
      return 'amber';
    case 'done':
      return 'green';
    default:
      return 'gray';
  }
}

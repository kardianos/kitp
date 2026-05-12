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

import type { ActivityRow, ID } from '../../reg/types.js';

/** Lookup map keyed by id.toString() for bigint compatibility. */
export type IdMap = Record<string, string>;

/** Coerce a candidate id value (number or bigint, post- or pre-revival) to a string key. */
function idKey(v: unknown): string | null {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isInteger(v)) return v.toString();
  return null;
}

/** Drop a trailing `_ref` and underscore-to-space the rest. */
export function humaniseAttribute(name: string): string {
  let n = name;
  if (n.endsWith('_ref')) n = n.slice(0, -4);
  return n.replace(/_/g, ' ');
}

function resolveActor(actorId: ID, userNames?: IdMap): string {
  const k = actorId.toString();
  return userNames?.[k] ?? `user#${k}`;
}

function formatAttrValue(
  attrName: string | undefined,
  v: unknown,
  userNames?: IdMap,
  cardTitles?: IdMap,
  tagPaths?: IdMap,
): string {
  if (v === null || v === undefined) return '∅';
  // Per-attribute special cases for ref shapes the kernel treats
  // differently from "look up the bigint in cardTitles":
  //   - assignee   → person-name map (separate from value-card titles)
  //   - tags       → array of tag-card ids → tagPaths
  // Everything else falls through to the generic id→title resolution
  // below, which now covers every card_ref attribute (status, milestone,
  // component, and any admin-added ref) as long as the caller's
  // cardTitles map includes the value-card. No more per-attribute
  // hard-coded list.
  switch (attrName) {
    case 'assignee': {
      const k = idKey(v);
      if (k !== null) return userNames?.[k] ?? `#${k}`;
      return String(v);
    }
    case 'tags':
      if (Array.isArray(v)) {
        if (v.length === 0) return '∅';
        return v
          .map((id) => {
            const k = idKey(id);
            if (k === null) return String(id);
            return tagPaths?.[k] ?? `#${k}`;
          })
          .join(', ');
      }
      return String(v);
  }
  // Generic: id-shaped bigint / numeric values resolve via cardTitles
  // (one map merged from milestones + components + statuses + …).
  const k = idKey(v);
  if (k !== null) return cardTitles?.[k] ?? `#${k}`;
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return String(v);
  return String(v);
}

function idSet(v: unknown): Set<string> {
  if (Array.isArray(v)) {
    const out = new Set<string>();
    for (const e of v) {
      const k = idKey(e);
      if (k !== null) out.add(k);
    }
    return out;
  }
  return new Set<string>();
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
  for (const k of newIds) {
    if (!oldIds.has(k)) added.push(tagPaths?.[k] ?? `#${k}`);
  }
  for (const k of oldIds) {
    if (!newIds.has(k)) removed.push(tagPaths?.[k] ?? `#${k}`);
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

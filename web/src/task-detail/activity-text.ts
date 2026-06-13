/**
 * Pure-function string composer for one ActivityRow (#35).
 *
 * Ports the kind-by-kind switch from the Svelte client's
 * `client/src/ui/widgets/activity_text.ts` — produces a single human-readable
 * line per activity row, with actor / card / tag / person label resolution. A
 * pure module (no DOM) so the feed control's render stays tiny and this is unit
 * testable on its own.
 *
 * Resolver maps are optional: when missing or when an id isn't present the
 * function falls back to `#<id>` / `user#<id>` so a render is never blank.
 */

import type { ActivityRow } from './comment-specs.js';

/** Lookup map keyed by id.toString() (bigint can't be a plain object key). */
export type IdMap = Record<string, string>;

/** Coerce a candidate id value to a string key: bigint, integer number, or a
 *  digit string (activity jsonb stores card_ref ids as JSON strings). */
function idKey(v: unknown): string | null {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isInteger(v)) return v.toString();
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  return null;
}

/** Drop a trailing `_ref` and underscore-to-space the rest. */
export function humaniseAttribute(name: string): string {
  let n = name;
  if (n.endsWith('_ref')) n = n.slice(0, -4);
  return n.replace(/_/g, ' ');
}

function resolveActor(actorId: bigint, userNames?: IdMap): string {
  const k = actorId.toString();
  return userNames?.[k] ?? `user#${k}`;
}

/** A value counts as "empty" (no setting) when it's null/undefined, the empty
 *  string, or an empty array (e.g. a never-set assignee or a cleared tag set).
 *  Drives the "set …" / "cleared …" phrasing so the activity feed never shows
 *  a bare empty-set placeholder. */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function formatAttrValue(
  attrName: string | undefined,
  v: unknown,
  userNames?: IdMap,
  cardTitles?: IdMap,
  tagPaths?: IdMap,
): string {
  if (v === null || v === undefined) return '—';
  // Per-attribute special cases for ref shapes the kernel treats differently
  // from "look up the bigint in cardTitles":
  //   - assignee   → person-name map (separate from value-card titles)
  //   - tags       → array of tag-card ids → tagPaths
  // Everything else falls through to the generic id→title resolution below,
  // which covers every card_ref attribute (status/milestone/component/…) as
  // long as the caller's cardTitles map includes the value-card.
  switch (attrName) {
    case 'assignee':
    case 'originator': {
      const k = idKey(v);
      if (k !== null) return userNames?.[k] ?? cardTitles?.[k] ?? `#${k}`;
      return String(v);
    }
    case 'tags':
      if (Array.isArray(v)) {
        if (v.length === 0) return '—';
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
  const k = idKey(v);
  if (k !== null) {
    const t = cardTitles?.[k];
    if (t !== undefined) return t;
    // Title not (yet) resolved, or this is a plain number/text value that only
    // LOOKS like an id (e.g. a `number` attribute). Print it raw rather than
    // inventing a "#id" — only true card_ref values land in cardTitles.
  }
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
  const oldIds = idSet(row.valueOld);
  const newIds = idSet(row.valueNew);
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

/** Pull the `filename` field out of an activity payload, if any. */
function readFilename(v: unknown): string {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return '';
  const fn = (v as Record<string, unknown>)['filename'];
  return typeof fn === 'string' ? fn : '';
}

/**
 * Compose a one-line human-readable summary of an activity row.
 *
 * The `comment` / `comment_edit` kinds get their own audit phrasing (their
 * bodies render in the Comments section, not here); every other kind builds a
 * phrase from value_old/value_new with label resolution.
 */
export function formatActivityText(
  row: ActivityRow,
  userNames?: IdMap,
  cardTitles?: IdMap,
  tagPaths?: IdMap,
): string {
  const actor = resolveActor(row.actorId, userNames);
  switch (row.kind) {
    case 'card_create':
      return `${actor} created the card.`;
    case 'card_delete':
      return `${actor} deleted the card.`;
    case 'card_undelete':
      return `${actor} restored the card.`;
    case 'card_move':
      return `${actor} moved the card.`;
    case 'comment':
      return `${actor} commented.`;
    case 'comment_edit':
      return `${actor} edited a comment.`;
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
      const name = row.attributeName ?? 'attribute';
      if (name === 'description') return `${actor} edited the description.`;
      if (name === 'sort_order') return `${actor} reordered the card.`;
      const label = humaniseAttribute(name);
      // Phrase by which side is empty so an "unset → value" row reads
      // "set X to Y" rather than "changed X from ∅ to Y" (the empty-set glyph
      // confused readers). Only a genuine value→value edit shows "from … to …".
      const oldEmpty = isEmptyValue(row.valueOld);
      const newEmpty = isEmptyValue(row.valueNew);
      if (oldEmpty && newEmpty) return `${actor} changed ${label}.`;
      const newS = formatAttrValue(name, row.valueNew, userNames, cardTitles, tagPaths);
      if (oldEmpty) return `${actor} set ${label} to ${newS}`;
      const oldS = formatAttrValue(name, row.valueOld, userNames, cardTitles, tagPaths);
      if (newEmpty) return `${actor} cleared ${label} (was ${oldS})`;
      return `${actor} changed ${label} from ${oldS} to ${newS}`;
    }
    case 'attachment_create': {
      const fn = readFilename(row.valueNew);
      return fn !== '' ? `${actor} attached ${fn}` : `${actor} added an attachment.`;
    }
    case 'attachment_delete': {
      const fn = readFilename(row.valueOld);
      return fn !== '' ? `${actor} removed ${fn}` : `${actor} removed an attachment.`;
    }
    default:
      return `${actor}: ${row.kind}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Comment derivation from the activity stream.                                */
/* -------------------------------------------------------------------------- */

/** A comment derived from the activity stream — newest-first ordering input. */
export interface CommentEntry {
  /** The original `kind='comment'` activity row id (the comment.update target). */
  id: bigint;
  /** The current body — the latest comment_edit's new_body wins over the original. */
  body: string;
  actorId: bigint;
  createdAt: string;
  edited: boolean;
}

/**
 * Derive the comment list from a NEWEST-FIRST activity stream. A comment is a
 * `kind='comment'` row carrying its body inline (`commentBody`); a later
 * `kind='comment_edit'` row whose `value_new.activity_id` points back at it
 * overrides the body and flags it edited. Returns newest-first (input order).
 *
 * Mirrors the Svelte screen's `comments` derived computation.
 */
export function deriveComments(orderedNewestFirst: readonly ActivityRow[]): CommentEntry[] {
  // Latest comment_edit for a given comment id wins (we iterate newest-first,
  // so the first edit we see for an id is the most recent).
  const editedBodies = new Map<string, string>();
  for (const a of orderedNewestFirst) {
    if (a.kind !== 'comment_edit') continue;
    const vn = a.valueNew as { activity_id?: unknown; new_body?: unknown } | null;
    if (vn === null || typeof vn !== 'object') continue;
    const target = vn.activity_id;
    const body = vn.new_body;
    const key = typeof target === 'bigint' ? target.toString() : String(target);
    if (typeof body === 'string' && !editedBodies.has(key)) {
      editedBodies.set(key, body);
    }
  }
  const out: CommentEntry[] = [];
  for (const a of orderedNewestFirst) {
    if (a.kind !== 'comment') continue;
    const key = a.id.toString();
    const edited = editedBodies.has(key);
    const body = edited ? (editedBodies.get(key) ?? '') : (a.commentBody ?? '');
    out.push({ id: a.id, body, actorId: a.actorId, createdAt: a.createdAt, edited });
  }
  return out;
}

/**
 * Sort activity rows by `createdAt` descending (newest first), with id as a
 * tiebreaker for rows minted in the same wall-clock instant. Returns a NEW
 * array; the input is not mutated. The server returns card-mode rows ascending
 * (chronological), so the feed sorts to newest-first here.
 */
export function sortActivityDesc(rows: readonly ActivityRow[]): ActivityRow[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
}

/* -------------------------------------------------------------------------- */
/* Relative time formatting.                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Format an ISO-8601 timestamp as a compact relative time ("2h ago",
 * "just now", "3d ago"). Falls back to the raw string if it doesn't parse.
 * Ported from the Svelte client's `formatRelativeTime`.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffMs = now - t;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.round(mon / 12);
  return `${yr}y ago`;
}

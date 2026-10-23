/**
 * Activity feed model — turns newest-first activity rows into what the
 * `/activity` page draws: days, then groups of consecutive changes to one card,
 * then one line per rolled-up change. Pure (no DOM, no API) so it's unit
 * testable on its own; the rows already carry their names and titles
 * (activity.select's actor_name / card_title / nav_title / refs).
 *
 * Grouping: adjacent rows (newest-first) that open the same card (nav card —
 * the owning task for a link / email / reply), fall on the same local day and
 * sit within {@link GROUP_GAP_MS} of each other form one group — "what happened
 * to this card in one go".
 *
 * Roll-up within a group (oldest-first, so a group reads as a story):
 *   - A card's creation absorbs the values it was created with (rows on the same
 *     card by the same actor in the same transaction — identical timestamps): a
 *     task's initial status / assignee become details of "Created", an email's
 *     body becomes its excerpt. JSON-valued text (a saved filter's predicate) is
 *     configuration and is left out.
 *   - Repeated changes to one attribute of one card collapse into
 *     "first old → last new" with a change count and every actor.
 *   - Tag changes on a card net out into one added / removed line.
 *   - Comments, attachments and lifecycle events stay one line each.
 * Changes to a card other than the group's (a link, an email) carry that card
 * as the line's subject ("Link “Fix the feed”").
 */

import { ATTR_CHOICES } from '../filter/attribute-schema.js';
import type { ActivityRow } from '../task-detail/comment-specs.js';
import { formatAttrValue, humaniseAttribute, resolveActor, tagDiff, voteOf, type IdMap } from '../task-detail/activity-text.js';
import { voteWords } from '../task-detail/approval-model.js';

/* -------------------------------------------------------------------------- */
/* Vocabulary (data, not branches).                                           */
/* -------------------------------------------------------------------------- */

/** Display names for card types; anything else is humanised. */
const CARD_TYPE_LABELS: Readonly<Record<string, string>> = {
  task: 'Task',
  link: 'Link',
  comm: 'Email thread',
  reply_body: 'Email',
  person: 'Person',
  filter: 'Saved view',
  screen: 'Screen',
  predicate_snippet: 'Saved filter',
  activity_subscription: 'Notification',
  activity_sink: 'Activity sink',
  comm_channel: 'Email channel',
};

/** The display name of a card type ("reply_body" → "Email"). */
export function cardTypeLabel(cardType: string): string {
  const known = CARD_TYPE_LABELS[cardType];
  if (known !== undefined) return known;
  const h = cardType.replace(/_/g, ' ').trim();
  return h === '' ? 'Card' : h.charAt(0).toUpperCase() + h.slice(1);
}

/**
 * Attributes the feed leaves out: id lists that the child cards' own rows
 * already tell (a comm's replies, a task's comms), and plumbing (a thread id,
 * the ack flag, a reply's author id — the row's actor says who — and the
 * manual sort order).
 */
const HIDDEN_ATTRS: ReadonlySet<string> = new Set([
  'replies',
  'comms',
  'thread_id',
  'acked',
  'reply_author',
  'sort_order',
  // An approval request's fixed edge: its title already names it.
  'approval_from',
  'approval_to',
  'approval_action',
]);

/** Attributes that name the card itself: already the group's heading or the
 *  line's subject, so a creation doesn't repeat them as details. */
const NAME_ATTRS: ReadonlySet<string> = new Set(['title', 'reply_subject']);

/** The "Changes" filter: activity kinds, grouped the way people ask for them. */
export const KIND_GROUPS: ReadonlyArray<{ key: string; label: string; kinds: readonly string[] }> = [
  { key: 'created', label: 'Created', kinds: ['card_create'] },
  { key: 'changed', label: 'Field changes', kinds: ['attr_update', 'card_set_phase'] },
  { key: 'tags', label: 'Tags', kinds: ['tag_apply', 'tag_remove'] },
  { key: 'comments', label: 'Comments', kinds: ['comment', 'comment_edit'] },
  { key: 'approvals', label: 'Approval votes', kinds: ['approval_decision'] },
  { key: 'attachments', label: 'Attachments', kinds: ['attachment_create', 'attachment_delete'] },
  { key: 'moved', label: 'Moves & merges', kinds: ['card_move', 'task_move', 'card_merge'] },
  { key: 'deleted', label: 'Deleted & restored', kinds: ['card_delete', 'card_undelete'] },
];

/** The kinds a set of {@link KIND_GROUPS} keys selects. */
export function kindsForGroups(keys: Iterable<string>): string[] {
  const want = new Set(keys);
  return KIND_GROUPS.filter((g) => want.has(g.key)).flatMap((g) => [...g.kinds]);
}

/** Rows adjacent in the feed stay one group only within this gap. */
export const GROUP_GAP_MS = 3 * 60 * 60 * 1000;

/** A text value longer than this (or multi-line) is "edited", not "a → b". */
const LONG_TEXT = 80;
/** Comment / email excerpts are clipped to this many characters. */
const EXCERPT = 280;

/* -------------------------------------------------------------------------- */
/* Model.                                                                     */
/* -------------------------------------------------------------------------- */

/** One rolled-up change in a group. */
export interface FeedLine {
  /** What the line is: drives its layout. */
  verb: 'created' | 'attr' | 'tags' | 'comment' | 'event';
  /** The card the line is about. */
  cardId: bigint;
  /** '' for the group's own card, else e.g. `Link “Fix the feed”`. */
  subject: string;
  /** "Created" / "Added" / "Status" / "Commented" / `Attached “a.pdf”` … */
  label: string;
  /** attr: the first old and last new values (display strings). */
  old?: string;
  new?: string;
  /** attr: a long text changed — shown as "edited", without the values. */
  edited?: boolean;
  /** tags: net added / removed. */
  added?: string[];
  removed?: string[];
  /** A comment's or a new email's text, clipped. */
  body?: string;
  /** created: the values the card was created with. */
  details: Array<{ label: string; value: string }>;
  /** Rows rolled into this line. */
  count: number;
  /** Everyone who contributed, in order. */
  actors: string[];
  /** The newest row's timestamp. */
  at: string;
}

/** Consecutive changes to one card. */
export interface FeedGroup {
  /** The card the group opens (the owning task for a link / email). */
  navId: bigint;
  navType: string;
  title: string;
  /** Member rows, newest-first. */
  rows: ActivityRow[];
  lines: FeedLine[];
  /** Everyone who acted in the group, in order of first action. */
  actors: string[];
  /** Oldest and newest timestamps. */
  first: string;
  last: string;
}

/** One local calendar day of the feed. */
export interface FeedDay {
  /** `YYYY-MM-DD` (local). */
  key: string;
  /** "Today" / "Yesterday" / "Mon, Oct 20" (+ year when not this year). */
  label: string;
  groups: FeedGroup[];
  /** Rows on the day. */
  count: number;
}

/* -------------------------------------------------------------------------- */
/* Days + groups.                                                             */
/* -------------------------------------------------------------------------- */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local `YYYY-MM-DD` of an ISO timestamp ('' when it doesn't parse). */
export function localDayKey(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "Today" / "Yesterday" / "Mon, Oct 20" (with the year when not this year). */
export function dayLabel(key: string, now: Date = new Date()): string {
  const today = localDayKey(now.toISOString());
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === today) return 'Today';
  if (key === localDayKey(y.toISOString())) return 'Yesterday';
  const [yy, mm, dd] = key.split('-').map(Number);
  if (yy === undefined || mm === undefined || dd === undefined) return key;
  const d = new Date(yy, mm - 1, dd);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  if (yy !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

/** The card a row opens: the server's nav card, else the row's own card. */
function navOf(row: ActivityRow): bigint {
  return row.navCardId ?? row.cardId;
}

/**
 * Split newest-first rows into days, and each day into groups of adjacent rows
 * that open the same card within {@link GROUP_GAP_MS}. Lines are built by
 * {@link buildLines}.
 */
export function buildFeed(rows: readonly ActivityRow[], userNames: IdMap = {}, now: Date = new Date()): FeedDay[] {
  const days: FeedDay[] = [];
  let group: FeedGroup | null = null;
  let tailTime = 0;
  for (const row of rows) {
    const key = localDayKey(row.createdAt);
    let day = days[days.length - 1];
    if (day === undefined || day.key !== key) {
      day = { key, label: dayLabel(key, now), groups: [], count: 0 };
      days.push(day);
      group = null;
    }
    day.count++;
    const t = Date.parse(row.createdAt);
    const nav = navOf(row);
    if (group === null || group.navId !== nav || Math.abs(tailTime - t) > GROUP_GAP_MS) {
      group = {
        navId: nav,
        navType: row.navCardType ?? row.cardType ?? '',
        title: row.navTitle ?? '',
        rows: [],
        lines: [],
        actors: [],
        first: row.createdAt,
        last: row.createdAt,
      };
      day.groups.push(group);
    }
    group.rows.push(row);
    group.first = row.createdAt;
    if (!Number.isNaN(t)) tailTime = t;
  }
  for (const day of days) {
    for (const g of day.groups) {
      g.lines = buildLines(g.navId, g.rows, userNames);
      g.actors = uniq(g.rows.slice().reverse().map((r) => resolveActor(r, userNames)));
    }
  }
  return days;
}

/* -------------------------------------------------------------------------- */
/* Lines.                                                                     */
/* -------------------------------------------------------------------------- */

function uniq(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

function addActor(line: FeedLine, actor: string): void {
  if (!line.actors.includes(actor)) line.actors.push(actor);
}

/** One line, collapsed whitespace, clipped to [n] characters. */
export function clip(s: string, n: number = EXCERPT): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1).trimEnd()}…`;
}

function isLongText(v: unknown): boolean {
  return typeof v === 'string' && (v.length > LONG_TEXT || v.includes('\n'));
}

/** A text value holding JSON (a saved filter's predicate, a screen's toggles):
 *  configuration, not prose — never an excerpt or an "a → b". */
function isJsonText(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

/** A value as the feed shows it: a known choice's label, a card's title, … */
function displayValue(row: ActivityRow, v: unknown, userNames: IdMap): string {
  if (isEmpty(v)) return '—';
  const attr = row.attributeName ?? '';
  if (typeof v === 'string') {
    const choice = ATTR_CHOICES[attr]?.find((c) => c.value === v);
    if (choice !== undefined) return choice.label;
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const s = formatAttrValue(attr, v, userNames, undefined, undefined, row.refs);
  return clip(s, LONG_TEXT);
}

/** The label of [row]'s attribute ("milestone_ref" → "Milestone"), without
 *  the card type's own prefix (a link's "link_state" → "State"). */
function attrLabel(row: ActivityRow): string {
  const name = row.attributeName ?? '';
  const prefix = `${row.cardType ?? ''}_`;
  const own = prefix !== '_' && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  const h = humaniseAttribute(own);
  return h.charAt(0).toUpperCase() + h.slice(1);
}

/** A row's subject when it's on a card other than the group's. */
function subjectOf(row: ActivityRow, navId: bigint): string {
  if (row.cardId === navId) return '';
  const type = cardTypeLabel(row.cardType ?? '');
  const title = row.cardTitle ?? '';
  return title === '' ? type : `${type} “${clip(title, 60)}”`;
}

function readString(v: unknown, key: string): string {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return '';
  const x = (v as Record<string, unknown>)[key];
  return typeof x === 'string' ? x : '';
}

function readId(v: unknown, key?: string): string {
  const x = key === undefined ? v : v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
  if (typeof x === 'bigint') return x.toString();
  if (typeof x === 'number' && Number.isInteger(x)) return String(x);
  if (typeof x === 'string' && /^\d+$/.test(x)) return x;
  return '';
}

/** A quoted card title from the row's refs, or '' when unknown. */
function refTitle(row: ActivityRow, id: string): string {
  const t = id === '' ? undefined : row.refs?.[id];
  return t === undefined || t === '' ? '' : `“${clip(t, 60)}”`;
}

/** The single-line label of a non-attribute event. */
function eventLabel(row: ActivityRow): string {
  switch (row.kind) {
    case 'card_delete':
      return 'Deleted';
    case 'card_undelete':
      return 'Restored';
    case 'card_move': {
      const to = refTitle(row, readId(row.valueNew));
      return to === '' ? 'Moved' : `Moved under ${to}`;
    }
    case 'task_move': {
      const to = refTitle(row, readId(row.valueNew, 'new_project_id'));
      return to === '' ? 'Moved to another project' : `Moved to project ${to}`;
    }
    case 'card_merge':
      return 'Merged duplicates';
    case 'card_set_phase':
      return `Phase ${String(row.valueOld ?? '—')} → ${String(row.valueNew ?? '—')}`;
    case 'attachment_create': {
      const fn = readString(row.valueNew, 'filename');
      return fn === '' ? 'Added an attachment' : `Attached “${fn}”`;
    }
    case 'attachment_delete': {
      const fn = readString(row.valueOld, 'filename');
      return fn === '' ? 'Removed an attachment' : `Removed attachment “${fn}”`;
    }
    default: {
      const h = row.kind.replace(/_/g, ' ');
      return h.charAt(0).toUpperCase() + h.slice(1);
    }
  }
}

/**
 * Roll a group's rows (newest-first, as the feed holds them) into lines,
 * oldest-first. See the module doc for the rules.
 */
export function buildLines(navId: bigint, rowsNewestFirst: readonly ActivityRow[], userNames: IdMap = {}): FeedLine[] {
  const lines: FeedLine[] = [];
  const attrLines = new Map<string, FeedLine>();
  const tagLines = new Map<string, { line: FeedLine; added: Set<string>; removed: Set<string> }>();
  const creations = new Map<string, { line: FeedLine; at: string; actorId: bigint }>();
  const comments = new Map<string, FeedLine>();

  const newLine = (row: ActivityRow, verb: FeedLine['verb'], label: string, actor: string): FeedLine => {
    const line: FeedLine = {
      verb,
      cardId: row.cardId,
      subject: subjectOf(row, navId),
      label,
      details: [],
      count: 1,
      actors: [actor],
      at: row.createdAt,
    };
    lines.push(line);
    return line;
  };

  for (const row of [...rowsNewestFirst].reverse()) {
    const actor = resolveActor(row, userNames);
    const card = row.cardId.toString();
    const attr = row.attributeName ?? '';
    switch (row.kind) {
      case 'card_create': {
        const line = newLine(row, 'created', row.cardId === navId ? 'Created' : 'Added', actor);
        creations.set(card, { line, at: row.createdAt, actorId: row.actorId });
        continue;
      }
      case 'attr_update':
      case 'tag_apply':
      case 'tag_remove': {
        if (HIDDEN_ATTRS.has(attr)) continue;
        // A value set as part of creating the card: a detail of "Created".
        const made = creations.get(card);
        if (made !== undefined && made.at === row.createdAt && made.actorId === row.actorId) {
          if (NAME_ATTRS.has(attr) || isEmpty(row.valueNew) || isJsonText(row.valueNew)) continue;
          if (isLongText(row.valueNew)) {
            made.line.body ??= clip(String(row.valueNew));
          } else {
            made.line.details.push({ label: attrLabel(row), value: displayValue(row, row.valueNew, userNames) });
          }
          continue;
        }
        if (row.kind !== 'attr_update' || attr === 'tags') {
          let t = tagLines.get(card);
          if (t === undefined) {
            t = { line: newLine(row, 'tags', 'Tags', actor), added: new Set(), removed: new Set() };
            tagLines.set(card, t);
          } else {
            t.line.count++;
            t.line.at = row.createdAt;
            addActor(t.line, actor);
          }
          const { added, removed } = tagDiff(row);
          for (const a of added) {
            if (!t.removed.delete(a)) t.added.add(a);
          }
          for (const r of removed) {
            if (!t.added.delete(r)) t.removed.add(r);
          }
          t.line.added = [...t.added];
          t.line.removed = [...t.removed];
          continue;
        }
        const key = `${card}|${attr}`;
        const edited = [row.valueOld, row.valueNew].some((v) => isLongText(v) || isJsonText(v));
        const prev = attrLines.get(key);
        if (prev !== undefined) {
          prev.new = displayValue(row, row.valueNew, userNames);
          prev.edited = (prev.edited ?? false) || edited;
          prev.count++;
          prev.at = row.createdAt;
          addActor(prev, actor);
          continue;
        }
        const line = newLine(row, 'attr', attrLabel(row), actor);
        line.old = displayValue(row, row.valueOld, userNames);
        line.new = displayValue(row, row.valueNew, userNames);
        if (edited) line.edited = true;
        attrLines.set(key, line);
        continue;
      }
      case 'comment': {
        const line = newLine(row, 'comment', 'Commented', actor);
        if (row.commentBody !== undefined && row.commentBody !== '') line.body = clip(row.commentBody);
        comments.set(row.id.toString(), line);
        continue;
      }
      case 'approval_decision': {
        // A vote reads like a comment: the verdict and the status change it's
        // about, with its reason as the text (an edit of that folds in below).
        const vote = voteOf(row);
        const line = newLine(row, 'comment', `${voteWords(vote.decision)} · ${vote.label}`, actor);
        if (row.commentBody !== undefined && row.commentBody !== '') line.body = clip(row.commentBody);
        comments.set(row.id.toString(), line);
        continue;
      }
      case 'comment_edit': {
        // An edit of a comment in this group: the comment already shows the
        // current text, so it just says it was edited.
        const body = readString(row.valueNew, 'new_body');
        const original = comments.get(readId(row.valueNew, 'activity_id'));
        if (original !== undefined) {
          original.label = original.label === 'Commented' ? 'Commented (edited)' : `${original.label} (edited)`;
          if (body !== '') original.body = clip(body);
          original.at = row.createdAt;
          addActor(original, actor);
          continue;
        }
        const line = newLine(row, 'comment', 'Edited a comment', actor);
        if (body !== '') line.body = clip(body);
        continue;
      }
      default:
        newLine(row, 'event', eventLabel(row), actor);
    }
  }
  // Tag lines that netted out to nothing say nothing.
  return lines.filter((l) => l.verb !== 'tags' || (l.added?.length ?? 0) + (l.removed?.length ?? 0) > 0);
}

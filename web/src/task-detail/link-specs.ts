/**
 * link.list / link.set / link.delete API specs — the reads + writes backing
 * the task-detail LINKS section (code changes, issues, any URL on a task) —
 * plus the presentation tables that turn a link's `kind` / `state` slugs into
 * an icon, a label and a tone.
 *
 * Wire shapes (snake_case; ids ship as JSON strings and revive to bigint):
 *
 *   - link.list   in : { task_id }
 *       out: { rows: [{ id, task_id, url, title, kind, state, created_at,
 *                        updated_at, created_by_id, created_by }] }
 *   - link.set    in : { task_id, url, title?, kind?, state? }
 *       out: { link_id, created, changed }   — idempotent on (task_id, url)
 *   - link.delete in : { id }  out: { deleted }
 *
 * `kind` / `state` are open slugs (the server stores any short slug a forge
 * sends). The tables below name the ones this client knows; an unknown slug
 * still renders — humanised, neutral tone, generic icon.
 */

import type { Api } from '../core/api.js';
import type { IconName } from '../ui/icons.js';

export const LINK_LIST_SPEC = 'link.list';
export const LINK_SET_SPEC = 'link.set';
export const LINK_DELETE_SPEC = 'link.delete';

/* ------------------------------- web model -------------------------------- */

export interface LinkRow {
  id: bigint;
  taskId: bigint;
  url: string;
  title: string;
  kind: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  createdById: bigint;
  createdBy: string;
}

export interface LinkListInput {
  taskId: bigint;
}
export interface LinkListOutput {
  rows: LinkRow[];
}

export interface LinkSetInput {
  taskId: bigint;
  url: string;
  title?: string;
  kind?: string;
  state?: string;
}
export interface LinkSetOutput {
  linkId: bigint;
  created: boolean;
  changed: boolean;
}

export interface LinkDeleteInput {
  id: bigint;
}
export interface LinkDeleteOutput {
  deleted: boolean;
}

/* ---------------------------- presentation data --------------------------- */

/** Badge tones a link state can take (styled by `[data-tone]`). */
export type LinkTone = 'neutral' | 'progress' | 'success' | 'muted';

export interface LinkKindInfo {
  label: string;
  icon: IconName;
  /** A code-review source: its states may swap the icon (merged / abandoned). */
  codeChange: boolean;
}

export interface LinkStateInfo {
  label: string;
  tone: LinkTone;
  /** Icon a code-change link shows in this state, overriding the kind's. */
  icon?: IconName;
}

/** Known link sources. Anything else renders as a plain link. */
export const LINK_KINDS: Readonly<Record<string, LinkKindInfo>> = {
  gerrit: { label: 'Gerrit', icon: 'git-pull-request', codeChange: true },
  github: { label: 'GitHub', icon: 'git-pull-request', codeChange: true },
  gitlab: { label: 'GitLab', icon: 'git-pull-request', codeChange: true },
  issue: { label: 'Issue', icon: 'link', codeChange: false },
};

/** Known source states. Anything else renders humanised in a neutral tone. */
export const LINK_STATES: Readonly<Record<string, LinkStateInfo>> = {
  open: { label: 'Open', tone: 'progress' },
  reviewed: { label: 'Reviewed', tone: 'progress' },
  approved: { label: 'Approved', tone: 'success' },
  merged: { label: 'Merged', tone: 'success', icon: 'git-merge' },
  abandoned: { label: 'Abandoned', tone: 'muted', icon: 'git-pull-request-closed' },
};

const PLAIN_KIND: LinkKindInfo = { label: '', icon: 'link', codeChange: false };

function humanise(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** The kind's presentation; a plain link for '' / unknown slugs. */
export function linkKindInfo(kind: string): LinkKindInfo {
  return LINK_KINDS[kind] ?? (kind === '' ? PLAIN_KIND : { ...PLAIN_KIND, label: humanise(kind) });
}

/** The state's presentation, or null when the link carries no state. */
export function linkStateInfo(state: string): LinkStateInfo | null {
  if (state === '') return null;
  return LINK_STATES[state] ?? { label: humanise(state), tone: 'neutral' };
}

/** The icon a link row shows: a code-change state's icon (merged /
 *  abandoned) wins over the kind's own. */
export function linkIcon(kind: string, state: string): IconName {
  const k = linkKindInfo(kind);
  const s = linkStateInfo(state);
  return (k.codeChange ? s?.icon : undefined) ?? k.icon;
}

/** URL shapes that identify a code-change source, checked in order. A link
 *  added by hand then carries the same `kind` the forge itself reports. */
export const LINK_KIND_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'gerrit', re: /\/c\/[^?#]+\/\+\/\d+/ },
  { kind: 'github', re: /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i },
  { kind: 'gitlab', re: /\/-\/merge_requests\/\d+/ },
];

/** The kind a URL's shape implies, or '' for a plain link. */
export function guessLinkKind(url: string): string {
  return LINK_KIND_PATTERNS.find((p) => p.re.test(url))?.kind ?? '';
}

/** A compact display form of a URL: no scheme, no trailing slash
 *  ("gerrit.example.com/c/kitp/+/42"). */
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

/** True for an absolute http(s) URL without whitespace — the shape link.set
 *  accepts. Lets the add form reject a typo before the round-trip. */
export function isLinkableUrl(raw: string): boolean {
  return /^https?:\/\/\S+$/i.test(raw.trim());
}

/* ------------------------------ decode helpers ---------------------------- */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return '';
  return String(v);
}

export function decodeLinkRow(j: Record<string, unknown>): LinkRow {
  return {
    id: asId(j['id']),
    taskId: asId(j['task_id']),
    url: asStr(j['url']),
    title: asStr(j['title']),
    kind: asStr(j['kind']),
    state: asStr(j['state']),
    createdAt: asStr(j['created_at']),
    updatedAt: asStr(j['updated_at']),
    createdById: asId(j['created_by_id']),
    createdBy: asStr(j['created_by']),
  };
}

/* ------------------------------- registration ----------------------------- */

/**
 * Register the link specs against `api`. Call once at boot, BEFORE the
 * TaskDetail mounts its LINKS control. Idempotent-by-presence (`api.define`
 * throws on a duplicate key, so each define is guarded).
 */
export function registerLinkSpecs(api: Api): void {
  if (!api.registry.has({ endpoint: 'link', action: 'list' })) {
    api.define<LinkListInput, LinkListOutput>({
      endpoint: 'link',
      action: 'list',
      encode: (i) => ({ task_id: i.taskId }),
      decode: (raw): LinkListOutput => ({
        rows: asArray(asObj(raw)['rows']).map((r) => decodeLinkRow(asObj(r))),
      }),
    });
  }
  if (!api.registry.has({ endpoint: 'link', action: 'set' })) {
    api.define<LinkSetInput, LinkSetOutput>({
      endpoint: 'link',
      action: 'set',
      encode: (i) => {
        const m: Record<string, unknown> = { task_id: i.taskId, url: i.url };
        if (i.title !== undefined) m['title'] = i.title;
        if (i.kind !== undefined) m['kind'] = i.kind;
        if (i.state !== undefined) m['state'] = i.state;
        return m;
      },
      decode: (raw): LinkSetOutput => {
        const j = asObj(raw);
        return { linkId: asId(j['link_id']), created: j['created'] === true, changed: j['changed'] === true };
      },
    });
  }
  if (!api.registry.has({ endpoint: 'link', action: 'delete' })) {
    api.define<LinkDeleteInput, LinkDeleteOutput>({
      endpoint: 'link',
      action: 'delete',
      encode: (i) => ({ id: i.id }),
      decode: (raw): LinkDeleteOutput => ({ deleted: asObj(raw)['deleted'] === true }),
    });
  }
}

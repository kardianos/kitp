/**
 * Mail intake + calendar feed specs (docs/MAIL_INTAKE_AND_CALENDARS.md):
 *
 *   comm_route.list / .create / .update / .delete — a mail account's inbound
 *     routes: POST URLs for providers and SMTP addresses (admin).
 *   mail_intake.status — the SMTP listener, trusted proxies, rate limits and
 *     recent connection-level refusals (admin, in memory).
 *   calendar.list / .set / .delete, calendar_url.create / .update / .delete —
 *     a person's calendar feeds and their secret .ics URLs.
 *
 * Generic codec both ways (camelCase ↔ snake_case). Ids are normalised to
 * strings. The helpers below build the URLs and addresses a route token is
 * used in, and turn the filter form's text into a policy.
 */

import type { Api } from '../core/api.js';
import { decodeWire, encodeWire } from '../core/codec.js';

export const MAILIN_SPEC = {
  routeList: 'comm_route.list',
  routeCreate: 'comm_route.create',
  routeUpdate: 'comm_route.update',
  routeDelete: 'comm_route.delete',
  status: 'mail_intake.status',
  calendarList: 'calendar.list',
  calendarSet: 'calendar.set',
  calendarDelete: 'calendar.delete',
  urlCreate: 'calendar_url.create',
  urlUpdate: 'calendar_url.update',
  urlDelete: 'calendar_url.delete',
} as const;

/* --------------------------------- routes --------------------------------- */

export type RoutePurpose = 'inbound_post' | 'inbound_smtp';
export type RouteProvider = '' | 'raw' | 'mailgun' | 'postmark';

export interface DKIMPolicy {
  mode: 'off' | 'record' | 'require';
  domains?: string[];
  onFail?: 'refuse' | 'file';
}

/** A route's filters; every one optional (mailin.Policy). */
export interface RoutePolicy {
  sources?: string[];
  requireTls?: boolean;
  senderHosts?: string[];
  envelopeFrom?: string[];
  headerFrom?: string[];
  dkim?: DKIMPolicy;
}

export interface RouteRow {
  id: string;
  channelId: string;
  purpose: RoutePurpose;
  provider: RouteProvider;
  comment: string;
  hint: string;
  policy: RoutePolicy;
  hasSigningKey: boolean;
  createdAt: string;
  lastUsedAt: string;
  lastClient: string;
  lastError: string;
  lastErrorAt: string;
}

export interface RouteListOutput {
  routes: RouteRow[];
}

export interface RouteCreateInput {
  channelId: string | bigint;
  purpose: RoutePurpose;
  provider?: RouteProvider;
  comment?: string;
  policy?: RoutePolicy;
  signingKey?: string;
}

export interface RouteCreateOutput {
  id: string;
  token: string;
  hint: string;
  purpose: RoutePurpose;
  provider: RouteProvider;
}

export interface RouteUpdateInput {
  id: string | bigint;
  comment?: string;
  policy?: RoutePolicy;
  signingKey?: string;
}

/* --------------------------------- status --------------------------------- */

export interface MailIntakeStatus {
  smtp: { enabled: boolean; addr: string; domain: string; hostname: string; maxBytes: number; allow: string[] };
  tls: { configured: boolean; subject: string; notAfter: string; error: string };
  trustedProxies: string[];
  trustedDefault: boolean;
  limits: Record<string, number>;
  throttled: string[];
  recentRefusals: Array<{ at: string; transport: string; source: string; reason: string }>;
}

/** A status response with every field present (defaults for anything
 *  missing), so a view never reads through an absent object. */
export function normalizeStatus(raw: unknown): MailIntakeStatus {
  const o = (raw ?? {}) as Partial<MailIntakeStatus>;
  const smtp = (o.smtp ?? {}) as Partial<MailIntakeStatus['smtp']>;
  const tls = (o.tls ?? {}) as Partial<MailIntakeStatus['tls']>;
  return {
    smtp: {
      enabled: smtp.enabled === true,
      addr: smtp.addr ?? '',
      domain: smtp.domain ?? '',
      hostname: smtp.hostname ?? '',
      maxBytes: smtp.maxBytes ?? 0,
      allow: smtp.allow ?? [],
    },
    tls: { configured: tls.configured === true, subject: tls.subject ?? '', notAfter: tls.notAfter ?? '', error: tls.error ?? '' },
    trustedProxies: o.trustedProxies ?? [],
    trustedDefault: o.trustedDefault !== false,
    limits: o.limits ?? {},
    throttled: o.throttled ?? [],
    recentRefusals: o.recentRefusals ?? [],
  };
}

/* -------------------------------- calendars ------------------------------- */

export interface CalendarURLRow {
  id: string;
  comment: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string;
  lastClient: string;
  lastError: string;
  lastErrorAt: string;
}

export interface CalendarRow {
  id: string;
  title: string;
  predicate: string;
  pastDays: number;
  futureDays: number;
  urls: CalendarURLRow[];
}

export interface CalendarSetInput {
  id?: string | bigint;
  title?: string;
  predicate?: string;
  pastDays?: number;
  futureDays?: number;
}

export interface URLCreateOutput {
  id: string;
  token: string;
  hint: string;
}

/* --------------------------------- helpers -------------------------------- */

/** An id from the wire (bigint after revival, or a string / number). */
export function idStr(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v : '';
}

function normIds<T>(v: T): T {
  if (Array.isArray(v)) return v.map(normIds) as unknown as T;
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      o[k] = k === 'id' || k.endsWith('Id') ? idStr(x) : normIds(x);
    }
    return o as T;
  }
  return v;
}

/** Where providers POST mail for a route token. Mailgun posts raw MIME only
 *  to a URL ending in "mime". */
export function inboundURL(origin: string, token: string, provider: RouteProvider): string {
  const base = `${origin.replace(/\/+$/, '')}/api/v1/comm/inbound/${token}`;
  return provider === 'mailgun' ? `${base}/mime` : base;
}

/** The address the SMTP listener takes for a route token. */
export function inboundAddress(token: string, domain: string): string {
  return `${token}@${domain}`;
}

/** A calendar feed URL for a token. */
export function calendarURL(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/api/v1/calendar/${token}.ics`;
}

/** The webcal:// form some calendar apps open directly. */
export function webcalURL(httpURL: string): string {
  return httpURL.replace(/^https?:\/\//, 'webcal://');
}

/** One list entry per line or comma; blanks dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** The filter form's fields, as text. */
export interface PolicyDraft {
  sources: string;
  requireTls: boolean;
  senderHosts: string;
  envelopeFrom: string;
  headerFrom: string;
  dkimMode: 'off' | 'record' | 'require';
  dkimDomains: string;
  dkimOnFail: 'refuse' | 'file';
}

export function policyToDraft(p: RoutePolicy | undefined): PolicyDraft {
  return {
    sources: (p?.sources ?? []).join('\n'),
    requireTls: p?.requireTls === true,
    senderHosts: (p?.senderHosts ?? []).join('\n'),
    envelopeFrom: (p?.envelopeFrom ?? []).join('\n'),
    headerFrom: (p?.headerFrom ?? []).join('\n'),
    dkimMode: p?.dkim?.mode ?? 'off',
    dkimDomains: (p?.dkim?.domains ?? []).join('\n'),
    dkimOnFail: p?.dkim?.onFail ?? 'refuse',
  };
}

/** The policy a draft describes. SMTP-only filters are dropped for a POST
 *  route (they'd never apply). */
export function draftToPolicy(d: PolicyDraft, purpose: RoutePurpose): RoutePolicy {
  const p: RoutePolicy = {};
  const sources = splitList(d.sources);
  if (sources.length > 0) p.sources = sources;
  const headerFrom = splitList(d.headerFrom);
  if (headerFrom.length > 0) p.headerFrom = headerFrom;
  if (purpose === 'inbound_smtp') {
    if (d.requireTls) p.requireTls = true;
    const hosts = splitList(d.senderHosts);
    if (hosts.length > 0) p.senderHosts = hosts;
    const env = splitList(d.envelopeFrom);
    if (env.length > 0) p.envelopeFrom = env;
  }
  if (d.dkimMode !== 'off') {
    const dk: DKIMPolicy = { mode: d.dkimMode };
    const domains = splitList(d.dkimDomains);
    if (domains.length > 0) dk.domains = domains;
    if (d.dkimMode === 'require') dk.onFail = d.dkimOnFail;
    p.dkim = dk;
  }
  return p;
}

/** A one-line summary of a route's filters, for its row. */
export function policySummary(p: RoutePolicy | undefined): string {
  if (p === undefined) return 'No filters';
  const parts: string[] = [];
  if (p.sources?.length) parts.push(`from ${p.sources.join(', ')}`);
  if (p.requireTls) parts.push('TLS required');
  if (p.senderHosts?.length) parts.push(`sender host ${p.senderHosts.join(', ')}`);
  if (p.envelopeFrom?.length) parts.push(`envelope ${p.envelopeFrom.join(', ')}`);
  if (p.headerFrom?.length) parts.push(`From ${p.headerFrom.join(', ')}`);
  if (p.dkim && p.dkim.mode !== 'off') {
    const d = p.dkim.domains?.length ? ` (${p.dkim.domains.join(', ')})` : '';
    parts.push(p.dkim.mode === 'record' ? 'DKIM recorded' : `DKIM required${d}${p.dkim.onFail === 'file' ? ', filed anyway' : ''}`);
  }
  return parts.length === 0 ? 'No filters' : parts.join(' · ');
}

/** "3 hours ago"-style text for an RFC 3339 time ('' → never). */
export function sinceText(at: string, now: number = Date.now()): string {
  if (at === '') return 'never';
  const t = Date.parse(at);
  if (Number.isNaN(t)) return at;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/* ------------------------------ comm log links ----------------------------- */

/** The Comm log's filters, as they live in its URL. */
export interface CommLogFilter {
  project?: string;
  channel?: string;
  route?: string;
  kind?: string;
  window?: '1h' | '24h' | '7d' | '30d';
}

const WINDOWS = ['1h', '24h', '7d', '30d'] as const;

export function parseCommLogFilter(search: string): CommLogFilter {
  const q = new URLSearchParams(search);
  const f: CommLogFilter = {};
  const id = (k: string): string | undefined => {
    const v = q.get(k) ?? '';
    return /^\d+$/.test(v) ? v : undefined;
  };
  const project = id('project');
  if (project !== undefined) f.project = project;
  const channel = id('channel');
  if (channel !== undefined) f.channel = channel;
  const route = id('route');
  if (route !== undefined) f.route = route;
  const kind = q.get('kind') ?? '';
  if (/^[a-z_]+$/.test(kind)) f.kind = kind;
  const w = q.get('window') ?? '';
  if ((WINDOWS as readonly string[]).includes(w)) f.window = w as CommLogFilter['window'];
  return f;
}

/** The Comm log URL for a filter (what "View log" links open). */
export function commLogHref(f: CommLogFilter): string {
  const q = new URLSearchParams();
  if (f.project) q.set('project', f.project);
  if (f.channel) q.set('channel', f.channel);
  if (f.route) q.set('route', f.route);
  if (f.kind) q.set('kind', f.kind);
  if (f.window && f.window !== '24h') q.set('window', f.window);
  const s = q.toString();
  return s === '' ? '/admin/comm_log' : `/admin/comm_log?${s}`;
}

/** The `since` timestamp (RFC 3339) a window starts at. */
export function windowSince(w: CommLogFilter['window'], now: number = Date.now()): string {
  const hours = w === '1h' ? 1 : w === '7d' ? 168 : w === '30d' ? 720 : 24;
  return new Date(now - hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* ------------------------------ registration ------------------------------ */

export function registerMailinSpecs(api: Api): void {
  const define = <I, O>(endpoint: string, action: string, decode?: (raw: unknown) => O): void => {
    if (api.registry.has({ endpoint, action })) return;
    api.define<I, O>({
      endpoint,
      action,
      encode: (i) => encodeWire(i),
      decode: decode ?? ((raw) => normIds(decodeWire(raw)) as O),
    });
  };
  define<{ channelId: string | bigint }, RouteListOutput>('comm_route', 'list');
  define<RouteCreateInput, RouteCreateOutput>('comm_route', 'create');
  define<RouteUpdateInput, { id: string }>('comm_route', 'update');
  define<{ id: string | bigint }, { id: string }>('comm_route', 'delete');
  define<Record<string, never>, MailIntakeStatus>('mail_intake', 'status', (raw) => normalizeStatus(decodeWire(raw)));
  define<Record<string, never>, { calendars: CalendarRow[] }>('calendar', 'list');
  define<CalendarSetInput, { id: string }>('calendar', 'set');
  define<{ id: string | bigint }, { id: string }>('calendar', 'delete');
  define<{ calendarId: string | bigint; comment?: string }, URLCreateOutput>('calendar_url', 'create');
  define<{ id: string | bigint; comment: string }, { id: string }>('calendar_url', 'update');
  define<{ id: string | bigint }, { id: string }>('calendar_url', 'delete');
}

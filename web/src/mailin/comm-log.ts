/**
 * CommLogView — the Comm log admin screen: every message the active
 * project's mail accounts received, sent, refused or couldn't read
 * (comm_log.list), newest first.
 *
 * Filters — account, inbound route, kind, time window — live in the page
 * address (?channel=&route=&kind=&window=), so the "View log" links on
 * Comm Channels land already filtered and a view can be bookmarked. A row
 * reads as a sentence (from, subject, what it became, why it was refused)
 * with a link to the thread it became; Details shows the raw record.
 * "Detailed steps" opens this screen's help topic (admin_comm_log.md).
 *
 * Zero promises: api.callByName(..., { alive }).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ApiFault } from '../core/dispatch.js';
import { faultText } from '../admin/record-form.js';
import { ADMIN_SPEC, type CommLogListOutput, type CommLogRow } from '../admin/specs.js';
import { navigate } from '../shell/router.js';
import {
  MAILIN_SPEC,
  commLogHref,
  idStr,
  parseCommLogFilter,
  windowSince,
  type CommLogFilter,
  type RouteListOutput,
  type RouteRow,
} from './specs.js';
import { routeKindLabel } from './comm-routes.js';

export interface CommLogViewConfig extends BaseControlConfig {
  type: 'CommLogView';
  title?: string;
  /** The dotted tree path of the active project (the PROJECT section's
   *  shared 'scope.projectId'). */
  projectScopePath?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    CommLogView: CommLogViewConfig;
  }
}

/** The kinds kitp writes, with what each means (the filter's labels). */
export const COMM_LOG_KINDS: ReadonlyArray<readonly [string, string]> = [
  ['received', 'Received and filed'],
  ['duplicate', 'Duplicate (already filed)'],
  ['inbound_refused', 'Refused by a route filter'],
  ['unmatched_thread', 'Ignored (new mail, account ignores it)'],
  ['parse_error', 'Couldn’t be read'],
  ['file_error', 'Couldn’t be filed, dropped'],
  ['dkim_result', 'DKIM result (record only)'],
  ['dkim_failed', 'DKIM failed, filed anyway'],
  ['notification_reply', 'Reply to a notification, dropped'],
  ['attachments_dropped', 'Filed without its attachments'],
  ['relay_queued', 'Sent on to the rest of the thread'],
  ['relay_skipped', 'Not sent on (auto-reply, bounce…)'],
  ['poll', 'IMAP poll'],
  ['imap_auth_fail', 'IMAP sign-in failed'],
  ['send_ok', 'Sent'],
  ['send_bounce', 'Send bounced'],
  ['send_fail', 'Send failed'],
  ['notify_ok', 'Notification sent'],
  ['notify_bounce', 'Notification bounced'],
  ['notify_fail', 'Notification failed'],
];

const KIND_LABEL = new Map(COMM_LOG_KINDS);

/** Why a reply wasn't sent on to the rest of the thread (relay_skipped). */
const RELAY_SKIP_REASON: Readonly<Record<string, string>> = {
  auto_submitted: 'an automatic message (Auto-Submitted)',
  precedence: 'bulk or automatic mail (Precedence)',
  auto_reply: 'an auto-reply',
  mailing_list: 'a mailing-list post',
  report: 'a delivery or read report',
  bounce: 'a bounce',
  notification_reply: 'a reply to a notification email',
  no_from_address: 'the mail account has no From address',
  own_address: 'it came from the mail account’s own address',
  no_sender: 'it has no single sender address',
  sender_not_on_thread: 'its sender hasn’t written on the thread before, and nobody has written to them from kitp',
  too_many_recipients: 'it would go to too many people',
};

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return '';
}

/** A log row as one readable line. */
export function commLogSummary(row: Pick<CommLogRow, 'kind' | 'detail'>): string {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  const from = str(d['from']);
  const subject = str(d['subject']);
  const about = [from !== '' ? `from ${from}` : '', subject !== '' ? `“${subject}”` : ''].filter((s) => s !== '').join(' ');
  switch (row.kind) {
    case 'received': {
      const outcome = str(d['outcome']);
      const became =
        outcome === 'task' ? 'a new task and thread' : outcome === 'thread' ? 'a new thread' : outcome === 'reply' ? 'a reply on its thread' : outcome === 'ignored' ? 'nothing (the account ignores new mail)' : outcome;
      return `${about} → ${became}`.trim();
    }
    case 'duplicate':
      return `${about} — already filed`.trim();
    case 'inbound_refused':
      return `${str(d['check'])}: ${str(d['reason'])}${str(d['source']) !== '' ? ` (from ${str(d['source'])})` : ''}`;
    case 'parse_error':
      return str(d['error']);
    case 'file_error':
      return `${about} — ${str(d['error'])}`.trim();
    case 'dkim_result':
    case 'dkim_failed': {
      const ok = Array.isArray(d['verified']) ? (d['verified'] as unknown[]).map(str).join(', ') : '';
      return `${ok !== '' ? `signed by ${ok}` : 'no valid signature'}${str(d['reason']) !== '' ? ` — ${str(d['reason'])}` : ''}`;
    }
    case 'poll':
      return `${str(d['message_count'])} message(s)`;
    case 'attachments_dropped': {
      const names = Array.isArray(d['files']) ? (d['files'] as unknown[]).map(str).filter((f) => f !== '').join(', ') : '';
      return `${about} — ${str(d['count'])} left off${names !== '' ? ` (${names})` : ''}`.trim();
    }
    case 'relay_queued':
      return `${about} → a copy to ${str(d['to'])}`.trim();
    case 'relay_skipped':
      return `${about} — not sent on: ${RELAY_SKIP_REASON[str(d['reason'])] ?? str(d['reason'])}`.trim();
    default:
      return about !== '' ? about : str(d['error']);
  }
}

interface Channel {
  id: string;
  name: string;
}

export class CommLogView extends Control<CommLogViewConfig> {
  private filter: CommLogFilter = {};
  private projectId = '';
  private channels: Channel[] = [];
  private routes: RouteRow[] = [];
  private rows: CommLogRow[] = [];
  private loaded = false;
  private error = '';
  private open = new Set<string>();
  private seq = 0;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'mi-view';
    el.dataset.control = 'CommLogView';
    return el;
  }

  protected render(): void {
    this.filter = parseCommLogFilter(typeof location !== 'undefined' ? location.search : '');
    this.effect(() => {
      const pid = idStr(this.ctx.tree.at((this.config.projectScopePath ?? 'scope.projectId').split('.')).get<unknown>());
      if (pid !== this.projectId) {
        const first = this.projectId === '';
        this.projectId = pid;
        if (!first) {
          // Another project: its accounts and routes differ.
          this.filter = { ...(this.filter.kind ? { kind: this.filter.kind } : {}), ...(this.filter.window ? { window: this.filter.window } : {}) };
          this.writeURL();
        }
        this.channels = [];
        this.routes = [];
        this.loadChannels();
        this.loadRoutes();
        this.load();
      }
      this.paint();
    }, 'commLog.scope');
  }

  private writeURL(): void {
    if (typeof history === 'undefined' || typeof location === 'undefined') return;
    const href = commLogHref(this.filter);
    if (location.pathname + location.search !== href) history.replaceState({ path: href }, '', href);
  }

  private setFilter(next: CommLogFilter): void {
    const channelChanged = next.channel !== this.filter.channel;
    this.filter = next;
    if (channelChanged) {
      delete this.filter.route;
      this.routes = [];
      this.loadRoutes();
    }
    this.writeURL();
    this.load();
  }

  private loadChannels(): void {
    if (this.projectId === '') return;
    this.ctx.api.callByName(
      ADMIN_SPEC.commChannelList,
      { projectId: this.projectId },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out ?? {}) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
        this.channels = rows.map((r) => ({ id: idStr(r['id']), name: str(r['name']) }));
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private loadRoutes(): void {
    const channel = this.filter.channel;
    if (channel === undefined) return;
    this.ctx.api.callByName(
      MAILIN_SPEC.routeList,
      { channelId: channel },
      (out) => {
        if (!this.isAlive() || channel !== this.filter.channel) return;
        this.routes = (out as RouteListOutput).routes ?? [];
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private load(): void {
    if (this.projectId === '') return;
    const seq = ++this.seq;
    this.loaded = false;
    this.error = '';
    const input: Record<string, unknown> = { projectId: this.projectId, since: windowSince(this.filter.window), limit: 500 };
    if (this.filter.kind) input['kind'] = this.filter.kind;
    if (this.filter.channel) input['channelId'] = this.filter.channel;
    if (this.filter.route) input['routeId'] = this.filter.route;
    this.ctx.api.callByName(
      ADMIN_SPEC.commLogList,
      input,
      (out) => {
        if (!this.isAlive() || seq !== this.seq) return;
        this.rows = (out as CommLogListOutput).rows ?? [];
        this.loaded = true;
        this.paint();
      },
      {
        alive: () => this.isAlive(),
        onErr: (f: ApiFault) => {
          if (seq !== this.seq) return;
          this.error = faultText(f);
          this.loaded = true;
          this.paint();
        },
      },
    );
    this.paint();
  }

  /* -------------------------------- painting ------------------------------- */

  private paint(): void {
    const head = document.createElement('header');
    head.append(el('h1', 'mi-view__title', this.config.title ?? 'Comm Log'));
    const hint = el(
      'p',
      'mi-hint',
      'What the project’s mail accounts received, sent, refused or couldn’t read. Filter by account, route, kind and time; the filters are part of the page address, so a view can be bookmarked or shared. Times are your browser’s.',
    );
    hint.append(document.createTextNode(' '), this.button('Detailed steps', () => this.ctx.bus?.emit('toggleInstructions', undefined), 'mi-link'));
    head.append(hint);
    if (this.projectId === '') {
      this.el.replaceChildren(head, el('p', 'muted', 'Pick a project first.'));
      return;
    }
    const parts: HTMLElement[] = [head, this.renderFilters()];
    if (this.error !== '') parts.push(el('p', 'mi-error', this.error));
    parts.push(this.renderRows());
    this.el.replaceChildren(...parts);
  }

  private renderFilters(): HTMLElement {
    const bar = el('div', 'mi-filterbar');
    bar.dataset.commLogFilters = '';
    const select = (field: string, label: string, opts: Array<[string, string]>, value: string, onChange: (v: string) => void): void => {
      const s = document.createElement('select');
      s.dataset.filter = field;
      for (const [v, text] of opts) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = text;
        o.selected = v === value;
        s.append(o);
      }
      this.listen(s, 'change', () => onChange(s.value));
      const l = document.createElement('label');
      l.className = 'mi-field';
      l.append(el('span', 'mi-field__label', label), s);
      bar.append(l);
    };
    const chanOpts: Array<[string, string]> = [['', 'All accounts'], ...this.channels.map((c): [string, string] => [c.id, c.name || `Account ${c.id}`])];
    if (this.filter.channel && !this.channels.some((c) => c.id === this.filter.channel)) chanOpts.push([this.filter.channel, `Account ${this.filter.channel}`]);
    select('channel', 'Account', chanOpts, this.filter.channel ?? '', (v) => this.setFilter({ ...this.filter, channel: v === '' ? undefined : v }));
    if (this.filter.channel) {
      const routeOpts: Array<[string, string]> = [
        ['', 'All routes'],
        ...this.routes.map((r): [string, string] => [r.id, `${routeKindLabel(r)} …${r.hint}${r.comment !== '' ? ` — ${r.comment}` : ''}`]),
      ];
      if (this.filter.route && !this.routes.some((r) => r.id === this.filter.route)) routeOpts.push([this.filter.route, `Route ${this.filter.route}`]);
      select('route', 'Route', routeOpts, this.filter.route ?? '', (v) => this.setFilter({ ...this.filter, route: v === '' ? undefined : v }));
    }
    select('kind', 'Kind', [['', 'Any'], ...COMM_LOG_KINDS.map(([k, l]): [string, string] => [k, l])], this.filter.kind ?? '', (v) =>
      this.setFilter({ ...this.filter, kind: v === '' ? undefined : v }),
    );
    select(
      'window',
      'Since',
      [
        ['1h', 'Last hour'],
        ['24h', 'Last 24 hours'],
        ['7d', 'Last 7 days'],
        ['30d', 'Last 30 days'],
      ],
      this.filter.window ?? '24h',
      (v) => this.setFilter({ ...this.filter, window: v as CommLogFilter['window'] }),
    );
    return bar;
  }

  private renderRows(): HTMLElement {
    const list = el('div', 'mi-list');
    list.dataset.commLogRows = '';
    if (!this.loaded) {
      list.append(el('p', 'muted', 'Loading…'));
      return list;
    }
    if (this.rows.length === 0) {
      list.append(el('p', 'muted', 'Nothing logged for these filters. Widen the time window, or check the account’s routes on Comm Channels.'));
      return list;
    }
    for (const r of this.rows) {
      const row = el('div', 'mi-card mi-logrow');
      row.dataset.logKind = r.kind;
      const top = el('div', 'mi-card__head');
      const when = r.at !== '' ? new Date(r.at).toLocaleString() : '';
      top.append(el('span', 'mi-hint', when), el('span', 'mi-badge', KIND_LABEL.get(r.kind) ?? r.kind));
      if (r.channel_name) top.append(el('span', 'mi-hint', r.channel_name));
      const d = (r.detail ?? {}) as Record<string, unknown>;
      const transport = str(d['transport']);
      if (transport !== '') top.append(el('span', 'mi-hint', transport.toUpperCase()));
      row.append(top, el('p', '', commLogSummary(r)));
      const actions = el('div', 'mi-actions');
      const card = idStr(d['card_id']);
      if (card !== '' && card !== '0') {
        const open = this.button('Open thread', () => navigate(`/thread/${card}`), 'mi-link');
        open.dataset.logCard = card;
        actions.append(open);
      }
      if (r.route_id && r.route_id !== this.filter.route && r.channel_id) {
        actions.append(this.button('Only this route', () => this.setFilter({ ...this.filter, channel: r.channel_id, route: r.route_id }), 'mi-link'));
      }
      const expanded = this.open.has(r.id);
      actions.append(
        this.button(expanded ? 'Hide details' : 'Details', () => {
          if (expanded) this.open.delete(r.id);
          else this.open.add(r.id);
          this.paint();
        }, 'mi-link'),
      );
      row.append(actions);
      if (expanded) {
        const pre = document.createElement('pre');
        pre.className = 'mi-pre';
        pre.textContent = JSON.stringify(r.detail ?? {}, null, 2);
        row.append(pre);
      }
      list.append(row);
    }
    return list;
  }

  private button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`.trim();
    b.textContent = label;
    this.listen(b, 'click', onClick);
    return b;
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls !== '') e.className = cls;
  if (text !== undefined) e.append(document.createTextNode(text));
  return e;
}

export function registerCommLogView(): void {
  Control.register('CommLogView', CommLogView);
}

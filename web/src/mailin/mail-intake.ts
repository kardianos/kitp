/**
 * MailIntake — the workspace "Mail intake" admin screen
 * (docs/MAIL_INTAKE_AND_CALENDARS.md §7): how mail reaches kitp from
 * outside, install-wide.
 *
 *   - the SMTP listener: on or off, its address and domain, the STARTTLS
 *     certificate and when it expires, the install allowlist;
 *   - trusted proxies (whose X-Forwarded-For / PROXY header is believed);
 *   - the rate limits, and which sources are throttled now;
 *   - the last connection-level refusals (a PROXY header from an untrusted
 *     peer, a client that spoke before the greeting, an unknown address…).
 *
 * All of it comes from mail_intake.status, which reads memory: the limits
 * and refusals reset when kitp restarts. Settings come from environment
 * variables, named next to each value; "Detailed steps" opens the help
 * topic (admin_mail_intake.md): MX and port 25, certificates, proxies.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { MAILIN_SPEC, type MailIntakeStatus } from './specs.js';

export interface MailIntakeConfig extends BaseControlConfig {
  type: 'MailIntake';
  title?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    MailIntake: MailIntakeConfig;
  }
}

/** Days until an RFC 3339 time (negative = past). */
export function daysUntil(at: string, now: number = Date.now()): number {
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : Math.floor((t - now) / 86_400_000);
}

export class MailIntake extends Control<MailIntakeConfig> {
  private status: MailIntakeStatus | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'mi-view';
    el.dataset.control = 'MailIntake';
    return el;
  }

  protected render(): void {
    this.paint();
    this.load();
  }

  private load(): void {
    this.ctx.api.callByName(
      MAILIN_SPEC.status,
      {},
      (out) => {
        if (!this.isAlive()) return;
        this.status = out as MailIntakeStatus;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private paint(): void {
    const head = document.createElement('header');
    head.append(el('h1', 'mi-view__title', this.config.title ?? 'Mail intake'));
    const hint = el(
      'p',
      'mi-hint',
      'How mail reaches kitp besides IMAP polling: providers POST to a mail account’s routes (Comm Channels), and kitp’s own SMTP listener takes mail for route addresses. These settings come from environment variables; the counts below are kept in memory and reset when kitp restarts.',
    );
    hint.append(document.createTextNode(' '), this.button('Detailed steps', () => this.ctx.bus?.emit('toggleInstructions', undefined), 'mi-link'));
    const refresh = this.button('Refresh', () => this.load());
    head.append(hint, refresh);
    const s = this.status;
    if (s === null) {
      this.el.replaceChildren(head, el('p', 'muted', 'Loading…'));
      return;
    }

    const smtp = this.card('SMTP listener');
    smtp.dataset.miSmtp = '';
    if (!s.smtp.enabled) {
      smtp.append(el('p', 'mi-hint', 'Off. Set KITP_SMTP_ADDR (e.g. :2525, with port 25 in front of it) and KITP_SMTP_DOMAIN to receive mail for SMTP route addresses.'));
    } else {
      smtp.append(
        props([
          ['Listening on', s.smtp.addr, 'KITP_SMTP_ADDR'],
          ['Route addresses', `…@${s.smtp.domain}`, 'KITP_SMTP_DOMAIN — its MX record must point here'],
          ['Greeting name', s.smtp.hostname, 'KITP_SMTP_HOSTNAME'],
          ['Largest message', `${Math.round(s.smtp.maxBytes / 1048576)} MB`, 'KITP_SMTP_MAX_BYTES'],
          ['Accepted from', s.smtp.allow.length === 0 ? 'Anywhere' : s.smtp.allow.join(', '), 'KITP_SMTP_ALLOW'],
        ]),
      );
    }
    const tls = this.card('STARTTLS certificate');
    tls.dataset.miTls = '';
    if (!s.tls.configured) {
      tls.append(el('p', 'mi-hint', 'None: senders deliver without encryption. Set KITP_SMTP_TLS_CERT and KITP_SMTP_TLS_KEY (PEM files; re-read when they change, e.g. by cert-manager).'));
    } else {
      const days = daysUntil(s.tls.notAfter);
      tls.append(
        props([
          ['Names', s.tls.subject, ''],
          ['Expires', s.tls.notAfter === '' ? '—' : `${new Date(s.tls.notAfter).toLocaleDateString()} (${days} days)`, ''],
        ]),
      );
      if (s.tls.error !== '') tls.append(el('p', 'mi-error', `Couldn’t load the files: ${s.tls.error}`));
      else if (days < 14) tls.append(el('p', 'mi-error', 'Expires soon — check that renewal is running.'));
    }
    const proxies = this.card('Trusted proxies');
    proxies.append(
      el(
        'p',
        'mi-hint',
        s.trustedDefault
          ? 'Any private or loopback address but 100.64.0.0/10 (KITP_TRUSTED_PROXIES is unset). A PROXY header (SMTP) or X-Forwarded-For (POST) is believed only from these.'
          : 'Only these (KITP_TRUSTED_PROXIES). A PROXY header (SMTP) or X-Forwarded-For (POST) is believed only from them.',
      ),
      el('p', '', s.trustedProxies.join(', ')),
    );
    const limits = this.card('Rate limits');
    const l = s.limits;
    limits.append(
      props([
        ['Requests / connections per source', `${l['perSourcePerMinute'] ?? 0} a minute (bursts of ${l['perSourceBurst'] ?? 0})`, ''],
        ['Messages per source', `${l['messagesPerMinute'] ?? 0} a minute`, ''],
        ['Messages per route', `${l['perRoutePerMinute'] ?? 0} a minute`, ''],
        ['A miss (unknown address, bad token, refused) counts as', `${l['missCost'] ?? 0} requests`, ''],
        ['Open connections', `${l['connectionsPerSource'] ?? 0} per source, ${l['connectionsTotal'] ?? 0} in all`, ''],
      ]),
      el('p', 'mi-hint', s.throttled.length === 0 ? 'Nobody is throttled now.' : `Throttled now: ${s.throttled.join(', ')}`),
    );
    const refusals = this.card('Recent refusals');
    refusals.dataset.miRefusals = '';
    refusals.append(el('p', 'mi-hint', 'Turned away before reaching a mail account (so not in any Comm log). Refusals by a route’s own filters are in the Comm log, on the route.'));
    if (s.recentRefusals.length === 0) refusals.append(el('p', 'muted', 'None since kitp started.'));
    for (const r of s.recentRefusals.slice(0, 100)) {
      const row = el('div', 'mi-card__head');
      row.append(el('span', 'mi-hint', new Date(r.at).toLocaleString()), el('span', 'mi-badge', r.transport.toUpperCase()), el('span', '', r.source), el('span', 'mi-hint', r.reason));
      refusals.append(row);
    }
    this.el.replaceChildren(head, smtp, tls, proxies, limits, refusals);
  }

  private card(title: string): HTMLElement {
    const c = el('div', 'mi-card');
    c.append(el('h3', 'mi-card__title', title));
    return c;
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

function props(rows: Array<[string, string, string]>): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = 'mi-props';
  for (const [k, v, env] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.append(document.createTextNode(v === '' ? '—' : v));
    if (env !== '') dd.append(el('span', 'mi-hint', ` ${env}`));
    dl.append(dt, dd);
  }
  return dl;
}

export function registerMailIntake(): void {
  Control.register('MailIntake', MailIntake);
}

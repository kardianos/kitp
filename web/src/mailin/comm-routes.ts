/**
 * CommRoutes — the RECEIVING MAIL panel of the Comm Channels admin screen
 * (docs/MAIL_INTAKE_AND_CALENDARS.md §5–7): the ways mail reaches the
 * selected account besides IMAP polling.
 *
 *   - POST routes: a URL a provider sends each message to (raw — Cloudflare
 *     Email Worker, SES via Lambda, scripts —, Mailgun, Postmark).
 *   - SMTP routes: an address for kitp's own SMTP listener (forward or
 *     redirect a mailbox to it, e.g. from Exchange).
 *
 * Each row shows its comment, the token's first characters, its filters,
 * the last message and the last refusal, with View log (the Comm log
 * filtered to the route). Adding a route shows its secret URL / address
 * ONCE. Short instructions are on the panel; "Detailed steps" opens this
 * screen's help topic (admin_comm_channels.md).
 *
 * It follows the master's `${parentScope}.selectedId` + `.items`. Zero
 * promises: every call is api.callByName(..., { alive }).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ApiFault } from '../core/dispatch.js';
import type { MasterDetailItem } from '../admin/master-detail.js';
import { faultText } from '../admin/record-form.js';
import { navigate } from '../shell/router.js';
import {
  MAILIN_SPEC,
  commLogHref,
  draftToPolicy,
  idStr,
  inboundAddress,
  inboundURL,
  policySummary,
  policyToDraft,
  sinceText,
  type MailIntakeStatus,
  type PolicyDraft,
  type RouteCreateOutput,
  type RouteListOutput,
  type RoutePurpose,
  type RouteProvider,
  type RouteRow,
} from './specs.js';

export interface CommRoutesConfig extends BaseControlConfig {
  type: 'CommRoutes';
  /** The MasterDetail scope whose `.selectedId` / `.items` this follows. */
  parentScope: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    CommRoutes: CommRoutesConfig;
  }
}

/** The steps shown on the page for each kind of route. */
export const ROUTE_STEPS: Record<string, string> = {
  raw: 'Send each message to this URL as the raw message body (Content-Type: message/rfc822). Use it for a Cloudflare Email Worker, Amazon SES (S3 + a Lambda), or your own script.',
  mailgun:
    'In Mailgun: Receiving → Create route → action forward("<this URL>"). The URL ends in /mime so Mailgun sends the raw message. Paste the HTTP webhook signing key (Mailgun → Settings → Webhooks) below; kitp checks every request with it.',
  postmark:
    'In Postmark: your server → Default Inbound Stream → Settings → Webhook: this URL. Turn on "Include raw email content in JSON payload" — kitp files the raw message. Postmark doesn\'t sign requests, so consider the Sources filter with Postmark\'s published addresses.',
  smtp: 'Forward or redirect a mailbox to the address shown after you save. Exchange / Microsoft 365: a mailbox forward, or an Inbox rule\'s "Redirect to" (not "Forward to"), and allow automatic external forwarding for that mailbox. The address is the secret; keep it to the forwarding rule.',
};

const PROVIDER_LABEL: Record<string, string> = {
  raw: 'Raw message (Cloudflare Worker, SES via Lambda, scripts)',
  mailgun: 'Mailgun',
  postmark: 'Postmark',
};

/** What a route row's kind reads as. */
export function routeKindLabel(r: Pick<RouteRow, 'purpose' | 'provider'>): string {
  if (r.purpose === 'inbound_smtp') return 'SMTP address';
  return `POST · ${r.provider === 'raw' ? 'Raw' : (PROVIDER_LABEL[r.provider] ?? r.provider)}`;
}

interface FormState {
  /** '' = adding. */
  id: string;
  purpose: RoutePurpose;
  provider: RouteProvider;
  comment: string;
  signingKey: string;
  hasSigningKey: boolean;
  policy: PolicyDraft;
  error: string;
  busy: boolean;
}

/** The secret a route was just made with — shown once. */
interface Minted {
  routeId: string;
  text: string;
  isAddress: boolean;
}

export class CommRoutes extends Control<CommRoutesConfig> {
  private channelId = '';
  private routes: RouteRow[] = [];
  private loaded = false;
  private status: MailIntakeStatus | null = null;
  private form: FormState | null = null;
  private minted: Minted | null = null;
  private confirmDelete = '';
  private error = '';

  private get selectedPath(): string[] {
    return `${this.config.parentScope}.selectedId`.split('.');
  }
  private get itemsPath(): string[] {
    return `${this.config.parentScope}.items`.split('.');
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'mi-routes';
    el.dataset.control = 'CommRoutes';
    return el;
  }

  protected render(): void {
    this.effect(() => {
      const sel = this.ctx.tree.at(this.selectedPath).get<string | null>() ?? null;
      const items = (this.ctx.tree.at(this.itemsPath).get<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      const item = sel === null ? undefined : items.find((it) => it.id === sel);
      const id = item === undefined ? '' : idStr((item.raw as Record<string, unknown>)['id']);
      if (id !== this.channelId) {
        this.channelId = /^\d+$/.test(id) && id !== '0' ? id : '';
        this.routes = [];
        this.loaded = false;
        this.form = null;
        this.minted = null;
        this.confirmDelete = '';
        this.error = '';
        if (this.channelId !== '') this.load();
      }
      this.paint();
    }, 'commRoutes.render');
    this.ctx.api.callByName(
      MAILIN_SPEC.status,
      {},
      (out) => {
        if (!this.isAlive()) return;
        this.status = out as MailIntakeStatus;
        this.paint();
      },
      { alive: () => this.isAlive(), onErr: () => undefined },
    );
  }

  private load(): void {
    const channel = this.channelId;
    this.ctx.api.callByName(
      MAILIN_SPEC.routeList,
      { channelId: channel },
      (out) => {
        if (!this.isAlive() || channel !== this.channelId) return;
        this.routes = (out as RouteListOutput).routes ?? [];
        this.loaded = true;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  /* -------------------------------- painting ------------------------------- */

  private paint(): void {
    const heading = el('h3', 'mi-routes__heading muted', 'RECEIVING MAIL');
    if (this.channelId === '') {
      this.el.replaceChildren(heading, el('p', 'muted', 'Save the account to add ways for mail to reach it.'));
      return;
    }
    const intro = el(
      'p',
      'mi-hint',
      'Besides IMAP polling (above), mail can reach this account through routes. A POST route is a URL a mail provider sends each message to; an SMTP route is an address for kitp’s own mail listener — forward a mailbox to it. Each route has its own secret, so make one per sender and revoke them one at a time. Copies that arrive more than once are filed once.',
    );
    intro.dataset.routesIntro = '';
    const steps = this.button('Detailed steps', () => this.ctx.bus?.emit('toggleInstructions', undefined), 'mi-link');
    steps.dataset.routesHelp = '';
    intro.append(document.createTextNode(' '), steps);

    const parts: HTMLElement[] = [heading, intro];
    if (this.minted !== null) parts.push(this.renderMinted(this.minted));
    parts.push(this.renderList());
    if (this.form !== null) parts.push(this.renderForm(this.form));
    else parts.push(this.renderAdd());
    if (this.error !== '') parts.push(el('p', 'mi-error', this.error));
    this.el.replaceChildren(...parts);
  }

  private renderList(): HTMLElement {
    const list = el('div', 'mi-list');
    list.dataset.routesList = '';
    if (!this.loaded) {
      list.append(el('p', 'muted', 'Loading…'));
      return list;
    }
    if (this.routes.length === 0) {
      list.append(el('p', 'muted', 'No routes yet: this account receives mail by IMAP polling only.'));
    }
    for (const r of this.routes) {
      const card = el('div', 'mi-card');
      card.dataset.route = r.id;
      const head = el('div', 'mi-card__head');
      head.append(el('strong', '', routeKindLabel(r)), el('span', 'mi-badge', `…${r.hint}`));
      if (r.comment !== '') head.append(el('span', '', r.comment));
      card.append(head);
      card.append(el('p', 'mi-hint', policySummary(r.policy)));
      const last = el('p', 'mi-hint');
      last.textContent =
        r.lastUsedAt === '' ? 'No message yet.' : `Last message ${sinceText(r.lastUsedAt)}${r.lastClient !== '' ? ` from ${r.lastClient}` : ''}.`;
      card.append(last);
      if (r.lastError !== '') {
        const err = el('p', 'mi-error', `Last refusal ${sinceText(r.lastErrorAt)}: ${r.lastError}`);
        err.dataset.routeError = '';
        card.append(err);
      }
      if (r.purpose === 'inbound_smtp' && this.status !== null && !this.status.smtp.enabled) {
        card.append(el('p', 'mi-error', 'The SMTP listener is off (KITP_SMTP_ADDR isn’t set): this address receives nothing until it’s on. See Admin → Mail intake.'));
      }
      const actions = el('div', 'mi-actions');
      const log = this.button('View log', () => navigate(commLogHref({ channel: this.channelId, route: r.id })));
      log.dataset.routeLog = r.id;
      actions.append(log, this.button('Edit', () => this.openEdit(r)));
      if (this.confirmDelete === r.id) {
        actions.append(
          el('span', 'mi-error', 'Delete? Its URL or address stops working at once.'),
          this.button('Delete', () => this.remove(r.id), 'btn-danger'),
          this.button('Cancel', () => {
            this.confirmDelete = '';
            this.paint();
          }),
        );
      } else {
        actions.append(
          this.button('Delete…', () => {
            this.confirmDelete = r.id;
            this.paint();
          }),
        );
      }
      card.append(actions);
      list.append(card);
    }
    const all = this.button('View this account’s log', () => navigate(commLogHref({ channel: this.channelId })), 'mi-link');
    all.dataset.channelLog = '';
    list.append(all);
    return list;
  }

  private renderAdd(): HTMLElement {
    const row = el('div', 'mi-actions');
    const post = this.button('+ POST URL', () => this.openAdd('inbound_post'));
    post.dataset.addPost = '';
    const smtp = this.button('+ SMTP address', () => this.openAdd('inbound_smtp'));
    smtp.dataset.addSmtp = '';
    row.append(post, smtp);
    return row;
  }

  private renderMinted(m: Minted): HTMLElement {
    const box = el('div', 'mi-secret');
    box.dataset.minted = '';
    box.append(el('strong', '', m.isAddress ? 'The route’s address' : 'The route’s URL'));
    const value = document.createElement('input');
    value.readOnly = true;
    value.value = m.text;
    value.className = 'mi-secret__value';
    value.dataset.mintedValue = '';
    const copy = this.button('Copy', () => {
      value.select();
      if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(m.text);
    });
    box.append(value, copy);
    box.append(
      el(
        'p',
        'mi-hint',
        'Shown only now — kitp keeps just a fingerprint of the secret. Lost it? Add another route and delete this one.',
      ),
    );
    box.append(this.button('Done', () => {
      this.minted = null;
      this.paint();
    }));
    return box;
  }

  private renderForm(f: FormState): HTMLElement {
    const box = el('div', 'mi-form');
    box.dataset.routeForm = f.id === '' ? 'new' : f.id;
    box.append(el('h4', '', f.id === '' ? (f.purpose === 'inbound_post' ? 'New POST URL' : 'New SMTP address') : 'Edit route'));

    if (f.purpose === 'inbound_post') {
      if (f.id === '') {
        const sel = document.createElement('select');
        sel.dataset.field = 'provider';
        for (const p of ['raw', 'mailgun', 'postmark']) {
          const o = document.createElement('option');
          o.value = p;
          o.textContent = PROVIDER_LABEL[p] ?? p;
          o.selected = f.provider === p;
          sel.append(o);
        }
        this.listen(sel, 'change', () => {
          f.provider = sel.value as RouteProvider;
          this.paint();
        });
        box.append(labelled('Provider', sel));
      }
      box.append(el('p', 'mi-hint', ROUTE_STEPS[f.provider] ?? ''));
    } else {
      box.append(el('p', 'mi-hint', ROUTE_STEPS['smtp'] ?? ''));
      if (this.status !== null && this.status.smtp.enabled) {
        box.append(el('p', 'mi-hint', `Addresses end in @${this.status.smtp.domain}.`));
      }
    }

    box.append(labelled('Comment', this.input(f.comment, (v) => (f.comment = v), 'comment', 'What it’s for, e.g. “Exchange forward”')));
    if (f.provider === 'mailgun') {
      const key = this.input(f.signingKey, (v) => (f.signingKey = v), 'signingKey', f.hasSigningKey ? 'Set — type a new one to replace it' : 'Mailgun HTTP webhook signing key');
      key.type = 'password';
      box.append(labelled('Signing key', key));
    }

    const details = document.createElement('details');
    details.className = 'mi-filters';
    details.open = f.id !== '';
    details.append(el('summary', '', 'Filters (optional)'));
    const d = f.policy;
    details.append(
      el('p', 'mi-hint', 'Lists take one entry per line. Addresses: a@b.com is that address, b.com that domain, .b.com any subdomain of b.com. A message a filter refuses is logged on the route.'),
      labelled('Sources', this.area(d.sources, (v) => (d.sources = v), 'sources', 'CIDRs, e.g. 40.92.0.0/15'), 'Only accept from these networks (the client address, through trusted proxies).'),
    );
    if (f.purpose === 'inbound_smtp') {
      const tls = document.createElement('input');
      tls.type = 'checkbox';
      tls.checked = d.requireTls;
      tls.dataset.field = 'requireTls';
      this.listen(tls, 'change', () => (d.requireTls = tls.checked));
      details.append(
        labelled('Require TLS', tls, 'Refuse senders that don’t use STARTTLS.'),
        labelled('Sender hosts', this.area(d.senderHosts, (v) => (d.senderHosts = v), 'senderHosts', '.outbound.protection.outlook.com'), 'The sender’s reverse DNS name, confirmed back to its address, must end with one of these. Exchange Online: .outbound.protection.outlook.com.'),
        labelled('Envelope sender', this.area(d.envelopeFrom, (v) => (d.envelopeFrom = v), 'envelopeFrom', 'example.com'), 'MAIL FROM. An Exchange forward’s is bounces+SRS=…@your domain.'),
      );
    }
    details.append(
      labelled('From (header)', this.area(d.headerFrom, (v) => (d.headerFrom = v), 'headerFrom', 'example.com'), 'The From: line. Without DKIM it’s only what the sender claims.'),
    );
    const mode = document.createElement('select');
    mode.dataset.field = 'dkimMode';
    for (const [v, label] of [
      ['off', 'Off'],
      ['record', 'Record only (log the result, never refuse)'],
      ['require', 'Require a valid signature'],
    ] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      o.selected = d.dkimMode === v;
      mode.append(o);
    }
    this.listen(mode, 'change', () => {
      d.dkimMode = mode.value as PolicyDraft['dkimMode'];
      this.paint();
    });
    details.append(labelled('DKIM', mode, 'Forwarding can break the original sender’s signature; try Record only first and read the log.'));
    if (d.dkimMode !== 'off') {
      details.append(labelled('Signed by', this.area(d.dkimDomains, (v) => (d.dkimDomains = v), 'dkimDomains', 'example.com'), 'Domains whose signature counts; empty = any valid signature.'));
    }
    if (d.dkimMode === 'require') {
      const onFail = document.createElement('select');
      onFail.dataset.field = 'dkimOnFail';
      for (const [v, label] of [
        ['refuse', 'Refuse the message'],
        ['file', 'File it, and note the failure in the log'],
      ] as const) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        o.selected = d.dkimOnFail === v;
        onFail.append(o);
      }
      this.listen(onFail, 'change', () => (d.dkimOnFail = onFail.value as PolicyDraft['dkimOnFail']));
      details.append(labelled('When it fails', onFail));
    }
    box.append(details);

    if (f.error !== '') box.append(el('p', 'mi-error', f.error));
    const actions = el('div', 'mi-actions');
    const save = this.button(f.id === '' ? 'Create route' : 'Save', () => this.save(f), 'btn-primary');
    save.disabled = f.busy;
    save.dataset.routeSave = '';
    actions.append(save, this.button('Cancel', () => {
      this.form = null;
      this.paint();
    }));
    box.append(actions);
    return box;
  }

  /* -------------------------------- actions -------------------------------- */

  private openAdd(purpose: RoutePurpose): void {
    this.minted = null;
    this.form = {
      id: '',
      purpose,
      provider: purpose === 'inbound_post' ? 'raw' : '',
      comment: '',
      signingKey: '',
      hasSigningKey: false,
      policy: policyToDraft(undefined),
      error: '',
      busy: false,
    };
    this.paint();
  }

  private openEdit(r: RouteRow): void {
    this.minted = null;
    this.form = {
      id: r.id,
      purpose: r.purpose,
      provider: r.provider,
      comment: r.comment,
      signingKey: '',
      hasSigningKey: r.hasSigningKey,
      policy: policyToDraft(r.policy),
      error: '',
      busy: false,
    };
    this.paint();
  }

  private save(f: FormState): void {
    if (f.provider === 'mailgun' && f.id === '' && f.signingKey.trim() === '') {
      f.error = 'A Mailgun route needs its webhook signing key.';
      this.paint();
      return;
    }
    f.busy = true;
    f.error = '';
    this.paint();
    const policy = draftToPolicy(f.policy, f.purpose);
    const fail = (fault: ApiFault): void => {
      if (!this.isAlive()) return;
      f.busy = false;
      f.error = faultText(fault).replace(/^comm_route\.[a-z]+: /, '');
      this.paint();
    };
    if (f.id === '') {
      const input: Record<string, unknown> = { channelId: this.channelId, purpose: f.purpose, comment: f.comment, policy };
      if (f.purpose === 'inbound_post') input['provider'] = f.provider;
      if (f.signingKey.trim() !== '') input['signingKey'] = f.signingKey.trim();
      this.ctx.api.callByName(
        MAILIN_SPEC.routeCreate,
        input,
        (out) => {
          if (!this.isAlive()) return;
          const o = out as RouteCreateOutput;
          const origin = typeof location !== 'undefined' ? location.origin : '';
          const isAddress = o.purpose === 'inbound_smtp';
          const domain = this.status?.smtp.domain || 'your KITP_SMTP_DOMAIN';
          this.minted = {
            routeId: o.id,
            isAddress,
            text: isAddress ? inboundAddress(o.token, domain) : inboundURL(origin, o.token, o.provider),
          };
          this.form = null;
          this.load();
          this.paint();
        },
        { alive: () => this.isAlive(), onErr: fail },
      );
      return;
    }
    const input: Record<string, unknown> = { id: f.id, comment: f.comment, policy };
    if (f.provider === 'mailgun' && f.signingKey.trim() !== '') input['signingKey'] = f.signingKey.trim();
    this.ctx.api.callByName(
      MAILIN_SPEC.routeUpdate,
      input,
      () => {
        if (!this.isAlive()) return;
        this.form = null;
        this.load();
        this.paint();
      },
      { alive: () => this.isAlive(), onErr: fail },
    );
  }

  private remove(id: string): void {
    this.ctx.api.callByName(
      MAILIN_SPEC.routeDelete,
      { id },
      () => {
        if (!this.isAlive()) return;
        this.confirmDelete = '';
        if (this.minted?.routeId === id) this.minted = null;
        this.load();
      },
      {
        alive: () => this.isAlive(),
        onErr: (fault: ApiFault) => {
          this.error = faultText(fault);
          this.paint();
        },
      },
    );
  }

  /* --------------------------------- bits --------------------------------- */

  private button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`.trim();
    b.textContent = label;
    this.listen(b, 'click', onClick);
    return b;
  }

  private input(value: string, onInput: (v: string) => void, field: string, placeholder = ''): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'text';
    i.value = value;
    i.placeholder = placeholder;
    i.dataset.field = field;
    this.listen(i, 'input', () => onInput(i.value));
    return i;
  }

  private area(value: string, onInput: (v: string) => void, field: string, placeholder = ''): HTMLTextAreaElement {
    const t = document.createElement('textarea');
    t.rows = 2;
    t.value = value;
    t.placeholder = placeholder;
    t.dataset.field = field;
    this.listen(t, 'input', () => onInput(t.value));
    return t;
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls !== '') e.className = cls;
  if (text !== undefined) e.append(document.createTextNode(text));
  return e;
}

function labelled(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = document.createElement('label');
  row.className = 'mi-field';
  const name = document.createElement('span');
  name.className = 'mi-field__label';
  name.textContent = label;
  row.append(name, control);
  if (hint !== undefined) {
    const h = document.createElement('span');
    h.className = 'mi-hint';
    h.textContent = hint;
    row.append(h);
  }
  return row;
}

export function registerCommRoutes(): void {
  Control.register('CommRoutes', CommRoutes);
}

/**
 * AccountEmails — the EMAIL ADDRESSES section of the Account page
 * (docs/EMAIL_ADDRESSES.md): your addresses, which one is the primary (the
 * address mail, digests and threads use for you), and adding one of your
 * own — kitp mails it a code, which you enter here to verify it. A sign-in
 * brings its own address, already verified.
 *
 * The person_email.* and account_mail.* specs live here too; the People
 * screen uses them for an admin's view (list, remove) and for choosing the
 * mail account that sends the codes.
 *
 * Zero promises: api.callByName(..., { alive }); reload after every write.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { Api } from '../core/api.js';
import type { ApiFault } from '../core/dispatch.js';
import { decodeWire, encodeWire } from '../core/codec.js';
import { faultText } from '../admin/record-form.js';

export const EMAIL_SPEC = {
  list: 'person_email.list',
  add: 'person_email.add',
  verify: 'person_email.verify',
  setPrimary: 'person_email.set_primary',
  remove: 'person_email.remove',
  mailGet: 'account_mail.get',
  mailSet: 'account_mail.set',
} as const;

export interface EmailAddress {
  email: string;
  /** signin: a sign-in brought it; added: the person added it; card: the person card's email. */
  source: 'signin' | 'added' | 'card';
  verified: boolean;
  primary: boolean;
  codeExpiresAt?: string | null;
}

export interface EmailList {
  personId: string;
  primary: string;
  canAdd: boolean;
  addresses: EmailAddress[];
}

export interface AccountMailChoice {
  id: string;
  name: string;
  project: string;
  fromAddress: string;
}

export interface AccountMail {
  channelId: string;
  choices?: AccountMailChoice[];
}

export function registerEmailSpecs(api: Api): void {
  const define = <I, O>(endpoint: string, action: string): void => {
    if (api.registry.has({ endpoint, action })) return;
    api.define<I, O>({ endpoint, action, encode: (i) => encodeWire(i), decode: (raw) => decodeWire(raw) as O });
  };
  define<{ personId?: string }, EmailList>('person_email', 'list');
  define<{ email: string }, { email: string }>('person_email', 'add');
  define<{ email: string; code: string }, { email: string; verified: boolean }>('person_email', 'verify');
  define<{ email: string }, { email: string }>('person_email', 'set_primary');
  define<{ personId?: string; email: string }, { email: string }>('person_email', 'remove');
  define<Record<string, never>, AccountMail>('account_mail', 'get');
  define<{ channelId: string }, AccountMail>('account_mail', 'set');
}

/** What a row says of an address, after its badges: as its owner reads it
 *  (own), or as an admin does. */
export function addressNote(a: EmailAddress, own = true): string {
  // A primary that is only on the person card: nobody verified it (typed
  // before the login existed). The next sign-in replaces it.
  if (a.source === 'card') return a.verified ? '' : 'Not verified';
  if (!a.verified) return 'Waiting for its code';
  switch (a.source) {
    case 'signin':
      return own ? 'From your sign-in' : 'From their sign-in';
    case 'added':
      return own ? 'Added by you' : 'Added by them';
    default:
      return '';
  }
}

/** The label a mail account goes by in the account-mail picker. */
export function accountMailLabel(c: AccountMailChoice): string {
  const where = c.project !== '' ? ` (${c.project})` : '';
  return `${c.name !== '' ? c.name : c.fromAddress}${where} — ${c.fromAddress}`;
}

/** Messages for the codes person_email.* answers with. */
export const EMAIL_FAULTS: Record<string, string> = {
  no_sender: 'No mail account sends account emails yet; an admin chooses one in People.',
  in_use: 'That address is already verified on someone else’s account.',
  already_verified: 'That address is already on your list.',
  invalid_code: 'That code doesn’t match. Check the latest email we sent.',
  expired: 'That code has expired. Send a new one.',
  not_verified: 'Verify the address before making it your primary.',
  primary: 'Choose another primary address first.',
  limit: 'Too many codes for now; try again in an hour.',
  send_failed: 'The code couldn’t be sent; try again in a moment.',
  send_refused: 'The mail server refused that address.',
  validation: 'That isn’t an email address kitp can send to.',
};

export interface AccountEmailsConfig extends BaseControlConfig {
  type: 'AccountEmails';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    AccountEmails: AccountEmailsConfig;
  }
}

export class AccountEmails extends Control<AccountEmailsConfig> {
  private list: EmailList | null = null;
  private newEmail = '';
  private codes = new Map<string, string>();
  private error = '';
  private notice = '';
  private busy = false;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mi-emails';
    el.dataset.control = 'AccountEmails';
    return el;
  }

  protected render(): void {
    this.paint();
    this.load();
  }

  private load(): void {
    this.ctx.api.callByName(
      EMAIL_SPEC.list,
      {},
      (out) => {
        if (!this.isAlive()) return;
        this.list = out as EmailList;
        this.busy = false;
        this.paint();
      },
      { alive: () => this.isAlive(), onErr: this.fail },
    );
  }

  private fail = (f: ApiFault): void => {
    if (!this.isAlive()) return;
    this.error = faultText(f, EMAIL_FAULTS).replace(/^person_email\.[a-z_]+: /, '');
    this.busy = false;
    this.paint();
  };

  /** Run a write, then reload (the list is small). */
  private write(spec: string, data: unknown, notice = ''): void {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.notice = '';
    this.paint();
    this.ctx.api.callByName(
      spec,
      data,
      () => {
        if (!this.isAlive()) return;
        this.notice = notice;
        this.load();
      },
      { alive: () => this.isAlive(), onErr: this.fail },
    );
  }

  private paint(): void {
    const parts: HTMLElement[] = [
      el(
        'p',
        'mi-hint',
        'Your primary address is the one kitp uses for your mail, digests and threads. Mail from any of your verified addresses reaches you here.',
      ),
    ];
    const list = this.list;
    if (list === null) parts.push(el('p', 'muted', 'Loading…'));
    else {
      const rows = el('div', 'mi-list');
      rows.dataset.emailList = '';
      if (list.addresses.length === 0) rows.append(el('p', 'mi-hint', 'No addresses yet.'));
      for (const a of list.addresses) rows.append(this.renderAddress(a));
      parts.push(rows);
      parts.push(list.canAdd ? this.renderAdd() : el('p', 'mi-hint', 'To add an address of your own, an admin first chooses the mail account that sends its code (People).'));
    }
    if (this.notice !== '') parts.push(el('p', 'mi-hint', this.notice));
    if (this.error !== '') parts.push(el('p', 'mi-error', this.error));
    this.el.replaceChildren(...parts);
  }

  private renderAddress(a: EmailAddress): HTMLElement {
    const card = el('div', 'mi-card');
    card.dataset.email = a.email;
    const head = el('div', 'mi-card__head');
    head.append(el('strong', '', a.email));
    if (a.primary) head.append(el('span', 'mi-badge', 'Primary'));
    const note = addressNote(a);
    if (note !== '') head.append(el('span', 'mi-hint', note));
    if (a.verified && !a.primary) head.append(this.button('Make primary', () => this.write(EMAIL_SPEC.setPrimary, { email: a.email }), 'email-primary'));
    if (!a.primary) head.append(this.button('Remove', () => this.write(EMAIL_SPEC.remove, { email: a.email }), 'email-remove'));
    card.append(head);
    if (!a.verified && a.source === 'card') {
      // Verify it like a new address: a code goes to it.
      head.append(this.button('Send a code', () => this.write(EMAIL_SPEC.add, { email: a.email }, `We sent a code to ${a.email}. Enter it below; it works for 24 hours.`), 'email-verify-card'));
    } else if (!a.verified) {
      const row = el('div', 'mi-card__head');
      const code = document.createElement('input');
      code.type = 'text';
      code.placeholder = 'XXXXX-XXXXX';
      code.autocomplete = 'one-time-code';
      code.value = this.codes.get(a.email) ?? '';
      code.dataset.emailCode = a.email;
      code.setAttribute('aria-label', `Code sent to ${a.email}`);
      this.listen(code, 'input', () => this.codes.set(a.email, code.value));
      row.append(
        code,
        this.button('Verify', () => this.write(EMAIL_SPEC.verify, { email: a.email, code: this.codes.get(a.email) ?? '' }, `${a.email} is verified.`), 'email-verify'),
        this.button('Send a new code', () => this.write(EMAIL_SPEC.add, { email: a.email }, `We sent a new code to ${a.email}.`), 'email-resend'),
      );
      card.append(row);
    }
    return card;
  }

  private renderAdd(): HTMLElement {
    const row = el('div', 'mi-card__head');
    const input = document.createElement('input');
    input.type = 'email';
    input.placeholder = 'name@example.com';
    input.value = this.newEmail;
    input.dataset.emailNew = '';
    input.setAttribute('aria-label', 'Address to add');
    this.listen(input, 'input', () => {
      this.newEmail = input.value;
    });
    const add = this.button(
      'Send code',
      () => {
        const email = this.newEmail.trim();
        if (email === '') return;
        this.newEmail = '';
        this.write(EMAIL_SPEC.add, { email }, `We sent a code to ${email}. Enter it below; it works for 24 hours.`);
      },
      'email-add',
    );
    row.append(input, add);
    return row;
  }

  private button(label: string, onClick: () => void, data: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    b.dataset[data.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = '';
    b.disabled = this.busy;
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

export function registerAccountEmails(): void {
  Control.register('AccountEmails', AccountEmails);
}

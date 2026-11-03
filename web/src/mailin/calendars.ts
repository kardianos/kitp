/**
 * AccountCalendars — the CALENDARS section of the Account page
 * (docs/MAIL_INTAKE_AND_CALENDARS.md §8): the person's calendar feeds.
 *
 * Each calendar has a name, a filter (presets, or the screen-filter JSON
 * with '@me' = you) and a window of days around today; tasks you can see
 * with a due date in the window show as all-day events linking to the
 * task. A calendar has any number of secret URLs, each with a comment
 * ("iPhone", "Google work") and its last fetch (when, which app, any
 * error), so one can be revoked alone. A new URL is shown ONCE, with how to
 * add it to Google Calendar, Outlook and Apple Calendar. "Detailed steps"
 * opens the Account help topic.
 *
 * Zero promises: api.callByName(..., { alive }).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ApiFault } from '../core/dispatch.js';
import { faultText } from '../admin/record-form.js';
import {
  MAILIN_SPEC,
  calendarURL,
  sinceText,
  webcalURL,
  type CalendarRow,
  type URLCreateOutput,
} from './specs.js';

export interface AccountCalendarsConfig extends BaseControlConfig {
  type: 'AccountCalendars';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    AccountCalendars: AccountCalendarsConfig;
  }
}

/** Filter presets (the stored JSON; '@me' is resolved per owner). */
export const CALENDAR_FILTERS: ReadonlyArray<{ key: string; label: string; json: string }> = [
  { key: 'all', label: 'Every task I can see', json: '' },
  {
    key: 'mine',
    label: 'Assigned to me',
    json: '{"connective":"and","children":[{"attr":"assignee","op":"eq","values":["@me"]}]}',
  },
  {
    key: 'mine_open',
    label: 'Assigned to me, not done',
    json: '{"connective":"and","children":[{"attr":"assignee","op":"eq","values":["@me"]},{"attr":"status","op":"has_phase","values":["triage","active"]}]}',
  },
];

/** Which preset a stored filter is ('custom' when none matches). */
export function filterPreset(json: string): string {
  const norm = (s: string): string => {
    try {
      return s.trim() === '' ? '' : JSON.stringify(JSON.parse(s));
    } catch {
      return s;
    }
  };
  const n = norm(json);
  return CALENDAR_FILTERS.find((p) => norm(p.json) === n)?.key ?? 'custom';
}

/** How to add a feed URL, per calendar app. */
export const CALENDAR_APP_STEPS: ReadonlyArray<readonly [string, string]> = [
  ['Google Calendar', 'Other calendars → + → From URL → paste the URL. Google refreshes it every few hours (up to a day).'],
  ['Outlook', 'Add calendar → Subscribe from web → paste the URL.'],
  ['Apple Calendar', 'File → New Calendar Subscription → paste the URL, or open the webcal:// link on your iPhone or Mac.'],
];

interface Edit {
  id: string;
  title: string;
  preset: string;
  custom: string;
  pastDays: string;
  futureDays: string;
  error: string;
  busy: boolean;
}

interface Minted {
  calendarId: string;
  url: string;
}

export class AccountCalendars extends Control<AccountCalendarsConfig> {
  private calendars: CalendarRow[] = [];
  private loaded = false;
  private edit: Edit | null = null;
  private minted: Minted | null = null;
  /** calendar id → the comment typed for a new URL. */
  private newURLComment = new Map<string, string>();
  private confirm = '';
  private error = '';

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mi-calendars';
    el.dataset.control = 'AccountCalendars';
    return el;
  }

  protected render(): void {
    this.paint();
    this.load();
  }

  private load(): void {
    this.ctx.api.callByName(
      MAILIN_SPEC.calendarList,
      {},
      (out) => {
        if (!this.isAlive()) return;
        this.calendars = (out as { calendars?: CalendarRow[] }).calendars ?? [];
        this.loaded = true;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private fail = (f: ApiFault): void => {
    if (!this.isAlive()) return;
    const msg = faultText(f).replace(/^calendar(_url)?\.[a-z]+: /, '');
    if (this.edit !== null) {
      this.edit.error = msg;
      this.edit.busy = false;
    } else this.error = msg;
    this.paint();
  };

  /* -------------------------------- painting ------------------------------- */

  private paint(): void {
    const intro = el(
      'p',
      'mi-hint',
      'Your due dates in Google Calendar, Outlook or Apple Calendar. Each calendar has a filter and a window around today; tasks you can see with a due date in it appear as all-day events that link to the task. Calendar services fetch the feed from their own servers, so task titles are sent to them — and anyone with a URL can read it, so give each app its own URL and revoke the ones you stop using.',
    );
    intro.dataset.calendarsIntro = '';
    intro.append(document.createTextNode(' '), this.button('Detailed steps', () => this.ctx.bus?.emit('toggleInstructions', undefined), 'mi-link'));
    const parts: HTMLElement[] = [intro];
    if (!this.loaded) parts.push(el('p', 'muted', 'Loading…'));
    else if (this.calendars.length === 0 && this.edit === null) parts.push(el('p', 'muted', 'No calendars yet.'));
    for (const c of this.calendars) parts.push(this.renderCalendar(c));
    if (this.edit !== null && this.edit.id === '') parts.push(this.renderEdit(this.edit));
    else if (this.edit === null) {
      const add = this.button('+ New calendar', () => this.openEdit(null));
      add.dataset.calendarAdd = '';
      parts.push(add);
    }
    if (this.error !== '') parts.push(el('p', 'mi-error', this.error));
    this.el.replaceChildren(...parts);
  }

  private renderCalendar(c: CalendarRow): HTMLElement {
    const card = el('div', 'mi-card');
    card.dataset.calendar = c.id;
    if (this.edit !== null && this.edit.id === c.id) {
      card.append(this.renderEdit(this.edit));
      return card;
    }
    const head = el('div', 'mi-card__head');
    head.append(el('strong', '', c.title));
    const preset = filterPreset(c.predicate);
    head.append(el('span', 'mi-badge', CALENDAR_FILTERS.find((p) => p.key === preset)?.label ?? 'Custom filter'));
    card.append(head, el('p', 'mi-hint', `Due dates from ${c.pastDays} days ago to ${c.futureDays} days ahead.`));

    if (this.minted !== null && this.minted.calendarId === c.id) card.append(this.renderMinted(this.minted));

    const urls = el('div', 'mi-list');
    if (c.urls.length === 0) urls.append(el('p', 'mi-hint', 'No URLs yet: add one per calendar app.'));
    for (const u of c.urls) {
      const row = el('div', 'mi-card__head');
      row.dataset.calendarUrl = u.id;
      row.append(el('span', 'mi-badge', `…${u.hint}`), el('span', '', u.comment !== '' ? u.comment : '(no comment)'));
      row.append(
        el(
          'span',
          'mi-hint',
          u.lastUsedAt === '' ? 'Never fetched' : `Fetched ${sinceText(u.lastUsedAt)}${u.lastClient !== '' ? ` by ${u.lastClient}` : ''}`,
        ),
      );
      const key = `url:${u.id}`;
      if (this.confirm === key) {
        row.append(
          this.button('Revoke', () => this.call(MAILIN_SPEC.urlDelete, { id: u.id }), 'btn-danger'),
          this.button('Cancel', () => {
            this.confirm = '';
            this.paint();
          }),
        );
      } else {
        row.append(
          this.button('Revoke…', () => {
            this.confirm = key;
            this.paint();
          }),
        );
      }
      urls.append(row);
      if (u.lastError !== '') urls.append(el('p', 'mi-error', `Last fetch failed ${sinceText(u.lastErrorAt)}: ${u.lastError}`));
    }
    card.append(urls);

    const add = el('div', 'mi-actions');
    const comment = document.createElement('input');
    comment.type = 'text';
    comment.placeholder = 'Where it will be used, e.g. “iPhone”';
    comment.value = this.newURLComment.get(c.id) ?? '';
    comment.dataset.field = 'urlComment';
    this.listen(comment, 'input', () => this.newURLComment.set(c.id, comment.value));
    const mint = this.button('+ New URL', () => this.mintURL(c.id));
    mint.dataset.calendarMint = c.id;
    add.append(comment, mint, this.button('Edit', () => this.openEdit(c)));
    if (this.confirm === `cal:${c.id}`) {
      add.append(
        el('span', 'mi-error', 'Delete the calendar? Its URLs stop working.'),
        this.button('Delete', () => this.call(MAILIN_SPEC.calendarDelete, { id: c.id }), 'btn-danger'),
        this.button('Cancel', () => {
          this.confirm = '';
          this.paint();
        }),
      );
    } else {
      add.append(
        this.button('Delete…', () => {
          this.confirm = `cal:${c.id}`;
          this.paint();
        }),
      );
    }
    card.append(add);
    return card;
  }

  private renderMinted(m: Minted): HTMLElement {
    const box = el('div', 'mi-secret');
    box.dataset.minted = '';
    box.append(el('strong', '', 'The new URL'));
    const value = document.createElement('input');
    value.readOnly = true;
    value.value = m.url;
    value.className = 'mi-secret__value';
    value.dataset.mintedValue = '';
    box.append(
      value,
      this.button('Copy', () => {
        value.select();
        if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(m.url);
      }),
    );
    const webcal = document.createElement('a');
    webcal.href = webcalURL(m.url);
    webcal.textContent = 'Open in a calendar app (webcal://)';
    box.append(webcal);
    const steps = document.createElement('ul');
    steps.className = 'mi-steps';
    for (const [app, how] of CALENDAR_APP_STEPS) {
      const li = document.createElement('li');
      li.append(el('strong', '', `${app}: `), document.createTextNode(how));
      steps.append(li);
    }
    box.append(steps, el('p', 'mi-hint', 'Shown only now — kitp keeps just a fingerprint. Lost it? Make a new URL and revoke this one.'));
    box.append(
      this.button('Done', () => {
        this.minted = null;
        this.paint();
      }),
    );
    return box;
  }

  private renderEdit(e: Edit): HTMLElement {
    const box = el('div', 'mi-form');
    box.dataset.calendarForm = e.id === '' ? 'new' : e.id;
    box.append(el('h4', '', e.id === '' ? 'New calendar' : 'Edit calendar'));
    box.append(labelled('Name', this.input(e.title, (v) => (e.title = v), 'title'), 'What calendar apps show it as.'));
    const sel = document.createElement('select');
    sel.dataset.field = 'preset';
    for (const p of [...CALENDAR_FILTERS, { key: 'custom', label: 'Custom filter (JSON)', json: '' }]) {
      const o = document.createElement('option');
      o.value = p.key;
      o.textContent = p.label;
      o.selected = p.key === e.preset;
      sel.append(o);
    }
    this.listen(sel, 'change', () => {
      e.preset = sel.value;
      this.paint();
    });
    box.append(labelled('Tasks', sel));
    if (e.preset === 'custom') {
      const t = document.createElement('textarea');
      t.rows = 4;
      t.value = e.custom;
      t.dataset.field = 'custom';
      this.listen(t, 'input', () => (e.custom = t.value));
      box.append(
        labelled(
          'Filter',
          t,
          'The screen-filter JSON, e.g. {"connective":"and","children":[{"attr":"assignee","op":"eq","values":["@me"]}]}. "@me" is you. Status values differ per project, so filter on phase (has_phase) to span projects.',
        ),
      );
    }
    const past = this.input(e.pastDays, (v) => (e.pastDays = v), 'pastDays');
    past.inputMode = 'numeric';
    const future = this.input(e.futureDays, (v) => (e.futureDays = v), 'futureDays');
    future.inputMode = 'numeric';
    box.append(labelled('Days back', past, 'Due dates up to this many days ago (0–3650).'), labelled('Days ahead', future, 'Due dates up to this many days ahead (0–3650).'));
    if (e.error !== '') box.append(el('p', 'mi-error', e.error));
    const actions = el('div', 'mi-actions');
    const save = this.button(e.id === '' ? 'Create calendar' : 'Save', () => this.save(e), 'btn-primary');
    save.disabled = e.busy;
    save.dataset.calendarSave = '';
    actions.append(
      save,
      this.button('Cancel', () => {
        this.edit = null;
        this.paint();
      }),
    );
    box.append(actions);
    return box;
  }

  /* -------------------------------- actions -------------------------------- */

  private openEdit(c: CalendarRow | null): void {
    this.minted = null;
    const preset = c === null ? 'mine' : filterPreset(c.predicate);
    this.edit = {
      id: c?.id ?? '',
      title: c?.title ?? 'My due dates',
      preset,
      custom: preset === 'custom' ? (c?.predicate ?? '') : '',
      pastDays: String(c?.pastDays ?? 30),
      futureDays: String(c?.futureDays ?? 365),
      error: '',
      busy: false,
    };
    this.paint();
  }

  private save(e: Edit): void {
    const past = Number(e.pastDays);
    const future = Number(e.futureDays);
    if (!Number.isInteger(past) || past < 0 || past > 3650 || !Number.isInteger(future) || future < 0 || future > 3650) {
      e.error = 'Days back and days ahead are whole numbers from 0 to 3650.';
      this.paint();
      return;
    }
    const predicate = e.preset === 'custom' ? e.custom.trim() : (CALENDAR_FILTERS.find((p) => p.key === e.preset)?.json ?? '');
    const input: Record<string, unknown> = { title: e.title.trim(), predicate, pastDays: past, futureDays: future };
    if (e.id !== '') input['id'] = e.id;
    e.busy = true;
    e.error = '';
    this.paint();
    this.ctx.api.callByName(
      MAILIN_SPEC.calendarSet,
      input,
      () => {
        if (!this.isAlive()) return;
        this.edit = null;
        this.load();
      },
      { alive: () => this.isAlive(), onErr: this.fail },
    );
  }

  private mintURL(calendarId: string): void {
    this.ctx.api.callByName(
      MAILIN_SPEC.urlCreate,
      { calendarId, comment: (this.newURLComment.get(calendarId) ?? '').trim() },
      (out) => {
        if (!this.isAlive()) return;
        const o = out as URLCreateOutput;
        const origin = typeof location !== 'undefined' ? location.origin : '';
        this.minted = { calendarId, url: calendarURL(origin, o.token) };
        this.newURLComment.delete(calendarId);
        this.load();
      },
      { alive: () => this.isAlive(), onErr: this.fail },
    );
  }

  private call(spec: string, input: Record<string, unknown>): void {
    this.ctx.api.callByName(
      spec,
      input,
      () => {
        if (!this.isAlive()) return;
        this.confirm = '';
        this.load();
      },
      { alive: () => this.isAlive(), onErr: this.fail },
    );
  }

  private button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`.trim();
    b.textContent = label;
    this.listen(b, 'click', onClick);
    return b;
  }

  private input(value: string, onInput: (v: string) => void, field: string): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'text';
    i.value = value;
    i.dataset.field = field;
    this.listen(i, 'input', () => onInput(i.value));
    return i;
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
  row.append(el('span', 'mi-field__label', label), control);
  if (hint !== undefined) row.append(el('span', 'mi-hint', hint));
  return row;
}

export function registerAccountCalendars(): void {
  Control.register('AccountCalendars', AccountCalendars);
}

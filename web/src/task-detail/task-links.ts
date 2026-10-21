/**
 * TaskLinks — the LINKS section on the task-detail screen: code changes (a
 * Gerrit CL, a pull request), issues, or any URL tied to the task.
 *
 * Lists the task's links (`link.list`) — each with its source icon, a title
 * that opens the URL in a new tab, the source's state (open / reviewed /
 * approved / merged / abandoned) as a toned badge, who added it and when it
 * last changed — plus a "+ Add link" form (`link.set`) and a per-row remove
 * (`link.delete`). A code forge keeps its own links current through the same
 * `link.set` (see integrations/gerrit), so a refresh shows a CL moving to
 * merged without anyone touching this screen.
 *
 * Mounted by TaskDetail into its `links` slot (main column, between the
 * attachment preview strip and COMMS). The detail calls {@link reload} on
 * its header Refresh.
 *
 * Presentation is data-driven: kind / state slugs map through LINK_KINDS /
 * LINK_STATES (link-specs.ts); this control has no per-kind branches.
 * Zero-promise: every read/write goes through `api.callByName(..., { alive })`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { icon } from '../ui/icons.js';
import { localTimeEl } from '../util/datetime.js';
import {
  LINK_LIST_SPEC,
  LINK_SET_SPEC,
  LINK_DELETE_SPEC,
  displayUrl,
  guessLinkKind,
  isLinkableUrl,
  linkIcon,
  linkKindInfo,
  linkStateInfo,
  type LinkRow,
  type LinkListOutput,
  type LinkSetInput,
  type LinkSetOutput,
} from './link-specs.js';

export interface TaskLinksConfig extends BaseControlConfig {
  type: 'TaskLinks';
  /** The focal task id (string from the route). */
  taskId?: string;
  /** Called after a successful LOCAL write (our own add / remove) so the
   *  parent can advance its background-poll baseline — our own activity
   *  shouldn't trip the "new content" indicator. */
  onLocalWrite?: () => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    TaskLinks: TaskLinksConfig;
  }
}

export class TaskLinks extends Control<TaskLinksConfig> {
  private taskId: bigint | null = null;
  private rows: LinkRow[] = [];
  /** Flipped once the first link.list lands; gates "No links." vs "Loading…". */
  private loaded = false;

  private headingEl!: HTMLElement;
  private formHost!: HTMLElement;
  private noteEl!: HTMLElement;
  private listEl!: HTMLElement;
  private formOpen = false;
  /** True while the add form's link.set is in flight. */
  private adding = false;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'task-links';
    el.dataset.control = 'TaskLinks';
    el.dataset.region = 'detail.links';
    return el;
  }

  protected render(): void {
    this.taskId = parseId(this.config.taskId);

    const head = document.createElement('div');
    head.className = 'task-links__head';
    const heading = document.createElement('h2');
    heading.className = 'task-detail__section-label muted';
    heading.dataset.linksHeading = '';
    heading.textContent = 'LINKS';
    this.headingEl = heading;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn task-links__add';
    add.dataset.linksAdd = '';
    add.textContent = '+ Add link';
    this.listen(add, 'click', () => this.toggleForm());
    head.append(heading, add);

    const formHost = document.createElement('div');
    formHost.className = 'task-links__form';
    formHost.dataset.linksForm = '';
    this.formHost = formHost;

    const note = document.createElement('p');
    note.className = 'task-links__note muted';
    note.dataset.linksNote = '';
    note.setAttribute('aria-live', 'polite');
    this.noteEl = note;

    const list = document.createElement('ul');
    list.className = 'task-links__list';
    list.dataset.linksList = '';
    this.listEl = list;

    this.el.append(head, formHost, note, list);
    this.paintList();
    this.load();
  }

  /* -------------------------------- loads ------------------------------- */

  /** Public refresh hook (the detail's header Refresh). */
  reload(): void {
    this.load();
  }

  private load(): void {
    if (this.taskId === null) return;
    this.ctx.api.callByName(
      LINK_LIST_SPEC,
      { taskId: this.taskId },
      (out) => {
        if (!this.isAlive()) return;
        this.rows = (out as LinkListOutput).rows ?? [];
        this.loaded = true;
        this.paintList();
      },
      { alive: () => this.isAlive() },
    );
  }

  /* ------------------------------- painting ----------------------------- */

  private paintList(): void {
    this.headingEl.textContent = this.rows.length > 0 ? `LINKS (${this.rows.length})` : 'LINKS';
    this.listEl.replaceChildren();
    if (this.rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'task-links__empty muted';
      empty.dataset.linksEmpty = '';
      empty.textContent = this.loaded ? 'No links.' : 'Loading…';
      this.listEl.append(empty);
      return;
    }
    for (const row of this.rows) this.listEl.append(this.renderRow(row));
  }

  private renderRow(row: LinkRow): HTMLElement {
    const li = document.createElement('li');
    li.className = 'task-links__item';
    li.dataset.linkRow = row.id.toString();
    li.dataset.kind = row.kind;
    li.dataset.state = row.state;

    const glyph = document.createElement('span');
    glyph.className = 'task-links__icon';
    glyph.append(icon(linkIcon(row.kind, row.state), 16));

    const main = document.createElement('div');
    main.className = 'task-links__main';

    // The title opens the link in a new tab. The server only stores http(s)
    // URLs; re-check before it becomes an href so nothing else ever does.
    const linkable = isLinkableUrl(row.url);
    const title = document.createElement(linkable ? 'a' : 'span');
    title.className = 'task-links__title';
    title.dataset.linkTitle = '';
    title.textContent = row.title !== '' ? row.title : row.url;
    if (linkable) {
      const a = title as HTMLAnchorElement;
      a.href = row.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = row.url;
    }

    const meta = document.createElement('div');
    meta.className = 'task-links__meta muted';
    const parts: Array<string | HTMLElement> = [];
    const kind = linkKindInfo(row.kind);
    if (kind.label !== '') parts.push(kind.label);
    if (row.title !== '' && row.title !== row.url) {
      const url = document.createElement('span');
      url.className = 'task-links__url';
      url.textContent = displayUrl(row.url);
      parts.push(url);
    }
    if (row.createdBy !== '') parts.push(`added by ${row.createdBy}`);
    const when = localTimeEl(row.updatedAt !== '' ? row.updatedAt : row.createdAt, 'task-links__time');
    when.dataset.linkTime = '';
    parts.push(when);
    parts.forEach((p, i) => {
      if (i > 0) meta.append(document.createTextNode(' · '));
      meta.append(p);
    });

    main.append(title, meta);
    li.append(glyph, main);

    const state = linkStateInfo(row.state);
    if (state !== null) {
      const badge = document.createElement('span');
      badge.className = 'task-links__state';
      badge.dataset.linkState = '';
      badge.dataset.tone = state.tone;
      badge.textContent = state.label;
      li.append(badge);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'task-links__remove';
    remove.dataset.linkRemove = '';
    remove.title = 'Remove link';
    remove.setAttribute('aria-label', `Remove link ${title.textContent ?? ''}`);
    remove.append(icon('x', 14));
    this.listen(remove, 'click', () => this.doRemove(row));
    li.append(remove);
    return li;
  }

  private setNote(text: string): void {
    this.noteEl.textContent = text;
  }

  /* ------------------------------ add form ------------------------------ */

  private toggleForm(): void {
    this.formOpen = !this.formOpen;
    this.setNote('');
    if (!this.formOpen) {
      this.formHost.replaceChildren();
      return;
    }

    const url = document.createElement('input');
    url.type = 'url';
    url.className = 'task-links__input';
    url.dataset.linksUrl = '';
    url.placeholder = 'https://…  (code change, issue, page)';
    url.setAttribute('aria-label', 'Link URL');

    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'task-links__input';
    title.dataset.linksTitle = '';
    title.placeholder = 'Title (optional)';
    title.setAttribute('aria-label', 'Link title');

    const error = document.createElement('p');
    error.className = 'task-links__error';
    error.dataset.linksError = '';
    error.setAttribute('role', 'alert');

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary task-links__btn';
    submit.dataset.linksSubmit = '';
    submit.textContent = 'Add';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn task-links__btn';
    cancel.textContent = 'Cancel';

    const go = (): void => this.doAdd(url, title, error, submit);
    this.listen(submit, 'click', go);
    this.listen(cancel, 'click', () => this.toggleForm());
    for (const input of [url, title]) {
      this.listen(input, 'keydown', (e) => {
        const ev = e as KeyboardEvent;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          go();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          this.toggleForm();
        }
      });
    }

    const fields = document.createElement('div');
    fields.className = 'task-links__fields';
    fields.append(url, title);
    const actions = document.createElement('div');
    actions.className = 'task-links__form-actions';
    actions.append(cancel, submit);
    this.formHost.replaceChildren(fields, error, actions);
    queueMicrotask(() => url.focus());
  }

  /** Validate + fire link.set. Idempotent server-side: a URL already on the
   *  task updates that link, which the note reports. */
  private doAdd(
    urlEl: HTMLInputElement,
    titleEl: HTMLInputElement,
    errorEl: HTMLElement,
    submit: HTMLButtonElement,
  ): void {
    if (this.taskId === null || this.adding) return;
    const url = urlEl.value.trim();
    if (!isLinkableUrl(url)) {
      errorEl.textContent = 'Enter a full http(s):// URL.';
      urlEl.focus();
      return;
    }
    errorEl.textContent = '';
    const input: LinkSetInput = { taskId: this.taskId, url };
    const title = titleEl.value.trim();
    if (title !== '') input.title = title;
    const kind = guessLinkKind(url);
    // Only claim a kind on create-shaped input; an existing link keeps the
    // kind its source set (link.set PATCHes only what's present).
    if (kind !== '' && !this.rows.some((r) => r.url === url)) input.kind = kind;

    this.adding = true;
    submit.disabled = true;
    this.ctx.api.callByName(
      LINK_SET_SPEC,
      input,
      (out) => {
        if (!this.isAlive()) return;
        this.adding = false;
        const o = out as LinkSetOutput;
        this.formOpen = false;
        this.formHost.replaceChildren();
        this.setNote(o.created ? '' : o.changed ? 'Already linked — updated.' : 'Already linked.');
        this.load();
        this.config.onLocalWrite?.();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          // The central funnel already toasted; keep the draft for a retry.
          if (!this.isAlive()) return;
          this.adding = false;
          submit.disabled = false;
        },
      },
    );
  }

  /** Optimistic remove: drop the row now, restore from the server on a fault. */
  private doRemove(row: LinkRow): void {
    this.rows = this.rows.filter((r) => r.id !== row.id);
    this.setNote('');
    this.paintList();
    this.ctx.api.callByName(
      LINK_DELETE_SPEC,
      { id: row.id },
      () => {
        if (this.isAlive()) this.config.onLocalWrite?.();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (this.isAlive()) this.load();
        },
      },
    );
  }
}

/* -------------------------------------------------------------------------- */

function parseId(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

export function registerTaskLinks(): void {
  Control.register('TaskLinks', TaskLinks);
}

/**
 * CommThreads — the COMMS (email-thread) surface on the task-detail screen.
 *
 * Lists the task's comm cards (`comm.list_for_task`), each with its recipients
 * (an editable RefPicker over `person` → `comm.set_recipients`) and its replies
 * (the email envelopes), plus a per-comm reply composer (`reply.post`). A
 * "+ Start comm" form creates a new comm on a chosen channel
 * (`comm.create`, channel = RefPicker over `comm_channel`).
 *
 * Mounted by TaskDetail into its `comms` slot (parallel to TaskComments). The
 * detail calls {@link CommThreads.reload} after a relevant activity bump.
 *
 * Zero-promise: every read/write goes through `api.callByName(..., { alive })`;
 * the list repaints from the onOk callbacks. Recipient / channel pickers are
 * RefPickers (their own `card.search`); we dispose the per-comm pickers on each
 * repaint so a recycled list never leaks child controls.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { fitTextarea } from '../util/autosize.js';
import type { RefPicker } from '../ui/ref-picker.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { SPEC } from '../kanban/specs.js';
import {
  COMM_LIST_FOR_TASK_SPEC,
  COMM_CREATE_SPEC,
  COMM_SET_RECIPIENTS_SPEC,
  REPLY_POST_SPEC,
  type CommRow,
  type CommListForTaskOutput,
} from './comm-specs.js';

export interface CommThreadsConfig extends BaseControlConfig {
  type: 'CommThreads';
  /** The focal task id (string from the route). */
  taskId?: string;
  /** Dotted tree path holding the in-scope project id (channel search scope). */
  projectScopePath?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    CommThreads: CommThreadsConfig;
  }
}

export class CommThreads extends Control<CommThreadsConfig> {
  private taskId: bigint | null = null;
  private comms: CommRow[] = [];
  /** person id → display name, for recipient chips/labels. */
  private personLabels = new Map<string, string>();
  /** Child RefPickers (per-comm recipients + the start form), disposed on repaint. */
  private pickers: RefPicker[] = [];

  private headEl!: HTMLElement;
  private formHost!: HTMLElement;
  private listEl!: HTMLElement;
  private formOpen = false;
  /** Start-form draft state. */
  private newChannelId: bigint | null = null;
  private newRecipients: bigint[] = [];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'task-comms';
    el.dataset.control = 'CommThreads';
    el.dataset.region = 'detail.comms';
    return el;
  }

  protected render(): void {
    this.taskId = parseId(this.config.taskId);

    const head = document.createElement('div');
    head.className = 'task-comms__head';
    const heading = document.createElement('h2');
    heading.className = 'task-detail__section-label muted';
    heading.dataset.commsHeading = '';
    heading.textContent = 'COMMS';
    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'btn task-comms__start';
    startBtn.dataset.commsStart = '';
    startBtn.textContent = '+ Start comm';
    this.listen(startBtn, 'click', () => this.toggleStartForm());
    head.append(heading, startBtn);
    this.headEl = head;
    this.el.append(head);

    const formHost = document.createElement('div');
    formHost.className = 'task-comms__form';
    formHost.dataset.commsForm = '';
    this.formHost = formHost;
    this.el.append(formHost);

    const list = document.createElement('div');
    list.className = 'task-comms__list';
    list.dataset.commsList = '';
    this.listEl = list;
    this.el.append(list);

    this.onDestroy(() => this.disposePickers());

    this.loadPersons();
    this.loadComms();
  }

  /* -------------------------------- loads ------------------------------- */

  /** Public refresh hook (the detail calls this after an activity bump). */
  reload(): void {
    this.loadComms();
  }

  private loadComms(): void {
    if (this.taskId === null) return;
    this.ctx.api.callByName(
      COMM_LIST_FOR_TASK_SPEC,
      { taskId: this.taskId },
      (out) => {
        if (!this.isAlive()) return;
        this.comms = (out as CommListForTaskOutput).rows ?? [];
        this.paintHeading();
        this.paintList();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Load the project's person cards for recipient labels (chips show names). */
  private loadPersons(): void {
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'person' },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out as { rows?: CardWithAttrs[] }).rows ?? []) as CardWithAttrs[];
        for (const r of rows) this.personLabels.set(String(r.id), personName(r));
        this.paintList(); // late labels → repaint chips
      },
      { alive: () => this.isAlive() },
    );
  }

  /* ------------------------------- painting ----------------------------- */

  private paintHeading(): void {
    const h = this.headEl.querySelector<HTMLElement>('[data-comms-heading]');
    if (h) h.textContent = this.comms.length > 0 ? `COMMS (${this.comms.length})` : 'COMMS';
  }

  private paintList(): void {
    this.disposePickers();
    this.listEl.replaceChildren();
    if (this.comms.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-comms__empty muted';
      empty.textContent = 'No comms attached.';
      this.listEl.append(empty);
      return;
    }
    for (const comm of this.comms) this.listEl.append(this.renderComm(comm));
  }

  private renderComm(comm: CommRow): HTMLElement {
    const card = document.createElement('div');
    card.className = 'task-comms__comm';
    card.dataset.commRow = comm.id.toString();

    // Header: subject + thread badge.
    const top = document.createElement('div');
    top.className = 'task-comms__comm-head';
    const subj = document.createElement('span');
    subj.className = 'task-comms__subject';
    subj.textContent = comm.title.length > 0 ? comm.title : '(no subject)';
    const thread = document.createElement('span');
    thread.className = 'task-comms__thread muted';
    thread.textContent = comm.threadId;
    top.append(subj, thread);
    card.append(top);

    // Recipients — an editable RefPicker over person (display + edit in one).
    const recipRow = document.createElement('div');
    recipRow.className = 'task-comms__recipients';
    const recipLabel = document.createElement('span');
    recipLabel.className = 'task-comms__field-label muted';
    recipLabel.textContent = 'To';
    const recipHost = document.createElement('div');
    recipHost.className = 'task-comms__recipients-picker';
    recipRow.append(recipLabel, recipHost);
    card.append(recipRow);
    const labels: Record<string, string> = {};
    for (const id of comm.recipients) labels[id.toString()] = this.personLabels.get(id.toString()) ?? `#${id}`;
    const rp = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'person',
        multi: true,
        values: comm.recipients.slice(),
        currentLabels: labels,
        'aria-label': 'Recipients',
        placeholder: 'Add recipient…',
        onChangeMulti: (values: bigint[]) => this.doSetRecipients(comm.id, values),
      },
      recipHost,
    ) as RefPicker;
    this.pickers.push(rp);

    // Replies (the email envelopes), oldest first.
    const replies = document.createElement('ul');
    replies.className = 'task-comms__replies';
    if (comm.replies.length === 0) {
      const none = document.createElement('li');
      none.className = 'task-comms__reply-empty muted';
      none.textContent = 'No messages yet.';
      replies.append(none);
    } else {
      for (const r of comm.replies) {
        const li = document.createElement('li');
        li.className = 'task-comms__reply';
        li.dataset.replyRow = r.id.toString();
        const meta = document.createElement('div');
        meta.className = 'task-comms__reply-meta muted';
        const fromTxt = r.from.length > 0 ? r.from : '—';
        meta.textContent = `${fromTxt} · ${r.deliveryStatus}`;
        const body = document.createElement('div');
        body.className = 'task-comms__reply-body';
        body.textContent = r.bodyText;
        li.append(meta, body);
        replies.append(li);
      }
    }
    card.append(replies);

    // Reply composer.
    const composer = document.createElement('div');
    composer.className = 'task-comms__reply-composer';
    const ta = document.createElement('textarea');
    ta.className = 'task-comms__reply-input';
    ta.dataset.replyInput = '';
    ta.rows = 2;
    ta.placeholder = 'Reply… (Mod+Enter to send)';
    ta.setAttribute('aria-label', 'Reply');
    this.listen(ta, 'input', () => fitTextarea(ta));
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn task-comms__reply-send';
    send.dataset.replySend = '';
    send.textContent = 'Send';
    const doSend = (): void => {
      const body = ta.value.trim();
      if (body === '') return;
      ta.value = '';
      fitTextarea(ta);
      this.doReply(comm.id, body);
    };
    this.listen(send, 'click', () => doSend());
    this.listen(ta, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        doSend();
      }
    });
    composer.append(ta, send);
    card.append(composer);

    return card;
  }

  /* --------------------------- start-comm form -------------------------- */

  private toggleStartForm(): void {
    this.formOpen = !this.formOpen;
    if (!this.formOpen) {
      this.formHost.replaceChildren();
      return;
    }
    this.newChannelId = null;
    this.newRecipients = [];

    const channelRow = this.field('Channel');
    const channelHost = document.createElement('div');
    const channelPicker = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'comm_channel',
        value: null,
        ...(this.config.projectScopePath ? { parentScopePath: this.config.projectScopePath } : {}),
        'aria-label': 'Channel',
        placeholder: 'Pick a channel…',
        onChange: (v: bigint | null) => {
          this.newChannelId = v;
        },
      },
      channelHost,
    ) as RefPicker;
    this.pickers.push(channelPicker);
    channelRow.append(channelHost);

    const recipRow = this.field('Recipients');
    const recipHost = document.createElement('div');
    const recipPicker = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'person',
        multi: true,
        values: [],
        'aria-label': 'Recipients',
        placeholder: 'Add recipient…',
        onChangeMulti: (values: bigint[]) => {
          this.newRecipients = values;
        },
      },
      recipHost,
    ) as RefPicker;
    this.pickers.push(recipPicker);
    recipRow.append(recipHost);

    const subjectRow = this.field('Subject');
    const subject = document.createElement('input');
    subject.type = 'text';
    subject.className = 'task-comms__form-input';
    subject.dataset.commsSubject = '';
    subject.placeholder = 'Subject (defaults to task title)';
    subjectRow.append(subject);

    const msgRow = this.field('Message');
    const message = document.createElement('textarea');
    message.className = 'task-comms__form-input';
    message.dataset.commsMessage = '';
    message.rows = 3;
    message.placeholder = 'Optional initial message';
    this.listen(message, 'input', () => fitTextarea(message));
    msgRow.append(message);

    const actions = document.createElement('div');
    actions.className = 'task-comms__form-actions';
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'btn btn--primary task-comms__form-create';
    create.dataset.commsCreate = '';
    create.textContent = 'Start comm';
    this.listen(create, 'click', () => this.doCreate(subject.value, message.value));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn task-comms__form-cancel';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.toggleStartForm());
    actions.append(create, cancel);

    this.formHost.replaceChildren(channelRow, recipRow, subjectRow, msgRow, actions);
  }

  private field(label: string): HTMLElement {
    const row = document.createElement('label');
    row.className = 'task-comms__form-row';
    const span = document.createElement('span');
    span.className = 'task-comms__field-label muted';
    span.textContent = label;
    row.append(span);
    return row;
  }

  /* ------------------------------- writes ------------------------------- */

  private doCreate(subject: string, message: string): void {
    if (this.taskId === null || this.newChannelId === null) return;
    this.ctx.api.callByName(
      COMM_CREATE_SPEC,
      {
        taskId: this.taskId,
        channelId: this.newChannelId,
        subject: subject.trim() || undefined,
        initialMessage: message.trim() || undefined,
        recipientPersonIds: this.newRecipients.length > 0 ? this.newRecipients : undefined,
      },
      () => {
        if (!this.isAlive()) return;
        this.formOpen = false;
        this.formHost.replaceChildren();
        this.loadComms();
      },
      { alive: () => this.isAlive() },
    );
  }

  private doReply(commId: bigint, body: string): void {
    this.ctx.api.callByName(
      REPLY_POST_SPEC,
      { commId, body },
      () => {
        if (this.isAlive()) this.loadComms();
      },
      { alive: () => this.isAlive() },
    );
  }

  private doSetRecipients(commId: bigint, ids: bigint[]): void {
    this.ctx.api.callByName(
      COMM_SET_RECIPIENTS_SPEC,
      { commId, recipientPersonIds: ids },
      () => {
        // No reload needed — the picker already reflects the edit; the server
        // truth lands on the next list load.
      },
      { alive: () => this.isAlive() },
    );
  }

  private disposePickers(): void {
    for (const p of this.pickers) this.destroyChild(p);
    this.pickers = [];
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

function personName(card: CardWithAttrs): string {
  const a = card.attributes;
  const t = a['title'] ?? a['name'] ?? a['email'];
  return typeof t === 'string' && t.length > 0 ? t : `#${String(card.id)}`;
}

export function registerCommThreads(): void {
  Control.register('CommThreads', CommThreads);
}

/**
 * CommThreads — the COMMS (email-thread) surface on the task-detail screen.
 *
 * Lists the task's comm cards (`comm.list_for_task`), each with its recipients
 * (an editable RefPicker over `person` → `comm.set_recipients`) and its replies
 * (the email envelopes), plus a per-comm reply composer (`reply.post`). A
 * "+ Start comm" form creates a new comm on a chosen channel
 * (`comm.create`, channel = RefPicker over `comm_channel`).
 *
 * A thread started by a vote request (approval.set with email) names that
 * vote in its header; the link asks the detail to show the request
 * ({@link CommThreadsConfig.onOpenApproval}). The thread is otherwise an
 * ordinary comm — the vote is cast on the task, not by replying.
 *
 * Mounted by TaskDetail into its `comms` slot (parallel to TaskComments). The
 * detail calls {@link CommThreads.reload} after a relevant activity bump and
 * {@link CommThreads.reveal} when a vote request links to its thread. On a
 * thread's own page (a thread that isn't on a task, `/thread/:id`) it shows
 * that one thread ({@link CommThreadsConfig.commId}) as the page's
 * CONVERSATION: the page's header already carries the subject, the status
 * and its actions, so the section has only the thread's reference, its ACK,
 * the recipients, the messages and the reply box. No "+ Start comm" and no
 * phase filter.
 *
 * A received message shows its own text; the history its mail program quoted
 * below it folds behind "Show quoted text" (comm-quoted.ts — display only,
 * the stored message is untouched).
 *
 * Zero-promise: every read/write goes through `api.callByName(..., { alive })`;
 * the list repaints from the onOk callbacks. Recipient / channel pickers are
 * RefPickers (their own `card.search`); we dispose the per-comm pickers on each
 * repaint so a recycled list never leaks child controls.
 */

import { bindSubmitShortcut } from '../ui/submit-shortcut.js';
import { Control, type BaseControlConfig } from '../core/control.js';
import { fitTextarea } from '../util/autosize.js';
import type { RefPicker } from '../ui/ref-picker.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { SPEC } from '../kanban/specs.js';
import {
  COMM_LIST_FOR_TASK_SPEC,
  COMM_CREATE_SPEC,
  COMM_SET_RECIPIENTS_SPEC,
  COMM_SET_ACK_SPEC,
  COMM_ATTACH_SPEC,
  COMM_ATTACHMENT_TO_TASK_SPEC,
  REPLY_POST_SPEC,
  type CommRow,
  type CommListForTaskOutput,
  type MessageFile,
  type MessageRelay,
  type ReplyRow,
} from './comm-specs.js';
import { downloadUrl, uploadFile, type PostChunk } from './upload.js';
import { formatBytes } from './attachments-section.js';
import { ATTACHMENT_LIST_SPEC, type AttachmentListOutput, type AttachmentRow } from './attachment-specs.js';
import { FileGallery, fetchBlobDefault, isViewableKind, type FetchBlob, type GalleryFile } from './file-gallery.js';
import { localTimeEl } from '../util/datetime.js';

import { applyStatusGlyphs, type StatusInfo } from '../ui/status-icon.js';
import { captionedField } from '../ui/captioned-field.js';
import { icon } from '../ui/icons.js';
import { stepText } from './approval-model.js';
import { splitQuoted } from './comm-quoted.js';
export interface CommThreadsConfig extends BaseControlConfig {
  type: 'CommThreads';
  /** The focal task id (string from the route). */
  taskId?: string;
  /** Show just this thread, as its own page's conversation (the page shows
   *  its subject, status and actions), instead of a task's threads. */
  commId?: string;
  /** Dotted tree path holding the in-scope project id (channel search scope). */
  projectScopePath?: string;
  /** Called after a successful LOCAL write (our own reply / new thread /
   *  recipient change) so the parent can advance its background-poll baseline —
   *  our own activity shouldn't trip the "new content" indicator. */
  onLocalWrite?: () => void;
  /** Show the vote request a thread was started for (the detail scrolls its
   *  Approvals section to it). */
  onOpenApproval?: (approvalId: bigint) => void;
  /** A file moved from a thread onto the task (Add to task): the task's
   *  Attachments should reload. */
  onFilesChanged?: () => void;
  /** Tests: the raw chunk sink for a file uploaded from the reply box. */
  postChunk?: PostChunk;
  /** Tests: the blob fetcher the file viewer uses. */
  fetchBlob?: FetchBlob;
}

/** The most a reply can carry, all files together — the SMTP sender's
 *  MaxReplyAttachmentBytes (smtp.go); a reply over it would fail to send. */
export const MAX_REPLY_FILE_BYTES = 20 * 1024 * 1024;

/** A file chosen for a reply. */
interface PickedFile {
  id: bigint;
  filename: string;
  sizeBytes: number;
}

/** The reply box's files (CommThreads.replyFiles). */
interface ReplyFilesBox {
  el: HTMLElement;
  /** The chosen files' attachment ids. */
  ids(): bigint[];
  /** Whether the chosen files fit in one reply. */
  ok(): boolean;
  clear(): void;
}

/** "3 files, 2.1 MB", and whether that is over what a reply can carry. */
export function pickedSummary(sizes: readonly number[]): { text: string; over: boolean } {
  if (sizes.length === 0) return { text: '', over: false };
  const total = sizes.reduce((a, b) => a + b, 0);
  const over = total > MAX_REPLY_FILE_BYTES;
  const count = sizes.length === 1 ? '1 file' : `${sizes.length} files`;
  return { text: `${count}, ${formatBytes(total)}${over ? ` — over the ${MAX_REPLY_FILE_BYTES / (1024 * 1024)} MB a reply can carry` : ''}`, over };
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    CommThreads: CommThreadsConfig;
  }
}

export class CommThreads extends Control<CommThreadsConfig> {
  private taskId: bigint | null = null;
  private commId: bigint | null = null;
  private comms: CommRow[] = [];
  /** Flipped true once the first comm.list_for_task lands; gates "No comms
   *  attached." vs a "Loading…" placeholder so the section doesn't flash empty. */
  private commsLoaded = false;
  /** person id → display name, for recipient chips/labels. */
  private personLabels = new Map<string, string>();
  /** status card id → {label, phase}, for the comm_status badge + section filter. */
  private statusInfo = new Map<string, StatusInfo>();
  /** Per-section comm_status phase filter ('' = all phases). Filters the rendered
   *  comm list independently of the task's own status. */
  private phaseFilter: '' | 'triage' | 'active' | 'terminal' = '';
  /** Child RefPickers (per-comm recipients + the start form), disposed on repaint. */
  private pickers: RefPicker[] = [];
  /** Child TransitionBars (one per comm, bound to comm_status), disposed on repaint. */
  private bars: Control[] = [];
  /** The full-screen viewer for message files (shared with the task's
   *  Attachments, file-gallery.ts); galleryFiles is the thread it pages
   *  through. */
  private galleryFiles: GalleryFile[] = [];
  private readonly gallery = new FileGallery({
    files: () => this.galleryFiles,
    fetchBlob: (url, done, fail) => (this.config.fetchBlob ?? fetchBlobDefault)(url, done, fail),
    alive: () => this.isAlive(),
  });

  private headEl!: HTMLElement;
  private filterEl!: HTMLElement;
  private formHost!: HTMLElement;
  private listEl!: HTMLElement;
  private formOpen = false;
  /** Start-form draft state. */
  private newChannelId: bigint | null = null;
  private newRecipients: bigint[] = [];

  override destroy(): void {
    this.gallery.close();
    super.destroy();
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'task-comms';
    el.dataset.control = 'CommThreads';
    el.dataset.region = 'detail.comms';
    return el;
  }

  protected render(): void {
    this.taskId = parseId(this.config.taskId);
    this.commId = parseId(this.config.commId);

    const head = document.createElement('div');
    head.className = 'task-comms__head';
    const heading = document.createElement('h2');
    heading.className = 'task-detail__section-label muted';
    heading.dataset.commsHeading = '';
    heading.textContent = this.commId !== null ? 'CONVERSATION' : 'COMMS';
    head.append(heading);
    if (this.commId === null) {
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'btn task-comms__start';
      startBtn.dataset.commsStart = '';
      startBtn.textContent = '+ Start comm';
      this.listen(startBtn, 'click', () => this.toggleStartForm());
      head.append(startBtn);
    }
    this.headEl = head;
    this.el.append(head);

    // Per-section comm_status phase filter — lets you narrow the task's comm
    // threads by their OWN status phase, independent of the task status.
    const filterRow = document.createElement('div');
    filterRow.className = 'task-comms__phase-filter';
    filterRow.dataset.commsPhaseFilter = '';
    this.filterEl = filterRow;
    if (this.commId === null) this.el.append(filterRow);

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
    this.loadStatuses();
    this.loadComms();
  }

  /* -------------------------------- loads ------------------------------- */

  /** Public refresh hook (the detail calls this after an activity bump). */
  reload(): void {
    this.loadComms();
  }

  /** Scroll to thread [commId] and flash it (a vote request's "Emailed"
   *  link), clearing a phase filter that hides it. */
  reveal(commId: bigint): void {
    const find = (): HTMLElement | null =>
      this.listEl.querySelector<HTMLElement>(`[data-comm-row="${commId.toString()}"]`);
    if (find() === null && this.phaseFilter !== '') {
      this.phaseFilter = '';
      this.paintFilter();
      this.paintList();
    }
    const card = find();
    if (card === null) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.remove('task-comms__comm--flash');
    void card.offsetWidth; // restart the flash animation
    card.classList.add('task-comms__comm--flash');
  }

  private loadComms(): void {
    if (this.taskId === null && this.commId === null) return;
    this.ctx.api.callByName(
      COMM_LIST_FOR_TASK_SPEC,
      this.commId !== null ? { commId: this.commId } : { taskId: this.taskId },
      (out) => {
        if (!this.isAlive()) return;
        this.comms = (out as CommListForTaskOutput).rows ?? [];
        this.commsLoaded = true;
        this.paintHeading();
        this.paintFilter();
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

  /** Load the status value-cards so each comm renders a labelled, phase-toned
   *  comm_status badge (the comm flow reuses the shared `status` card pool). */
  private loadStatuses(): void {
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'status' },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out as { rows?: CardWithAttrs[] }).rows ?? []) as CardWithAttrs[];
        for (const r of rows) {
          this.statusInfo.set(String(r.id), {
            label: statusLabel(r),
            phase: r.phase ?? '',
            sortOrder: Number(r.attributes['sort_order'] ?? 0),
            groupKey: r.parent_card_id?.toString() ?? '',
          });
        }
        // Comm statuses follow the comm flow (not the task flow), so the ramp
        // stays over the loaded comm-status set rather than scope.workflowStatusIds.
        applyStatusGlyphs(this.statusInfo);
        this.paintFilter();
        this.paintList(); // late labels → repaint badges
      },
      { alive: () => this.isAlive() },
    );
  }

  /** The phase of a comm's comm_status, or '' when unknown / unloaded. */
  private commPhase(comm: CommRow): string {
    return this.statusInfo.get(comm.commStatus.toString())?.phase ?? '';
  }

  /* ------------------------------- painting ----------------------------- */

  private paintHeading(): void {
    const h = this.headEl.querySelector<HTMLElement>('[data-comms-heading]');
    if (h === null) return;
    if (this.commId !== null) h.textContent = 'CONVERSATION';
    else h.textContent = this.comms.length > 0 ? `COMMS (${this.comms.length})` : 'COMMS';
  }

  /** Phase → chip label for the section filter (terminal reads "Resolved"). */
  private static readonly PHASE_LABEL: Record<string, string> = {
    triage: 'Triage',
    active: 'Active',
    terminal: 'Resolved',
  };

  /** Render the comm_status phase-filter chips: "All" plus one chip per phase
   *  present among the task's comms, each with its count. Hidden when there are
   *  no comms. Clicking a chip narrows the rendered list (see paintList). */
  private paintFilter(): void {
    this.filterEl.replaceChildren();
    if (this.comms.length === 0) return;

    const counts = new Map<string, number>();
    for (const c of this.comms) {
      const ph = this.commPhase(c);
      if (ph !== '') counts.set(ph, (counts.get(ph) ?? 0) + 1);
    }

    const chip = (phase: '' | 'triage' | 'active' | 'terminal', label: string, count: number): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'task-comms__phase-chip';
      b.dataset.phaseChip = phase === '' ? 'all' : phase;
      b.setAttribute('aria-pressed', this.phaseFilter === phase ? 'true' : 'false');
      b.textContent = count >= 0 ? `${label} · ${count}` : label;
      this.listen(b, 'click', () => {
        this.phaseFilter = phase;
        this.paintFilter();
        this.paintList();
      });
      this.filterEl.append(b);
    };

    chip('', 'All', this.comms.length);
    for (const phase of ['triage', 'active', 'terminal'] as const) {
      const n = counts.get(phase) ?? 0;
      if (n > 0) chip(phase, CommThreads.PHASE_LABEL[phase] ?? phase, n);
    }
  }

  private paintList(): void {
    this.disposePickers();
    this.listEl.replaceChildren();
    if (this.comms.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-comms__empty muted';
      empty.textContent = this.commsLoaded ? 'No comms attached.' : 'Loading…';
      this.listEl.append(empty);
      return;
    }
    const shown =
      this.phaseFilter === ''
        ? this.comms
        : this.comms.filter((c) => this.commPhase(c) === this.phaseFilter);
    if (shown.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-comms__empty muted';
      const lbl = CommThreads.PHASE_LABEL[this.phaseFilter] ?? this.phaseFilter;
      empty.textContent = `No ${lbl.toLowerCase()} comms.`;
      this.listEl.append(empty);
      return;
    }
    for (const comm of shown) this.listEl.append(this.renderComm(comm));
  }

  private renderComm(comm: CommRow): HTMLElement {
    const card = document.createElement('div');
    card.className = 'task-comms__comm';
    card.dataset.commRow = comm.id.toString();
    // `data-needs-ack` (the warning tint) is set by paintAck() below, the
    // single source of truth for the ACK visual.

    // Header: subject + thread badge.
    const top = document.createElement('div');
    top.className = 'task-comms__comm-head';
    const subj = document.createElement('span');
    subj.className = 'task-comms__subject';
    subj.textContent = comm.title.length > 0 ? comm.title : '(no subject)';
    const thread = document.createElement('span');
    thread.className = 'task-comms__thread muted';
    thread.textContent = comm.threadId;
    // comm_status badge — phase-toned (triage/active/terminal), independent of
    // the task's own status. Resolves the label+phase from the loaded statuses.
    const badge = document.createElement('span');
    badge.className = 'task-comms__status';
    badge.dataset.commStatusBadge = '';
    const info = this.statusInfo.get(comm.commStatus.toString());
    badge.dataset.phase = info?.phase ?? '';
    badge.append(
      document.createTextNode(info !== undefined ? info.label : `#${comm.commStatus}`),
    );

    // Comm-status transition bar: reuses the task TransitionBar, bound to the
    // comm card's `comm_status` flow, so the thread can be advanced and closed
    // (Resolve → terminal) inline. It sits on the SAME row as the subject +
    // status badge (to the badge's right) to keep the comm header compact.
    // onChanged reloads so the badge + filter counts re-resolve from server.
    const barHost = document.createElement('div');
    barHost.className = 'task-comms__transitions';
    barHost.dataset.commTransitions = '';

    // ACK toggle — per-thread "handled" signal. A received inbound reply
    // clears it server-side (acked=false → "Needs ACK"); clicking marks the
    // thread handled ("Acked ✓"). Lets the comms screen filter to unhandled
    // threads.
    const ack = document.createElement('button');
    ack.type = 'button';
    ack.className = 'btn task-comms__ack';
    ack.dataset.commAck = '';
    // Single source of truth for the ACK visual (button label/title + the
    // card's needs-ack tint), reused by the optimistic toggle below so a click
    // updates in place — no list reload.
    const paintAck = (acked: boolean): void => {
      ack.dataset.acked = acked ? 'true' : 'false';
      ack.textContent = acked ? 'Acked ✓' : 'Needs ACK';
      ack.title = acked ? 'Mark this thread as needing attention' : 'Mark this thread as handled';
      card.dataset.needsAck = acked ? 'false' : 'true';
    };
    paintAck(comm.acked);
    this.listen(ack, 'click', () => this.doSetAck(comm, paintAck));

    // On the thread's own page the header shows the subject and the status.
    const single = this.commId !== null;
    thread.title = 'The thread\'s reference: each email carries it, and replies are matched to the thread by it';
    if (single) thread.textContent = `Ref ${comm.threadId}`;
    if (single) top.append(thread, ack);
    else top.append(subj, thread, badge, ack);
    // Detach — on a task, move the thread back into the project as a thread
    // on its own (comm.attach with task 0; docs/CONVERSATIONS.md). Its page
    // offers Attach to task… again.
    if (!single) {
      const detach = document.createElement('button');
      detach.type = 'button';
      detach.className = 'btn task-comms__detach';
      detach.dataset.commDetach = '';
      detach.textContent = 'Detach';
      detach.title = 'Take this thread off the task; it stays in the project, not on a task';
      this.listen(detach, 'click', () => this.doDetach(comm.id, detach));
      top.append(detach);
    }
    if (!single) top.append(barHost);
    card.append(top);

    // A thread a vote request started says which vote; the vote itself is
    // cast on the task, so the link goes to the request.
    const vote = comm.approval;
    if (vote !== null) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'task-comms__vote';
      link.dataset.commApproval = vote.id.toString();
      link.title = 'Show the vote request under Approval votes';
      link.append(icon('vote', 14), ` Vote request: ${stepText(vote.action, vote.from, vote.to)}`);
      this.listen(link, 'click', () => this.config.onOpenApproval?.(vote.id));
      card.append(link);
    }
    if (!single) {
      const bar = this.spawn(
        'TransitionBar',
        {
          type: 'TransitionBar',
          cardId: comm.id.toString(),
          statusAttr: 'comm_status',
          onChanged: () => {
            if (!this.isAlive()) return;
            this.loadComms();
            this.config.onLocalWrite?.();
          },
        },
        barHost,
      );
      this.bars.push(bar);
    }

    // Recipients — the shared compact "To [+ recipient] [chips]" editor.
    const labels: Record<string, string> = {};
    for (const id of comm.recipients) labels[id.toString()] = this.personLabels.get(id.toString()) ?? `#${id}`;
    card.append(
      this.buildRecipientsRow({
        values: comm.recipients.slice(),
        currentLabels: labels,
        onChange: (values) => this.doSetRecipients(comm.id, values),
      }),
    );

    // Every file on the thread's messages, once: what the viewer pages
    // through from any one of them.
    const threadFiles: GalleryFile[] = [];
    const seenFiles = new Set<string>();
    for (const r of comm.replies) {
      for (const f of r.attachments) {
        const key = f.id.toString();
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        threadFiles.push({ id: f.id, filename: f.filename, kind: f.kind });
      }
    }

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
        // Direction drives the bubble tint: 'in' for received mail, 'out' for
        // anything we sent/queued (pending / sent / bounced / failed).
        const direction = r.deliveryStatus === 'received' ? 'in' : 'out';
        li.dataset.direction = direction;
        // "Who · when · status": the sender (with their address), the local
        // date + time, then the delivery status.
        const meta = document.createElement('div');
        meta.className = 'task-comms__reply-meta muted';
        const sender = replySender(r, direction);
        const who = document.createElement('span');
        who.className = 'task-comms__reply-from';
        who.dataset.replyFrom = '';
        who.textContent = sender.name;
        meta.append(who);
        if (sender.detail !== '') {
          const addr = document.createElement('span');
          addr.className = 'task-comms__reply-addr';
          addr.dataset.replyAddr = '';
          addr.textContent = sender.detail;
          meta.append(' ', addr);
        }
        const time = localTimeEl(r.createdAt, 'task-comms__reply-time');
        time.dataset.replyTime = '';
        const status = document.createElement('span');
        status.dataset.replyStatus = r.refused ? 'refused' : '';
        status.textContent = replyStatusText(r);
        // Whitespace between the parts keeps the copied / spoken text
        // readable; the flex layout ignores whitespace-only runs.
        meta.append(' ', metaSep(), ' ', time, ' ', metaSep(), ' ', status);
        li.append(meta, ...replyBody(r.bodyText, direction, (el, ev, fn) => this.listen(el, ev, fn)));
        // The message's files (Add to task on a task's threads), the files
        // an account that drops them left off, and the copy sent on to the
        // rest of the thread (docs/MAIL_INTAKE_AND_CALENDARS.md).
        if (r.attachments.length > 0) li.append(this.messageFiles(comm.id, r.attachments, !single, threadFiles));
        if (r.attachmentsLeftOff > 0) li.append(leftOffNote(r.attachmentsLeftOff));
        if (r.relay !== null) li.append(relayNote(r.relay));
        replies.append(li);
      }
    }
    card.append(replies);

    // Reply composer — the shared compact composer with its inline Send
    // button (Mod+Enter to send), and the files the reply carries: the
    // thread's, the task's, or one uploaded onto the thread.
    const files = this.replyFiles(comm.id, single ? null : this.taskId);
    card.append(
      this.buildComposer({
        placeholder: 'Reply… (Mod+Enter to send)',
        ariaLabel: 'Reply',
        sendLabel: 'Send',
        canSubmit: () => files.ok(),
        onSubmit: (body) => {
          const ids = files.ids();
          files.clear();
          this.doReply(comm.id, body, ids);
        },
      }).el,
      files.el,
    );

    return card;
  }

  /** Build the shared compact comm composer: an auto-sizing textarea with
   *  Mod+Enter (Cmd/Ctrl+Enter) as the submit chord. Reused by the per-comm
   *  reply composer AND the new-comm form's message field so the two never
   *  drift. When `sendLabel` is set the composer renders its own inline Send
   *  button (the standalone reply case); when omitted the textarea stands
   *  alone and the caller drives `submit()` from its own action button (the
   *  new-comm form's "Start comm"), so the form keeps a proper, primary-sized
   *  action row instead of a tiny inline button. `onSubmit` receives the
   *  trimmed body (empty allowed only when `allowEmpty`); the textarea clears
   *  after submit unless `clearOnSubmit === false`. */
  private buildComposer(opts: {
    placeholder: string;
    ariaLabel: string;
    sendLabel?: string;
    rows?: number;
    allowEmpty?: boolean;
    clearOnSubmit?: boolean;
    /** False holds the submit (the text stays): e.g. the reply's files are
     *  over what one reply can carry. */
    canSubmit?: () => boolean;
    onSubmit: (body: string) => void;
  }): { el: HTMLElement; submit: () => void } {
    const composer = document.createElement('div');
    composer.className = 'task-comms__reply-composer';
    const ta = document.createElement('textarea');
    ta.className = 'task-comms__reply-input';
    ta.dataset.replyInput = '';
    ta.rows = opts.rows ?? 2;
    ta.placeholder = opts.placeholder;
    ta.setAttribute('aria-label', opts.ariaLabel);
    this.listen(ta, 'input', () => fitTextarea(ta));
    const submit = (): void => {
      const body = ta.value.trim();
      if (body === '' && opts.allowEmpty !== true) return;
      if (opts.canSubmit !== undefined && !opts.canSubmit()) return;
      if (opts.clearOnSubmit !== false) {
        ta.value = '';
        fitTextarea(ta);
      }
      opts.onSubmit(body);
    };
    bindSubmitShortcut((el, t, fn) => this.listen(el, t, fn), ta, submit);
    composer.append(ta);
    if (opts.sendLabel !== undefined) {
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'btn task-comms__reply-send';
      send.dataset.replySend = '';
      send.textContent = opts.sendLabel;
      this.listen(send, 'click', () => submit());
      composer.append(send);
    }
    return { el: composer, submit };
  }

  /** Build the shared recipients editor — a "To" label beside a `person`
   *  RefPicker in collapsed-add mode ("+ recipient" pill + chips). Used by
   *  BOTH the per-comm header AND the new-comm form so the two render and
   *  behave identically (the drift the screenshots showed). Pushes the picker
   *  onto {@link pickers} for disposal on repaint. */
  private buildRecipientsRow(opts: {
    values: bigint[];
    currentLabels?: Record<string, string>;
    onChange: (values: bigint[]) => void;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'task-comms__recipients';
    const label = document.createElement('span');
    label.className = 'task-comms__field-label muted';
    label.textContent = 'To';
    const host = document.createElement('div');
    host.className = 'task-comms__recipients-picker';
    row.append(label, host);
    const rp = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'person',
        multi: true,
        collapsedAdd: true,
        addLabel: 'recipient',
        values: opts.values.slice(),
        ...(opts.currentLabels ? { currentLabels: opts.currentLabels } : {}),
        'aria-label': 'Recipients',
        placeholder: 'Add recipient…',
        onChangeMulti: (values: bigint[]) => opts.onChange(values),
      },
      host,
    ) as RefPicker;
    this.pickers.push(rp);
    return row;
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
    const channelRow = this.field('Channel', channelHost);

    // Recipients — the SAME shared editor the per-comm header uses, so the new
    // comm renders the compact "To [+ recipient] [chips]" row identically.
    const recipRow = this.buildRecipientsRow({
      values: [],
      onChange: (values) => {
        this.newRecipients = values;
      },
    });

    const subject = document.createElement('input');
    subject.type = 'text';
    subject.className = 'task-comms__form-input';
    subject.dataset.commsSubject = '';
    subject.placeholder = 'Subject (defaults to task title)';
    const subjectRow = this.field('Subject', subject);

    // Message — the shared compact composer rendered bare (no inline Send);
    // the form's "Start comm" button below drives its submit(), and Mod+Enter
    // creates too. A multi-line initial message (rows=3) so the box doesn't
    // read as a cramped single line; the initial message is optional
    // (allowEmpty) and we don't clear on submit since the whole form closes
    // on success (doCreate → toggleStartForm).
    const composer = this.buildComposer({
      placeholder: 'Message… (Mod+Enter to send)',
      ariaLabel: 'Message',
      rows: 3,
      allowEmpty: true,
      clearOnSubmit: false,
      onSubmit: (body) => this.doCreate(subject.value, body),
    });
    const msgRow = this.field('Message', composer.el);

    // Proper action row: primary "Start comm" + "Cancel", grouped and
    // right-aligned (matches the rest of the app's form footers).
    const actions = document.createElement('div');
    actions.className = 'task-comms__form-actions';
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'btn btn--primary task-comms__form-create';
    create.dataset.commsCreate = '';
    create.textContent = 'Start comm';
    this.listen(create, 'click', () => composer.submit());
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn task-comms__form-cancel';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.toggleStartForm());
    actions.append(create, cancel);

    this.formHost.replaceChildren(channelRow, recipRow, subjectRow, msgRow, actions);
  }

  /** One captioned row of the start-comm form. The Channel picker and the
   *  Message composer are composites, so they get a `<div role="group">`, not a
   *  `<label>` (a label forwards every click to its first labelable
   *  descendant — see ui/captioned-field.ts). */
  private field(label: string, control: HTMLElement): HTMLElement {
    return captionedField(label, control, { field: 'task-comms__form-row', caption: 'task-comms__field-label muted' });
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
        this.config.onLocalWrite?.();
      },
      { alive: () => this.isAlive() },
    );
  }

  private doReply(commId: bigint, body: string, attachmentIds: bigint[] = []): void {
    this.ctx.api.callByName(
      REPLY_POST_SPEC,
      { commId, body, ...(attachmentIds.length > 0 ? { attachmentIds } : {}) },
      () => {
        if (!this.isAlive()) return;
        this.loadComms();
        this.config.onLocalWrite?.();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** A message's files: one the viewer can show (image / PDF / markdown)
   *  opens in it — paging through the thread's files (threadFiles) — and
   *  every one downloads; one that came by email and is still the thread's
   *  has Add to task when the thread is on a task (onTask). */
  private messageFiles(commId: bigint, files: readonly MessageFile[], onTask: boolean, threadFiles: GalleryFile[]): HTMLElement {
    const list = document.createElement('ul');
    list.className = 'task-comms__files';
    list.dataset.replyFiles = '';
    for (const f of files) {
      const li = document.createElement('li');
      li.className = 'task-comms__file';
      li.dataset.replyFile = f.id.toString();
      const download = document.createElement('a');
      download.href = downloadUrl(f.id);
      download.download = f.filename;
      if (isViewableKind(f.kind)) {
        const view = document.createElement('button');
        view.type = 'button';
        view.className = 'task-comms__file-name';
        view.dataset.replyFileView = f.id.toString();
        view.title = `View ${f.filename}`;
        view.textContent = f.filename;
        this.listen(view, 'click', () => {
          this.galleryFiles = threadFiles;
          this.gallery.open(f.id);
        });
        download.className = 'task-comms__file-act';
        download.dataset.replyFileDownload = '';
        download.textContent = 'Download';
        li.append(view);
      } else {
        download.className = 'task-comms__file-name';
        download.title = `Download ${f.filename}`;
        download.textContent = f.filename;
        li.append(download);
      }
      const size = document.createElement('span');
      size.className = 'muted';
      size.textContent = formatBytes(f.sizeBytes);
      li.append(document.createTextNode(' '), size);
      if (isViewableKind(f.kind)) li.append(document.createTextNode(' '), download);
      if (f.onThread && onTask) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'task-comms__file-add';
        add.dataset.replyFileAdd = f.id.toString();
        add.textContent = 'Add to task';
        add.title = 'Move this file onto the task, into its Attachments; the message keeps it';
        this.listen(add, 'click', () => this.doAddToTask(commId, f.id, add));
        li.append(document.createTextNode(' '), add);
      } else if (!f.onThread) {
        const on = document.createElement('span');
        on.className = 'muted';
        on.dataset.replyFileOnTask = '';
        on.textContent = '· on the task';
        li.append(document.createTextNode(' '), on);
      }
      list.append(li);
    }
    return list;
  }

  /** The reply box's files. **Attach files** opens a picker: the thread's
   *  files, the task's (taskId; null on a thread's own page), and an upload
   *  from the computer, which lands on the thread. Chosen files show as
   *  chips with their count and size; over what one reply can carry, the
   *  reply is held. Files go with the reply as links — nothing is copied. */
  private replyFiles(commId: bigint, taskId: bigint | null): ReplyFilesBox {
    const picked = new Map<string, PickedFile>();
    let threadRows: AttachmentRow[] | null = null;
    let taskRows: AttachmentRow[] | null = taskId === null ? [] : null;
    let status = '';

    const box = document.createElement('div');
    box.className = 'task-comms__compose-files';
    box.dataset.replyFilesBox = '';
    const bar = document.createElement('div');
    bar.className = 'task-comms__compose-files-bar';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'task-comms__file-add';
    toggle.dataset.replyAttach = '';
    toggle.textContent = 'Attach files';
    toggle.title = 'Send files with this reply: the thread’s, the task’s, or one from your computer';
    const chips = document.createElement('span');
    chips.className = 'task-comms__compose-chips';
    chips.dataset.replyPicked = '';
    const total = document.createElement('span');
    total.className = 'muted';
    total.dataset.replyPickedTotal = '';
    bar.append(toggle, chips, total);
    const panel = document.createElement('div');
    panel.className = 'task-comms__file-picker';
    panel.dataset.replyPicker = '';
    panel.hidden = true;
    box.append(bar, panel);

    const upload = document.createElement('input');
    upload.type = 'file';
    upload.multiple = true;
    upload.hidden = true;
    upload.dataset.replyUpload = '';

    const pick = (row: AttachmentRow, on: boolean): void => {
      if (on) picked.set(row.id.toString(), { id: row.id, filename: row.filename, sizeBytes: row.sizeBytes });
      else picked.delete(row.id.toString());
      paintChips();
    };

    const paintChips = (): void => {
      chips.replaceChildren();
      for (const f of picked.values()) {
        const chip = document.createElement('span');
        chip.className = 'task-comms__chip';
        chip.dataset.replyPickedFile = f.id.toString();
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'task-comms__chip-x';
        x.dataset.replyUnpick = f.id.toString();
        x.setAttribute('aria-label', `Don't send ${f.filename}`);
        x.append(icon('x', 10));
        this.listen(x, 'click', () => {
          picked.delete(f.id.toString());
          paintChips();
          if (!panel.hidden) paintPanel();
        });
        chip.append(document.createTextNode(f.filename), x);
        chips.append(chip);
      }
      const sum = pickedSummary([...picked.values()].map((f) => f.sizeBytes));
      total.textContent = sum.text;
      total.classList.toggle('task-comms__over', sum.over);
    };

    const group = (title: string, rows: AttachmentRow[] | null, empty: string): HTMLElement => {
      const g = document.createElement('div');
      g.className = 'task-comms__picker-group';
      const h = document.createElement('div');
      h.className = 'task-comms__field-label muted';
      h.textContent = title;
      g.append(h);
      if (rows === null) {
        g.append(textEl('p', 'muted', 'Loading…'));
        return g;
      }
      if (rows.length === 0) {
        g.append(textEl('p', 'muted', empty));
        return g;
      }
      for (const row of rows) {
        const label = document.createElement('label');
        label.className = 'task-comms__picker-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.replyPick = row.id.toString();
        cb.checked = picked.has(row.id.toString());
        this.listen(cb, 'change', () => pick(row, cb.checked));
        const size = document.createElement('span');
        size.className = 'muted';
        size.textContent = formatBytes(row.sizeBytes);
        label.append(cb, document.createTextNode(` ${row.filename} `), size);
        g.append(label);
      }
      return g;
    };

    const paintPanel = (): void => {
      panel.replaceChildren();
      panel.append(
        textEl('p', 'task-comms__picker-hint muted', 'Pick files to send with this reply. They are linked to the message, not copied; an upload is added to this thread.'),
        group('This thread’s files', threadRows, 'None yet.'),
      );
      if (taskId !== null) panel.append(group('The task’s files', taskRows, 'The task has no attachments.'));
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'btn';
      up.dataset.replyUploadOpen = '';
      up.textContent = 'Upload from your computer…';
      this.listen(up, 'click', () => upload.click());
      const actions = document.createElement('div');
      actions.className = 'task-comms__picker-actions';
      actions.append(up, upload);
      if (status !== '') actions.append(textEl('span', 'muted', status));
      panel.append(actions);
    };

    const load = (cardId: bigint, done: (rows: AttachmentRow[]) => void): void => {
      this.ctx.api.callByName(
        ATTACHMENT_LIST_SPEC,
        { cardId },
        (out) => {
          if (!this.isAlive()) return;
          done((out as AttachmentListOutput).rows);
          if (!panel.hidden) paintPanel();
        },
        {
          alive: () => this.isAlive(),
          onErr: () => {
            done([]);
            if (!panel.hidden) paintPanel();
          },
        },
      );
    };

    this.listen(toggle, 'click', () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
      if (panel.hidden) return;
      // Fresh lists each time it opens: files come and go.
      threadRows = null;
      if (taskId !== null) taskRows = null;
      paintPanel();
      load(commId, (rows) => (threadRows = rows));
      if (taskId !== null) load(taskId, (rows) => (taskRows = rows));
    });

    this.listen(upload, 'change', () => {
      const chosen = Array.from(upload.files ?? []);
      upload.value = '';
      for (const file of chosen) {
        status = `Uploading ${file.name}…`;
        paintPanel();
        uploadFile(this.ctx.api, commId, file, {
          ...(this.config.postChunk !== undefined ? { postChunk: this.config.postChunk } : {}),
          alive: () => this.isAlive(),
          onDone: (row) => {
            status = '';
            threadRows = [...(threadRows ?? []), row];
            pick(row, true);
            paintPanel();
          },
          onError: () => {
            status = `Couldn’t upload ${file.name}.`;
            paintPanel();
          },
        });
      }
    });

    return {
      el: box,
      ids: () => [...picked.values()].map((f) => f.id),
      ok: () => !pickedSummary([...picked.values()].map((f) => f.sizeBytes)).over,
      clear: () => {
        picked.clear();
        panel.hidden = true;
        paintChips();
      },
    };
  }

  private doAddToTask(commId: bigint, attachmentId: bigint, btn: HTMLButtonElement): void {
    btn.disabled = true;
    this.ctx.api.callByName(
      COMM_ATTACHMENT_TO_TASK_SPEC,
      { commId, attachmentId },
      () => {
        if (!this.isAlive()) return;
        this.loadComms();
        this.config.onFilesChanged?.();
        this.config.onLocalWrite?.();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          btn.disabled = false;
        },
      },
    );
  }

  private doDetach(commId: bigint, btn: HTMLButtonElement): void {
    btn.disabled = true;
    this.ctx.api.callByName(
      COMM_ATTACH_SPEC,
      { commId, taskId: 0n },
      () => {
        if (!this.isAlive()) return;
        this.loadComms();
        this.config.onLocalWrite?.();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          btn.disabled = false;
        },
      },
    );
  }

  /** Toggle the per-thread ACK as a MANUAL, optimistic, in-place edit. One
   *  network trip (the set_ack write); no list reload — reloading would
   *  re-fetch every comm and re-mount each comm's TransitionBar, which is the
   *  "multiple network trips" a single click was causing. Reverts the visual
   *  if the write fails. Mirrors doSetRecipients. */
  private doSetAck(comm: CommRow, paint: (acked: boolean) => void): void {
    const next = !comm.acked;
    comm.acked = next; // optimistic local truth + visual
    paint(next);
    this.ctx.api.callByName(
      COMM_SET_ACK_SPEC,
      { commId: comm.id, acked: next },
      () => {
        // Our own attr_update — advance the parent's poll baseline so it isn't
        // read as inbound "new content". No reload needed.
        if (this.isAlive()) this.config.onLocalWrite?.();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          comm.acked = !next; // revert on failure
          paint(!next);
        },
      },
    );
  }

  private doSetRecipients(commId: bigint, ids: bigint[]): void {
    this.ctx.api.callByName(
      COMM_SET_RECIPIENTS_SPEC,
      { commId, recipientPersonIds: ids },
      () => {
        // No reload needed — the picker already reflects the edit; the server
        // truth lands on the next list load. Still advance the parent's poll
        // baseline so our own attr_update doesn't light the "new" indicator.
        if (this.isAlive()) this.config.onLocalWrite?.();
      },
      { alive: () => this.isAlive() },
    );
  }

  private disposePickers(): void {
    for (const p of this.pickers) this.destroyChild(p);
    this.pickers = [];
    for (const b of this.bars) this.destroyChild(b);
    this.bars = [];
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

/** The sender line of one message: `name` is who it's from (the kitp author,
 *  the matched person, the header display name, or the bare address), and
 *  `detail` the address beside it — "via support@…" for outbound mail (the
 *  channel mailbox it went out through), "<carol@…>" for received mail —
 *  or '' when it would only repeat the name. */
export function replySender(
  r: Pick<ReplyRow, 'from' | 'fromName' | 'fromAddress'>,
  direction: 'in' | 'out',
): { name: string; detail: string } {
  const name = r.fromName || r.fromAddress || r.from || '—';
  const addr = r.fromAddress;
  if (addr === '' || addr.toLowerCase() === name.toLowerCase()) return { name, detail: '' };
  return { name, detail: direction === 'out' ? `via ${addr}` : `<${addr}>` };
}

/** A muted middot separator for a meta line. */
function metaSep(): HTMLElement {
  const sep = document.createElement('span');
  sep.className = 'task-comms__meta-sep';
  sep.setAttribute('aria-hidden', 'true');
  sep.textContent = '·';
  return sep;
}

function personName(card: CardWithAttrs): string {
  const a = card.attributes;
  const t = a['title'] ?? a['name'] ?? a['email'];
  return typeof t === 'string' && t.length > 0 ? t : `#${String(card.id)}`;
}

function statusLabel(card: CardWithAttrs): string {
  const a = card.attributes;
  const t = a['title'] ?? a['name'];
  return typeof t === 'string' && t.length > 0 ? t : `#${String(card.id)}`;
}

export function registerCommThreads(): void {
  Control.register('CommThreads', CommThreads);
}

/**
 * A message's body: its text, and for a received message whose mail program
 * quoted the earlier ones, that history folded behind "Show quoted text"
 * (splitQuoted — display only). Our own messages are stored without a quote
 * (it is added when the mail is sent), so they show whole.
 */
export function replyBody(
  text: string,
  direction: 'in' | 'out',
  listen: (el: HTMLElement, ev: string, fn: () => void) => void,
): HTMLElement[] {
  const body = document.createElement('div');
  body.className = 'task-comms__reply-body';
  const split = direction === 'in' ? splitQuoted(text) : { own: text, quoted: '' };
  body.textContent = split.own;
  if (split.quoted === '') return [body];
  const quoted = document.createElement('div');
  quoted.className = 'task-comms__reply-quoted';
  quoted.dataset.replyQuoted = '';
  quoted.textContent = split.quoted;
  quoted.style.display = 'none';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'task-comms__quote-toggle';
  toggle.dataset.replyQuoteToggle = '';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = 'Show quoted text';
  listen(toggle, 'click', () => {
    const open = quoted.style.display === 'none';
    quoted.style.display = open ? '' : 'none';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = open ? 'Hide quoted text' : 'Show quoted text';
  });
  return [body, toggle, quoted];
}

/** "2 attachments were left off": files an account that drops them didn't
 *  keep (email_attachments = drop). */
export function leftOffText(n: number): string {
  return `${n} ${n === 1 ? 'attachment was' : 'attachments were'} left off — this mail account doesn't keep files from email.`;
}

function leftOffNote(n: number): HTMLElement {
  const p = document.createElement('p');
  p.className = 'task-comms__note muted';
  p.dataset.replyLeftOff = String(n);
  p.textContent = leftOffText(n);
  return p;
}

/** Words for a copy's delivery status. */
const RELAY_STATUS: Readonly<Record<string, string>> = {
  pending: 'queued',
  sent: 'sent',
  failed: 'not sent',
  bounced: 'bounced',
};

/** The delivery status a message shows: a sent one the outgoing server
 *  refused for some of its recipients names them. */
export function replyStatusText(r: { deliveryStatus: string; refused: string }): string {
  return r.deliveryStatus === 'sent' && r.refused ? `sent, but refused for ${r.refused}` : r.deliveryStatus;
}

/** "Sent on to bob@example.com · sent": the copy kitp emailed to the
 *  thread's other people. */
export function relayText(r: MessageRelay): string {
  let status = RELAY_STATUS[r.deliveryStatus] ?? r.deliveryStatus;
  if (r.deliveryStatus === 'sent' && r.refused) status += `, but refused for ${r.refused}`;
  let text = `Sent on to ${r.to} · ${status}`;
  if (r.attachmentsLeftOff > 0) {
    text += ` (without ${r.attachmentsLeftOff === 1 ? 'its attachment' : `its ${r.attachmentsLeftOff} attachments`}: too large to send)`;
  }
  return text;
}

function relayNote(r: MessageRelay): HTMLElement {
  const p = document.createElement('p');
  p.className = 'task-comms__note task-comms__relay muted';
  p.dataset.replyRelay = r.deliveryStatus;
  p.title = 'kitp emailed this message to the thread’s other people, because it reached only this address (Comm Channels → Emailed replies)';
  p.append(icon('corner-down-right', 12), document.createTextNode(` ${relayText(r)}`));
  return p;
}

function textEl(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

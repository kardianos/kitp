/**
 * TaskApprovals — the APPROVAL VOTES section on the task-detail screen: who
 * has been asked to vote on which status step, and every vote.
 *
 * Approvals are a record, not a gate: nothing here blocks or moves the
 * task, and the wording says so ("Vote approve", never the workflow's own
 * "Approve"). A vote belongs to an EDGE — the task moving from one status
 * to another ("Review → Done (Approve)") — and a request asks named people
 * to vote on one. The section is also where a vote is cast: lists only
 * show how votes stand. Each edge renders as a card (see approval-model.ts for the
 * grouping rules): its requests with the people asked and their votes, the
 * votes of anyone else (agents named with their owner), the viewer's own
 * vote buttons, and the edge's full history. A request is settled once the
 * task reaches its target; it stays here, marked reached.
 *
 * Writes: "+ Ask for a vote" (approval.set: edge, people, note), "Vote…"
 * on any edge (approval.decide, with an optional reason that also shows in
 * the comments), per-request "Change who's asked" / "Remove". People are
 * picked with the same RefPicker the comms' recipients use, fed the
 * project's accounts with a person card (activity.actors) — the set the
 * server accepts — instead of every person. Every write reloads
 * approval.list.
 *
 * Asking can also email the people asked: pick a channel and the note
 * becomes the (required) message of a new comm thread on the task. The two
 * stay separate — the request links to its thread ("Emailed: …", which the
 * detail scrolls to via {@link TaskApprovalsConfig.onOpenComm}), and voting
 * still happens only here.
 *
 * Mounted by TaskDetail into its `approvals` slot; the detail calls
 * {@link reload} on its header Refresh and {@link reveal} when a comm thread
 * links back to a request. Zero-promise: every read/write goes through
 * `api.callByName(..., { alive })`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { icon } from '../ui/icons.js';
import type { RefPicker } from '../ui/ref-picker.js';
import { localTimeEl } from '../util/datetime.js';
import { ACTIVITY_ACTORS_SPEC, type ActivityActorsOutput } from './comment-specs.js';
import {
  APPROVAL_LIST_SPEC,
  APPROVAL_SET_SPEC,
  APPROVAL_REMOVE_SPEC,
  APPROVAL_DECIDE_SPEC,
  type ApprovalAction,
  type ApprovalDecideInput,
  type ApprovalListOutput,
  type ApprovalVote,
  type Verdict,
} from './approval-specs.js';
import {
  actionChoices,
  buildApprovalEdges,
  edgeKey,
  edgeLabel,
  type EdgeView,
  type RequestView,
} from './approval-model.js';

export interface TaskApprovalsConfig extends BaseControlConfig {
  type: 'TaskApprovals';
  /** The focal task id (string from the route). */
  taskId?: string;
  /** Tree path of the task's project id (scopes the people offered). Default 'scope.projectId'. */
  projectScopePath?: string;
  /** Called after a successful LOCAL write so the parent can advance its
   *  background-poll baseline and refresh the comment stream (and the comms,
   *  when an ask started an email thread). */
  onLocalWrite?: () => void;
  /** Show the email thread a request started (the detail scrolls its Comms
   *  section to it). */
  onOpenComm?: (commId: bigint) => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    TaskApprovals: TaskApprovalsConfig;
  }
}

interface PersonOption {
  personId: bigint;
  name: string;
  hasEmail: boolean;
}

/** The email picker's "no channel" choice, pinned atop the project's channels. */
const NO_EMAIL = 0n;

const EMPTY: ApprovalListOutput = { status: null, actions: [], requests: [], decisions: [] };

export class TaskApprovals extends Control<TaskApprovalsConfig> {
  private taskId: bigint | null = null;
  private approvals: ApprovalListOutput = EMPTY;
  private loaded = false;
  /** The project's people (accounts with a person card), loaded on first need. */
  private people: PersonOption[] | null = null;
  private busy = false;
  /** Edge keys whose history is expanded. */
  private readonly expanded = new Set<string>();
  /** Which form is open: the ask form, the vote form, or a request's people editor. */
  private form: { kind: 'ask' } | { kind: 'vote'; edge?: string } | { kind: 'people'; requestId: bigint } | null = null;
  /** The open form's RefPickers, disposed when it repaints. */
  private pickers: RefPicker[] = [];

  private headingEl!: HTMLElement;
  private formHost!: HTMLElement;
  private listEl!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'task-approvals';
    el.dataset.control = 'TaskApprovals';
    el.dataset.region = 'detail.approvals';
    return el;
  }

  protected render(): void {
    this.taskId = parseId(this.config.taskId);

    const head = document.createElement('div');
    head.className = 'task-approvals__head';
    const heading = document.createElement('h2');
    heading.className = 'task-detail__section-label muted';
    heading.dataset.approvalsHeading = '';
    heading.textContent = 'APPROVAL VOTES';
    this.headingEl = heading;
    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'btn task-approvals__head-btn';
    ask.dataset.approvalsAsk = '';
    ask.textContent = '+ Ask for a vote';
    this.listen(ask, 'click', () => this.openForm(this.form?.kind === 'ask' ? null : { kind: 'ask' }));
    const vote = document.createElement('button');
    vote.type = 'button';
    vote.className = 'btn task-approvals__head-btn';
    vote.dataset.approvalsVote = '';
    vote.textContent = 'Vote…';
    vote.title = "Vote on a status step nobody asked you about. A vote doesn't change the status.";
    this.listen(vote, 'click', () => this.openForm(this.form?.kind === 'vote' ? null : { kind: 'vote' }));
    head.append(heading, ask, vote);

    const formHost = document.createElement('div');
    formHost.className = 'task-approvals__form';
    formHost.dataset.approvalsForm = '';
    this.formHost = formHost;

    const list = document.createElement('div');
    list.className = 'task-approvals__list';
    list.dataset.approvalsList = '';
    this.listEl = list;

    this.el.append(head, formHost, list);
    this.paint();
    this.load();
  }

  /* -------------------------------- loads ------------------------------- */

  /** Public refresh hook (the detail's header Refresh). */
  reload(): void {
    this.load();
  }

  /** Scroll to request [id] and flash it (a comm thread's "Vote request"
   *  link). */
  reveal(id: bigint): void {
    const box = this.listEl.querySelector<HTMLElement>(`[data-approval-request="${id.toString()}"]`);
    if (box === null) return;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.classList.remove('task-approvals__request--flash');
    void box.offsetWidth; // restart the flash animation
    box.classList.add('task-approvals__request--flash');
  }

  private load(): void {
    if (this.taskId === null) return;
    this.ctx.api.callByName(
      APPROVAL_LIST_SPEC,
      { taskId: this.taskId },
      (out) => {
        if (!this.isAlive()) return;
        this.approvals = (out as ApprovalListOutput) ?? EMPTY;
        this.loaded = true;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Load the project's people once, then run [then]. */
  private withPeople(then: () => void): void {
    if (this.people !== null) {
      then();
      return;
    }
    const pid = this.ctx.tree.at((this.config.projectScopePath ?? 'scope.projectId').split('.')).peek<bigint | null>() ?? null;
    if (pid === null) {
      this.people = [];
      then();
      return;
    }
    this.ctx.api.callByName(
      ACTIVITY_ACTORS_SPEC,
      { projectId: pid },
      (out) => {
        if (!this.isAlive()) return;
        this.people = ((out as ActivityActorsOutput).rows ?? [])
          .filter((r) => !r.isAgent && r.personId !== null)
          .map((r) => ({ personId: r.personId as bigint, name: r.name, hasEmail: r.hasEmail }));
        then();
      },
      { alive: () => this.isAlive() },
    );
  }

  private viewer(): { userId: bigint | null; personId: bigint | null } {
    const u = this.ctx.tree.at(['auth', 'user']).peek<{ userId: bigint | null; personCardId: bigint | null }>();
    return { userId: u?.userId ?? null, personId: u?.personCardId ?? null };
  }

  /* ------------------------------- painting ----------------------------- */

  private paint(): void {
    const edges = buildApprovalEdges(this.approvals, this.viewer());
    const open = edges.reduce((n, e) => n + e.requests.filter((r) => r.open).length, 0);
    this.headingEl.textContent = open > 0 ? `APPROVAL VOTES (${open} open)` : 'APPROVAL VOTES';
    this.listEl.replaceChildren();
    if (edges.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-approvals__empty muted';
      empty.dataset.approvalsEmpty = '';
      empty.textContent = this.loaded ? 'No votes asked for or given.' : 'Loading…';
      this.listEl.append(empty);
    }
    for (const e of edges) this.listEl.append(this.renderEdge(e));
    this.paintForm();
  }

  private renderEdge(e: EdgeView): HTMLElement {
    const card = document.createElement('article');
    card.className = 'task-approvals__edge';
    card.dataset.approvalEdge = e.key;
    if (e.waitingOnMe) card.classList.add('task-approvals__edge--waiting');

    const head = document.createElement('div');
    head.className = 'task-approvals__edge-head';
    const title = document.createElement('span');
    title.className = 'task-approvals__edge-title';
    title.textContent = edgeLabel(e.action, e.from, e.to);
    head.append(title);
    const openReq = e.requests.find((r) => r.open);
    const state = document.createElement('span');
    state.className = 'task-approvals__state';
    state.dataset.approvalState = '';
    if (openReq !== undefined) {
      state.dataset.tone = openReq.rejected > 0 ? 'danger' : openReq.approved === openReq.asked.length ? 'success' : 'accent';
      state.textContent = `${openReq.approved} of ${openReq.asked.length} voted approve${openReq.rejected > 0 ? ` · ${openReq.rejected} voted reject` : ''}`;
    } else if (e.requests.length > 0) {
      state.dataset.tone = 'neutral';
      state.textContent = `Reached ${e.to.label}`;
    } else {
      state.dataset.tone = 'neutral';
      state.textContent = 'Not asked';
    }
    head.append(state);
    card.append(head);

    for (const r of e.requests) card.append(this.renderRequest(e, r));

    if (e.others.length > 0) {
      const others = document.createElement('div');
      others.className = 'task-approvals__others';
      others.dataset.approvalOthers = '';
      const label = document.createElement('span');
      label.className = 'muted';
      label.textContent = e.requests.some((r) => r.open) ? 'Also voted: ' : 'Votes: ';
      others.append(label);
      for (const v of e.others) others.append(voteChip(v.by, v));
      card.append(others);
    }

    card.append(this.renderMyVote(e));

    if (e.history.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'task-approvals__history-toggle';
      toggle.dataset.approvalHistory = e.key;
      const open = this.expanded.has(e.key);
      toggle.textContent = `${open ? 'Hide' : 'Show'} history (${e.history.length})`;
      this.listen(toggle, 'click', () => {
        if (this.expanded.has(e.key)) this.expanded.delete(e.key);
        else this.expanded.add(e.key);
        this.paint();
      });
      card.append(toggle);
      if (open) card.append(renderHistory(e.history));
    }
    return card;
  }

  private renderRequest(e: EdgeView, r: RequestView): HTMLElement {
    const box = document.createElement('div');
    box.className = 'task-approvals__request';
    box.dataset.approvalRequest = r.request.id.toString();
    if (!r.open) box.classList.add('task-approvals__request--settled');

    const meta = document.createElement('div');
    meta.className = 'task-approvals__meta muted';
    meta.append(`Asked by ${r.request.requestedBy || 'someone'} · `, localTimeEl(r.request.requestedAt, 'task-approvals__time'));
    if (!r.open) meta.append(` · reached ${e.to.label} `, localTimeEl(r.request.reachedAt, 'task-approvals__time'));
    box.append(meta);
    if (r.request.note !== '') {
      const note = document.createElement('p');
      note.className = 'task-approvals__note';
      note.textContent = r.request.note;
      box.append(note);
    }
    const comm = r.request.comm;
    if (comm !== null) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'task-approvals__link task-approvals__comm';
      link.dataset.approvalComm = comm.id.toString();
      link.title = 'Show the email thread in Comms';
      const count = comm.messages === 1 ? '1 message' : `${comm.messages} messages`;
      link.append(icon('mail', 14), ` Emailed: ${comm.subject || '(no subject)'} · ${count}`);
      this.listen(link, 'click', () => this.config.onOpenComm?.(comm.id));
      box.append(link);
    }

    const asked = document.createElement('div');
    asked.className = 'task-approvals__asked';
    for (const a of r.asked) {
      const chip = voteChip(a.name, a.vote);
      chip.dataset.approvalAsked = a.personId.toString();
      asked.append(chip);
    }
    box.append(asked);

    if (r.open) {
      const actions = document.createElement('div');
      actions.className = 'task-approvals__request-actions';
      const people = document.createElement('button');
      people.type = 'button';
      people.className = 'task-approvals__link';
      people.dataset.approvalPeople = r.request.id.toString();
      people.textContent = "Change who's asked";
      this.listen(people, 'click', () => this.openForm({ kind: 'people', requestId: r.request.id }));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'task-approvals__link task-approvals__link--danger';
      remove.dataset.approvalRemove = r.request.id.toString();
      remove.textContent = 'Remove request';
      this.listen(remove, 'click', () => this.doRemove(r.request.id));
      actions.append(people, remove);
      box.append(actions);
    }
    return box;
  }

  /** The viewer's vote on an edge: buttons when they haven't voted this
   *  round (prominent when asked), else their vote with a way to change it. */
  private renderMyVote(e: EdgeView): HTMLElement {
    const row = document.createElement('div');
    row.className = 'task-approvals__mine';
    row.dataset.approvalMine = e.key;
    const openReq = e.requests.find((r) => r.open);
    const target: Pick<ApprovalDecideInput, 'approvalId' | 'fromStatusId' | 'toStatusId'> =
      openReq !== undefined ? { approvalId: openReq.request.id } : { fromStatusId: e.from.id, toStatusId: e.to.id };
    if (e.mine !== null) {
      const said = document.createElement('span');
      said.className = 'muted';
      said.textContent = e.mine.decision === 'approve' ? 'You voted approve.' : 'You voted reject.';
      row.append(said);
      const flip: Verdict = e.mine.decision === 'approve' ? 'reject' : 'approve';
      row.append(this.voteButton(flip === 'approve' ? 'Vote approve instead' : 'Vote reject instead', flip, target, row, false));
      return row;
    }
    if (e.waitingOnMe) {
      const ask = document.createElement('span');
      ask.className = 'task-approvals__your-turn';
      ask.textContent = 'Waiting on your vote:';
      row.append(ask);
    }
    row.append(
      this.voteButton('Vote approve', 'approve', target, row, e.waitingOnMe),
      this.voteButton('Vote reject', 'reject', target, row, false),
      this.reasonToggle(row),
      voteHint(),
    );
    return row;
  }

  /** "Add a reason": reveals a box the vote buttons then send along. */
  private reasonToggle(row: HTMLElement): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'task-approvals__link';
    b.dataset.approvalAddReason = '';
    b.textContent = 'Add a reason';
    this.listen(b, 'click', () => {
      b.remove();
      const reason = document.createElement('textarea');
      reason.className = 'task-approvals__reason';
      reason.dataset.approvalReason = '';
      reason.rows = 2;
      reason.placeholder = 'Why — shown with your vote in the comments';
      row.append(reason);
      queueMicrotask(() => reason.focus());
    });
    return b;
  }

  private voteButton(
    label: string,
    decision: Verdict,
    target: Pick<ApprovalDecideInput, 'approvalId' | 'fromStatusId' | 'toStatusId'>,
    row: HTMLElement,
    asked: boolean,
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    // Outlined, never the primary style: these record a vote, they don't
    // move the task like the status bar's buttons do.
    b.className = 'btn task-approvals__vote';
    if (asked) b.dataset.asked = '';
    b.dataset.approvalVote = decision;
    b.append(icon('vote', 14), ` ${label}`);
    this.listen(b, 'click', () => {
      // Votes straight away; a reason opened with "Add a reason" goes along.
      const reason = row.querySelector('textarea') as HTMLTextAreaElement | null;
      this.doDecide({ ...target, decision, reason: reason?.value ?? '' });
    });
    return b;
  }

  /* -------------------------------- forms ------------------------------- */

  private openForm(form: TaskApprovals['form']): void {
    this.form = form;
    if (form !== null && form.kind !== 'vote') {
      this.withPeople(() => this.paintForm());
      return;
    }
    this.paintForm();
  }

  private disposePickers(): void {
    for (const p of this.pickers) this.destroyChild(p);
    this.pickers = [];
  }

  private paintForm(): void {
    this.disposePickers();
    this.formHost.replaceChildren();
    const form = this.form;
    if (form === null) return;
    if (form.kind === 'ask') this.formHost.append(this.askForm());
    else if (form.kind === 'vote') this.formHost.append(this.voteForm());
    else {
      const req = this.approvals.requests.find((r) => r.id === form.requestId);
      if (req === undefined) {
        this.form = null;
        return;
      }
      this.formHost.append(this.peopleForm(req.id, req.approvers, edgeLabel(req.action, req.from, req.to)));
    }
  }

  /** A <select> of the flow's actions (the current status's first). */
  private actionSelect(selected?: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'task-approvals__select';
    sel.dataset.approvalAction = '';
    sel.setAttribute('aria-label', 'Status step');
    for (const a of actionChoices(this.approvals)) {
      const opt = document.createElement('option');
      opt.value = edgeKey(a.from.id, a.to.id);
      opt.textContent = edgeLabel(a.label, a.from, a.to);
      sel.append(opt);
    }
    if (selected !== undefined) sel.value = selected;
    return sel;
  }

  private actionFor(key: string): ApprovalAction | undefined {
    return this.approvals.actions.find((a) => edgeKey(a.from.id, a.to.id) === key);
  }

  /** The people picker — the comms' recipient RefPicker ("+ person" and
   *  chips), its options the project's accounts that can vote. [current]
   *  carries names so someone asked earlier keeps theirs; [onChange] sees
   *  each new pick list. */
  private peoplePicker(
    current: ReadonlyArray<{ personId: bigint; name: string }>,
    onChange: (ids: bigint[]) => void = () => {},
  ): { el: HTMLElement; picked: () => bigint[] } {
    const host = document.createElement('div');
    host.className = 'task-approvals__people';
    host.dataset.approvalPeoplePicker = '';
    const people = this.people ?? [];
    if (people.length === 0) {
      host.append(note('Nobody else on this project has a login to vote with.'));
      return { el: host, picked: () => [] };
    }
    const labels: Record<string, string> = {};
    for (const p of [...current, ...people]) labels[p.personId.toString()] = p.name;
    const picker = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'person',
        multi: true,
        collapsedAdd: true,
        addLabel: 'person',
        values: current.map((p) => p.personId),
        currentLabels: labels,
        options: people.map((p) => ({ value: p.personId, label: p.name })),
        'aria-label': 'People asked',
        placeholder: 'Add a person…',
        onChangeMulti: (values: bigint[]) => onChange(values),
      },
      host,
    ) as RefPicker;
    this.pickers.push(picker);
    return { el: host, picked: () => picker.getValues() };
  }

  /** The ask form's email choice: a channel of the project, or "Don't
   *  email" (pinned first, the default). */
  private emailPicker(onChange: (channelId: bigint | null) => void): HTMLElement {
    const host = document.createElement('div');
    host.className = 'task-approvals__email';
    host.dataset.approvalEmail = '';
    const picker = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'comm_channel',
        value: NO_EMAIL,
        pinnedOptions: [{ value: NO_EMAIL, label: "Don't email" }],
        parentScopePath: this.config.projectScopePath ?? 'scope.projectId',
        'aria-label': 'Email them through',
        placeholder: "Don't email",
        onChange: (v: bigint | null) => onChange(v === null || v === NO_EMAIL ? null : v),
      },
      host,
    ) as RefPicker;
    this.pickers.push(picker);
    return host;
  }

  private askForm(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'task-approvals__panel';
    wrap.dataset.approvalAskForm = '';
    if (this.approvals.actions.length === 0) {
      wrap.append(note('This task has no status steps to vote on.'));
      wrap.append(this.cancelButton());
      return wrap;
    }
    const action = this.actionSelect();
    let channel: bigint | null = null;
    const msg = document.createElement('textarea');
    msg.className = 'task-approvals__reason';
    msg.dataset.approvalNote = '';
    msg.rows = 2;
    const msgField = field('Note', msg);
    const emailHint = document.createElement('p');
    emailHint.className = 'task-approvals__email-hint muted';
    emailHint.dataset.approvalEmailHint = '';
    const people = this.peoplePicker([], () => paintEmail());
    // With a channel the note is the email's message, so it's required, and
    // the hint says who it can't reach and that voting stays on the task.
    const paintEmail = (): void => {
      const caption = msgField.querySelector('.task-approvals__label');
      if (caption !== null) caption.textContent = channel === null ? 'Note' : 'Message';
      msg.placeholder = channel === null ? 'Note to the people asked (optional)' : 'Message emailed to the people asked';
      emailHint.hidden = channel === null;
      if (channel === null) return;
      const noEmail = (this.people ?? [])
        .filter((p) => !p.hasEmail && people.picked().includes(p.personId))
        .map((p) => p.name);
      emailHint.textContent =
        'Starts a thread in Comms; replies land there. They still vote here, on the task.' +
        (noEmail.length > 0 ? ` No email address, so not emailed: ${noEmail.join(', ')}.` : '');
    };
    const email = this.emailPicker((v) => {
      channel = v;
      paintEmail();
    });
    paintEmail();
    const error = document.createElement('p');
    error.className = 'task-approvals__error';
    error.setAttribute('role', 'alert');
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary';
    submit.dataset.approvalAskSubmit = '';
    submit.textContent = 'Ask';
    this.listen(submit, 'click', () => {
      const a = this.actionFor(action.value);
      const ids = people.picked();
      if (a === undefined || this.taskId === null) return;
      if (ids.length === 0) {
        error.textContent = 'Pick at least one person.';
        return;
      }
      const text = msg.value.trim();
      if (channel !== null && text === '') {
        error.textContent = 'Write the message to email.';
        msg.focus();
        return;
      }
      this.write(APPROVAL_SET_SPEC, {
        taskId: this.taskId,
        fromStatusId: a.from.id,
        toStatusId: a.to.id,
        approverIds: ids,
        ...(text !== '' ? { note: text } : {}),
        ...(channel !== null ? { email: { channelId: channel } } : {}),
      });
    });
    wrap.append(
      field('Status step', action),
      field('Ask', people.el),
      field('Email', email),
      msgField,
      emailHint,
      error,
      actionsRow(this.cancelButton(), submit),
    );
    return wrap;
  }

  private voteForm(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'task-approvals__panel';
    wrap.dataset.approvalVoteForm = '';
    if (this.approvals.actions.length === 0) {
      wrap.append(note('This task has no status steps to vote on.'));
      wrap.append(this.cancelButton());
      return wrap;
    }
    const action = this.actionSelect();
    const reason = document.createElement('textarea');
    reason.className = 'task-approvals__reason';
    reason.dataset.approvalReason = '';
    reason.rows = 2;
    reason.placeholder = 'Reason (optional)';
    const send = (decision: Verdict): void => {
      const a = this.actionFor(action.value);
      if (a === undefined || this.taskId === null) return;
      this.doDecide({ fromStatusId: a.from.id, toStatusId: a.to.id, decision, reason: reason.value });
    };
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'btn task-approvals__vote';
    approve.dataset.approvalFormVote = 'approve';
    approve.append(icon('vote', 14), ' Vote approve');
    this.listen(approve, 'click', () => send('approve'));
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'btn task-approvals__vote';
    reject.dataset.approvalFormVote = 'reject';
    reject.append(icon('vote', 14), ' Vote reject');
    this.listen(reject, 'click', () => send('reject'));
    wrap.append(
      field('Status step', action),
      field('Reason', reason),
      actionsRow(this.cancelButton(), reject, approve),
      voteHint(),
    );
    return wrap;
  }

  private peopleForm(requestId: bigint, current: ReadonlyArray<{ personId: bigint; name: string }>, title: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'task-approvals__panel';
    wrap.dataset.approvalPeopleForm = requestId.toString();
    const people = this.peoplePicker(current);
    const error = document.createElement('p');
    error.className = 'task-approvals__error';
    error.setAttribute('role', 'alert');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.dataset.approvalPeopleSave = '';
    save.textContent = 'Save';
    this.listen(save, 'click', () => {
      const ids = people.picked();
      if (this.taskId === null) return;
      if (ids.length === 0) {
        error.textContent = 'Ask at least one person, or remove the request.';
        return;
      }
      this.write(APPROVAL_SET_SPEC, { id: requestId, taskId: this.taskId, approverIds: ids });
    });
    wrap.append(note(`Who is asked: ${title}`), people.el, error, actionsRow(this.cancelButton(), save));
    return wrap;
  }

  private cancelButton(): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = 'Cancel';
    this.listen(b, 'click', () => this.openForm(null));
    return b;
  }

  /* ------------------------------- writes ------------------------------- */

  private doDecide(input: Omit<ApprovalDecideInput, 'taskId'>): void {
    if (this.taskId === null) return;
    this.write(APPROVAL_DECIDE_SPEC, { taskId: this.taskId, ...input });
  }

  private doRemove(id: bigint): void {
    this.write(APPROVAL_REMOVE_SPEC, { id });
  }

  /** Fire one write, then close any form and reload. */
  private write(spec: string, input: unknown): void {
    if (this.busy) return;
    this.busy = true;
    this.ctx.api.callByName(
      spec,
      input,
      () => {
        if (!this.isAlive()) return;
        this.busy = false;
        this.form = null;
        this.load();
        this.config.onLocalWrite?.();
      },
      {
        alive: () => this.isAlive(),
        // The central funnel already toasted; keep the form for a retry.
        onErr: () => {
          this.busy = false;
        },
      },
    );
  }
}

/* -------------------------------------------------------------------------- */

/** A name with its vote: ✓ voted approve, ✕ voted reject, … waiting. */
function voteChip(name: string, vote: ApprovalVote | null): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'task-approvals__chip';
  const verdict = vote?.decision ?? 'waiting';
  chip.dataset.vote = verdict;
  chip.append(icon(verdict === 'approve' ? 'check' : verdict === 'reject' ? 'x' : 'ellipsis', 12));
  const text = document.createElement('span');
  text.textContent = name;
  chip.append(text);
  const words = verdict === 'approve' ? 'voted approve' : verdict === 'reject' ? 'voted reject' : 'has not voted yet';
  chip.title = vote?.stale === true ? `${name} ${words} before the task moved on` : `${name} ${words}`;
  if (vote?.stale === true) chip.classList.add('task-approvals__chip--stale');
  return chip;
}

function renderHistory(votes: readonly ApprovalVote[]): HTMLElement {
  const ul = document.createElement('ul');
  ul.className = 'task-approvals__history';
  for (const v of votes) {
    const li = document.createElement('li');
    li.dataset.approvalVoteRow = v.id.toString();
    const line = document.createElement('div');
    line.append(voteChip(v.by, v), ' ', localTimeEl(v.at, 'task-approvals__time'));
    const flags: string[] = [];
    if (v.status !== null) flags.push(`while ${v.status.label}`);
    if (v.settled) flags.push('settled');
    else if (v.stale) flags.push('the task has moved on since');
    if (flags.length > 0) {
      const f = document.createElement('span');
      f.className = 'muted';
      f.textContent = ` · ${flags.join(' · ')}`;
      line.append(f);
    }
    li.append(line);
    if (v.reason !== '') {
      const r = document.createElement('p');
      r.className = 'task-approvals__history-reason';
      r.textContent = v.reason;
      li.append(r);
    }
    ul.append(li);
  }
  return ul;
}

/** The reminder beside the vote buttons that a vote moves nothing. */
function voteHint(): HTMLElement {
  const p = document.createElement('span');
  p.className = 'task-approvals__hint muted';
  p.dataset.approvalHint = '';
  p.textContent = "A vote is a record. It doesn't change the status.";
  return p;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'task-approvals__field';
  const l = document.createElement('span');
  l.className = 'task-approvals__label muted';
  l.textContent = label;
  wrap.append(l, control);
  return wrap;
}

function actionsRow(...buttons: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'task-approvals__form-actions';
  row.append(...buttons);
  return row;
}

function note(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = text;
  return p;
}

function parseId(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

export function registerTaskApprovals(): void {
  Control.register('TaskApprovals', TaskApprovals);
}

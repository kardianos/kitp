/**
 * ThreadPlacement — the TASK section of a thread's own page (an email thread
 * that isn't on a task, `/thread/:id`; docs/CONVERSATIONS.md).
 *
 *   - Attach to task… — a picker over the project's open tasks (an exact
 *     `#id` finds any task); `comm.attach` moves the thread there, history
 *     intact.
 *   - Make a task — a task titled with the thread's subject, starting in the
 *     project's task flow's first status (card.insert's default), then
 *     attached.
 *
 * Both end on the task's page, where the thread now lives. A thread on a task
 * is moved back with Detach in the task's COMMS section. The detail hides
 * this section while Tasks is switched off (SECTION_AREA 'placement').
 *
 * Zero promises: card.insert → comm.attach chain through
 * `api.callByName(..., { alive, onErr })`; a refusal shows inline.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { faultText } from '../admin/record-form.js';
import { navigate, taskUrl } from '../shell/router.js';
import { PROJECT_SPEC, type CardInsertOutput } from '../projects/specs.js';
import { COMM_ATTACH_SPEC } from './comm-specs.js';

export interface ThreadPlacementConfig extends BaseControlConfig {
  type: 'ThreadPlacement';
  /** The thread (comm card) id. */
  commId: string;
  /** The thread's project, where Make a task creates the task. */
  projectId: string;
  /** The thread's subject: Make a task's title. */
  title: string;
  /** Dotted tree path of the project id the task picker searches under.
   *  Default 'scope.projectId' (the detail publishes it). */
  projectScopePath?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ThreadPlacement: ThreadPlacementConfig;
  }
}

export class ThreadPlacement extends Control<ThreadPlacementConfig> {
  private errorEl!: HTMLElement;
  private pickerHost!: HTMLElement;
  private picker: Control | null = null;
  private busy = false;
  private buttons: HTMLButtonElement[] = [];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'task-detail__panel thread-placement';
    el.dataset.control = 'ThreadPlacement';
    return el;
  }

  protected render(): void {
    const head = document.createElement('h2');
    head.className = 'task-detail__panel-head';
    head.textContent = 'Task';
    const body = document.createElement('div');
    body.className = 'task-detail__panel-body thread-placement__body';
    const note = document.createElement('p');
    note.className = 'muted thread-placement__note';
    note.dataset.threadPlacementNote = '';
    note.textContent = 'Not on a task.';
    const row = document.createElement('div');
    row.className = 'thread-placement__actions';
    row.append(
      this.button('Attach to task…', 'attach', () => this.togglePicker()),
      this.button('Make a task', 'make', () => this.makeTask()),
    );
    this.pickerHost = document.createElement('div');
    this.pickerHost.className = 'thread-placement__picker';
    this.pickerHost.dataset.threadPlacementPicker = '';
    this.errorEl = document.createElement('div');
    this.errorEl.className = 'thread-placement__error';
    this.errorEl.dataset.threadPlacementError = '';
    this.errorEl.setAttribute('role', 'alert');
    this.errorEl.style.display = 'none';
    body.append(note, row, this.pickerHost, this.errorEl);
    this.el.append(head, body);
  }

  private button(label: string, key: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--xs';
    b.dataset.threadPlacement = key;
    b.textContent = label;
    this.listen(b, 'click', onClick);
    this.buttons.push(b);
    return b;
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    for (const b of this.buttons) b.disabled = on;
  }

  private showError(text: string): void {
    this.errorEl.textContent = text;
    this.errorEl.style.display = text === '' ? 'none' : '';
  }

  private togglePicker(): void {
    if (this.picker !== null) {
      this.destroyChild(this.picker);
      this.picker = null;
      return;
    }
    this.picker = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'task',
        value: null,
        parentScopePath: this.config.projectScopePath ?? 'scope.projectId',
        excludeTerminal: true,
        placeholder: 'Find a task…',
        'aria-label': 'Task to attach the thread to',
        onChange: (v: bigint | null) => {
          if (v !== null) this.attach(v);
        },
      },
      this.pickerHost,
    );
  }

  private attach(taskId: bigint): void {
    if (this.busy) return;
    this.setBusy(true);
    this.showError('');
    this.ctx.api.callByName(
      COMM_ATTACH_SPEC,
      { commId: BigInt(this.config.commId), taskId },
      () => navigate(taskUrl(taskId)),
      {
        alive: () => this.isAlive(),
        onErr: (f) => {
          this.setBusy(false);
          this.showError(faultText(f).replace(/^comm\.attach: /, ''));
        },
      },
    );
  }

  private makeTask(): void {
    if (this.busy) return;
    this.setBusy(true);
    this.showError('');
    const title = this.config.title.trim() !== '' ? this.config.title.trim() : '(no subject)';
    this.ctx.api.callByName(
      PROJECT_SPEC.cardInsert,
      { cardTypeName: 'task', parentCardId: BigInt(this.config.projectId), title },
      (out) => {
        this.busy = false;
        this.attach((out as CardInsertOutput).id);
      },
      {
        alive: () => this.isAlive(),
        onErr: (f) => {
          this.setBusy(false);
          this.showError(faultText(f).replace(/^card\.insert: /, ''));
        },
      },
    );
  }
}

export function registerThreadPlacement(): void {
  Control.register('ThreadPlacement', ThreadPlacement);
}

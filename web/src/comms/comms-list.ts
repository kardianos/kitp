/**
 * CommsList — the body control for the `comms` screen layout.
 *
 * Lists `comm` cards enclosed by the in-scope project (comms are grandchildren
 * of the project: comm → task → project, reached via `project_id` scoping).
 * Each row shows the subject, a phase-toned `comm_status` badge, and its parent
 * task. Clicking a row opens that task, whose COMMS section can reply / advance
 * / close the thread (see {@link CommThreads} + the comm-bound TransitionBar).
 *
 * The shared ScreenFilterBar (mounted above by ScreenHost) writes
 * `screen.predicate` — including the `comm_status has_phase` leaf composed by
 * the screen's (attr-aware) phase toggles — so the list filters by comm status
 * INDEPENDENTLY of task status. Zero-promise: every read routes through
 * `api.callByName(..., { alive })`; the list repaints from the onOk callback.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { SPEC } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { navigate, taskUrl } from '../shell/router.js';
import { applySearchFilter, type Predicate } from '../filter/predicate.js';

export interface CommsListConfig extends BaseControlConfig {
  type: 'CommsList';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    CommsList: CommsListConfig;
  }
}

export class CommsList extends Control<CommsListConfig> {
  private comms: CardWithAttrs[] = [];
  /** status card id → {label, phase} for the comm_status badge. */
  private statusInfo = new Map<string, { label: string; phase: string }>();
  /** task card id → title, for the parent-task chip. */
  private taskTitles = new Map<string, string>();

  private headEl!: HTMLElement;
  private listEl!: HTMLElement;
  private emptyEl!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'comms-list';
    el.dataset.control = 'CommsList';
    return el;
  }

  protected render(): void {
    const head = document.createElement('header');
    head.className = 'comms-list__head';
    const h = document.createElement('h2');
    h.className = 'comms-list__heading muted';
    h.dataset.commsListHeading = '';
    h.textContent = 'COMMS';
    head.append(h);
    this.headEl = h;
    this.el.append(head);

    const list = document.createElement('div');
    list.className = 'comms-list__rows';
    list.dataset.commsListRows = '';
    list.setAttribute('role', 'list');
    this.listEl = list;
    this.el.append(list);

    const empty = document.createElement('p');
    empty.className = 'comms-list__empty muted';
    empty.dataset.commsListEmpty = '';
    empty.style.display = 'none';
    empty.textContent = 'No comms in this view.';
    this.emptyEl = empty;
    this.el.append(empty);

    this.loadStatuses();
    this.loadTasks();

    // Refire whenever scope or the shared filter (search / predicate / phase
    // toggle) changes. One-way: reads the leaves, fires a load — cascade-safe.
    this.effect(() => {
      this.ctx.tree.at(['scope', 'projectId']).get();
      this.ctx.tree.at(['screen', 'predicate']).get();
      this.ctx.tree.at(['screen', 'search']).get();
      this.ctx.tree.at(['screen', 'searchFields']).get();
      this.loadComms();
    }, 'commsList.query');
  }

  private projectId(): bigint | null {
    return this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
  }

  private loadComms(): void {
    const pid = this.projectId();
    if (pid === null) return;
    const search = this.ctx.tree.at(['screen', 'search']).peek<string>() ?? '';
    const predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    const fields = this.ctx.tree.at(['screen', 'searchFields']).peek<string[]>() ?? ['title'];
    const { where, tree } = applySearchFilter(search, fields, predicate);
    const input: Record<string, unknown> = {
      cardTypeName: 'comm',
      projectId: pid,
      order: [{ field: 'created_at', direction: 'DESC' }],
      limit: 200,
    };
    if (tree !== undefined) input['tree'] = tree;
    else if (where !== undefined) input['where'] = where;
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      input,
      (out) => {
        if (!this.isAlive()) return;
        this.comms = ((out as { rows?: CardWithAttrs[] }).rows ?? []) as CardWithAttrs[];
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Status value-cards → label + phase for the badge (shared `status` pool). */
  private loadStatuses(): void {
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'status' },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out as { rows?: CardWithAttrs[] }).rows ?? []) as CardWithAttrs[];
        for (const r of rows) this.statusInfo.set(r.id.toString(), { label: labelOf(r), phase: r.phase ?? '' });
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Parent-task titles for the row's task chip. */
  private loadTasks(): void {
    const pid = this.projectId();
    if (pid === null) return;
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'task', projectId: pid },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out as { rows?: CardWithAttrs[] }).rows ?? []) as CardWithAttrs[];
        for (const r of rows) this.taskTitles.set(r.id.toString(), labelOf(r));
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private paint(): void {
    this.headEl.textContent = this.comms.length > 0 ? `COMMS · ${this.comms.length}` : 'COMMS';
    this.listEl.replaceChildren();
    this.emptyEl.style.display = this.comms.length === 0 ? '' : 'none';
    for (const comm of this.comms) this.listEl.append(this.renderRow(comm));
  }

  private renderRow(comm: CardWithAttrs): HTMLElement {
    const row = document.createElement('div');
    row.className = 'comms-list__row';
    row.dataset.commRow = comm.id.toString();
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;

    const badge = document.createElement('span');
    badge.className = 'comms-list__status';
    badge.dataset.commStatusBadge = '';
    // comm_status is a card_ref; the wire/decoder may surface it as bigint,
    // number, or digit-string — coerce all three to the lookup key.
    const sid = asIdKey(comm.attributes['comm_status']);
    const info = sid !== null ? this.statusInfo.get(sid) : undefined;
    badge.dataset.phase = info?.phase ?? '';
    badge.textContent = info !== undefined ? info.label : '—';

    const main = document.createElement('div');
    main.className = 'comms-list__main';
    const subject = document.createElement('span');
    subject.className = 'comms-list__subject';
    const title = comm.attributes['title'];
    subject.textContent = typeof title === 'string' && title.length > 0 ? title : '(no subject)';
    const parent = document.createElement('span');
    parent.className = 'comms-list__task muted';
    const taskId = comm.parent_card_id;
    if (taskId !== undefined) {
      const t = this.taskTitles.get(taskId.toString());
      parent.textContent = t !== undefined ? `#${taskId} · ${t}` : `#${taskId}`;
    }
    main.append(subject, parent);

    row.append(badge, main);

    const open = (): void => {
      if (taskId !== undefined) navigate(taskUrl(taskId.toString()));
    };
    this.listen(row, 'click', open);
    this.listen(row, 'keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Enter' || k === 'o') {
        e.preventDefault();
        open();
      }
    });
    return row;
  }
}

function labelOf(card: CardWithAttrs): string {
  const a = card.attributes;
  const t = a['title'] ?? a['name'];
  return typeof t === 'string' && t.length > 0 ? t : `#${card.id.toString()}`;
}

/** Coerce a card_ref attribute value (bigint | number | digit-string) to its
 *  string id key, or null when it isn't a usable id. */
function asIdKey(v: unknown): string | null {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  return null;
}

export function registerCommsList(): void {
  Control.register('CommsList', CommsList);
}

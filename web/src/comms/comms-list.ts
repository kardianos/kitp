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
import { applySearchFilter, upsertTopLevelLeaf, leaf, type Predicate } from '../filter/predicate.js';

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
  /** Flipped true once the first comm query lands; until then the body shows
   *  "Loading…" rather than the empty message (no empty-then-fill flash). */
  private loaded = false;
  /** status card id → {label, phase} for the comm_status badge. */
  private statusInfo = new Map<string, { label: string; phase: string }>();
  /** task card id → title, for the parent-task chip. */
  private taskTitles = new Map<string, string>();
  /** When true, the list is narrowed to threads needing an ACK (a received
   *  message arrived and no operator has marked the thread handled). */
  private needsAckOnly = false;
  /** Keyboard cursor into the rendered comm list (j/k/↑↓ move it, Enter opens). */
  private selectedIndex = 0;
  /** Set once the remembered cursor has been restored on the first load. */
  private cursorRestored = false;

  private headEl!: HTMLElement;
  private listEl!: HTMLElement;
  private emptyEl!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'comms-list';
    el.dataset.control = 'CommsList';
    el.tabIndex = -1; // programmatically focusable (search-box ArrowDown hand-off)
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

    // "Needs ACK" filter — narrows to threads with an unacknowledged inbound
    // message (acked=false). Server-side: ANDs an `acked eq false` leaf into
    // the query predicate (re-fires the load effect via the local toggle).
    const ackToggle = document.createElement('button');
    ackToggle.type = 'button';
    ackToggle.className = 'comms-list__ack-filter';
    ackToggle.dataset.commsAckFilter = '';
    ackToggle.textContent = 'Needs ACK';
    ackToggle.setAttribute('aria-pressed', 'false');
    this.listen(ackToggle, 'click', () => {
      this.needsAckOnly = !this.needsAckOnly;
      ackToggle.setAttribute('aria-pressed', this.needsAckOnly ? 'true' : 'false');
      this.loadComms();
    });
    head.append(ackToggle);

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
    empty.textContent = 'Loading…'; // until the first load lands (see paint)
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

    // Enter / o on the focused body opens the selected comm's task. A focused
    // ROW handles its own Enter (row keydown); this is the container-focused case.
    this.listen(this.el, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key !== 'Enter' && e.key !== 'o') return;
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest('[data-comm-row]')) return;
      e.preventDefault();
      this.openSelected();
    });

    // Search box ArrowDown hands focus here (screen.enterBodyNonce).
    this.effect(() => {
      const n = this.ctx.tree.at(['screen', 'enterBodyNonce']).get<number>() ?? 0;
      if (n === 0 || this.comms.length === 0) return;
      if (this.selectedIndex < 0 || this.selectedIndex >= this.comms.length) this.selectedIndex = 0;
      this.repaintSelection();
      this.el.focus();
    }, 'commsList.enterBody');
  }

  override hotkeys(): readonly import('../core/hotkeys.js').HotkeyBinding[] {
    return [
      { binding: 'j', run: () => this.moveSelection(1), label: 'Next comm' },
      { binding: 'k', run: () => this.moveSelection(-1), label: 'Previous comm' },
      { binding: 'ArrowDown', run: () => this.moveSelection(1), label: 'Next comm' },
      { binding: 'ArrowUp', run: () => this.moveSelection(-1), label: 'Previous comm' },
    ];
  }

  private moveSelection(delta: number): void {
    if (this.comms.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.comms.length - 1, this.selectedIndex + delta));
    this.repaintSelection();
    this.rememberCursor();
    // All rows are rendered (no virtualList), so scroll the logical cursor's row
    // into view at the edge.
    const row = this.listEl.querySelector?.(`[data-comm-row][data-index="${this.selectedIndex}"]`);
    (row as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
    // Keep the body focused so Enter / o opens the cursor comm even when j/k
    // arrived as page-wide hotkeys from outside the list.
    this.el.focus({ preventScroll: true });
  }

  /** Re-apply the selected class to the rendered rows by their data-index. */
  private repaintSelection(): void {
    const rows = this.listEl.querySelectorAll?.('[data-comm-row]') ?? [];
    for (const node of rows as unknown as HTMLElement[]) {
      const on = Number(node.dataset?.index ?? '-1') === this.selectedIndex;
      node.classList?.toggle('comms-list__row--selected', on);
      node.setAttribute?.('aria-selected', on ? 'true' : 'false');
    }
  }

  private openSelected(): void {
    const comm = this.comms[this.selectedIndex];
    if (comm === undefined) return;
    this.rememberCardId(comm.id);
    const taskId = comm.parent_card_id;
    if (taskId !== undefined) navigate(taskUrl(taskId.toString()));
  }

  /* ---- logical-cursor persistence (remember across nav, by comm id) ------- */

  private cursorNode() {
    const pid = this.projectId();
    if (pid === null) return null;
    return this.ctx.tree.at(['session', 'cursor', 'comms', pid.toString()]);
  }
  private rememberedCursorId(): bigint | undefined {
    const v = this.cursorNode()?.peek<bigint>();
    return typeof v === 'bigint' ? v : undefined;
  }
  private rememberCardId(id: bigint): void {
    this.cursorNode()?.set(id);
  }
  private rememberCursor(): void {
    const comm = this.comms[this.selectedIndex];
    if (comm !== undefined) this.rememberCardId(comm.id);
  }

  private projectId(): bigint | null {
    return this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
  }

  private loadComms(): void {
    const pid = this.projectId();
    if (pid === null) return;
    const search = this.ctx.tree.at(['screen', 'search']).peek<string>() ?? '';
    let predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    const fields = this.ctx.tree.at(['screen', 'searchFields']).peek<string[]>() ?? ['title'];
    // "Needs ACK" narrows to threads with an unacknowledged inbound message.
    // `acked eq false` matches only comms carrying an explicit acked=false row
    // (inbound sets it; the default-true case has no row, so it's excluded).
    if (this.needsAckOnly) {
      predicate = upsertTopLevelLeaf(predicate, leaf('acked', 'eq', [false]));
    }
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
        this.loaded = true;
        // Restore the remembered logical cursor (by comm id) on the first load
        // after (re)mount so returning from a task re-highlights its comm.
        let restored = false;
        if (!this.cursorRestored) {
          this.cursorRestored = true;
          const want = this.rememberedCursorId();
          if (want !== undefined) {
            const i = this.comms.findIndex((c) => c.id === want);
            if (i >= 0) {
              this.selectedIndex = i;
              restored = true;
            }
          }
        }
        this.paint();
        if (restored) {
          const row = this.listEl.querySelector?.(`[data-comm-row][data-index="${this.selectedIndex}"]`);
          (row as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
        }
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
    this.emptyEl.textContent = this.loaded ? 'No comms in this view.' : 'Loading…';
    this.emptyEl.style.display = this.comms.length === 0 ? '' : 'none';
    if (this.selectedIndex >= this.comms.length) this.selectedIndex = Math.max(0, this.comms.length - 1);
    this.comms.forEach((comm, i) => this.listEl.append(this.renderRow(comm, i)));
  }

  private renderRow(comm: CardWithAttrs, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'comms-list__row';
    row.dataset.commRow = comm.id.toString();
    row.dataset.index = String(index);
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    if (index === this.selectedIndex) {
      row.classList.add('comms-list__row--selected');
      row.setAttribute('aria-selected', 'true');
    }

    const badge = document.createElement('span');
    badge.className = 'comms-list__status';
    badge.dataset.commStatusBadge = '';
    // comm_status is a card_ref; the wire/decoder may surface it as bigint,
    // number, or digit-string — coerce all three to the lookup key.
    const sid = asIdKey(comm.attributes['comm_status']);
    const info = sid !== null ? this.statusInfo.get(sid) : undefined;
    badge.dataset.phase = info?.phase ?? '';
    badge.textContent = info !== undefined ? info.label : '—';

    // Needs-ACK marker: a received message awaits handling (acked is an
    // explicit false on the comm). Drives a left-edge accent + a small chip.
    const needsAck = comm.attributes['acked'] === false;
    row.dataset.needsAck = needsAck ? 'true' : 'false';

    const main = document.createElement('div');
    main.className = 'comms-list__main';
    const subject = document.createElement('span');
    subject.className = 'comms-list__subject';
    const title = comm.attributes['title'];
    subject.textContent = typeof title === 'string' && title.length > 0 ? title : '(no subject)';
    if (needsAck) {
      const flag = document.createElement('span');
      flag.className = 'comms-list__needs-ack';
      flag.dataset.commsNeedsAck = '';
      flag.textContent = 'Needs ACK';
      subject.append(' ');
      subject.append(flag);
    }
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
      this.rememberCardId(comm.id); // so returning re-highlights this comm
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

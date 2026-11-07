/**
 * ScheduleView — what the Calendar and Timeline layouts have in common
 * (docs/TIMELINE_AND_CALENDAR.md): the shared filter bar's search, Advanced
 * predicate and a personal screen's base filter feed two task reads (dated /
 * undated, schedule-data.ts); the lookups give labels and status glyphs; the
 * Unscheduled tray lists the undated; a drag becomes ordered date writes. A
 * subclass names its tree prefix and draws.
 *
 * Cascade-safe like the Kanban: the watch effects read the filter / scope
 * leaves and write only `<p>.datedTree` / `<p>.undatedTree` / the version leaf
 * the queries watch; result sinks write the data leaves the draw reads.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { TreeNode } from '../core/tree.js';
import type { ApiFault } from '../core/dispatch.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import type { Predicate, WireNode } from '../filter/predicate.js';
import { navigate, taskUrl } from '../shell/router.js';
import { publishTaskNav } from '../shell/task-nav.js';
import { applyStatusGlyphs, statusIcon, type StatusInfo } from '../ui/status-icon.js';
import { datesOf, type TaskDates } from './placement.js';
import { planReschedule, type DragResult, type ReschedulePlan } from './reschedule.js';
import { formatDay } from './dates.js';
import {
  fireReschedule,
  lookupCardOf,
  scheduleFilterTrees,
  sortLookups,
  SCHEDULE_LOOKUPS,
  UNSCHEDULED_LIMIT,
  type LookupCard,
} from './schedule-data.js';
import { UnscheduledTray } from './unscheduled-tray.js';
import { startDayDrag } from './day-drag.js';

export abstract class ScheduleView<C extends BaseControlConfig> extends Control<C> {
  /** The tree prefix this view's leaves live under ('calendar' / 'timeline'). */
  protected abstract readonly prefix: string;

  /** Status id → label / phase / glyph variant, rebuilt when statuses land. */
  protected readonly statusInfo = new Map<string, StatusInfo>();

  protected tray!: UnscheduledTray;
  protected faultEl!: HTMLElement;

  /** A leaf under this view's prefix. */
  protected at(...segs: string[]): TreeNode {
    return this.ctx.tree.at([this.prefix, ...segs]);
  }

  /** The dated tasks (reactive read). */
  protected tasks(): CardWithAttrs[] {
    return (this.at('tasks').get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
  }

  /** A value-card list (peek; the draw subscribes to `<p>.lookupVersion`). */
  protected lookup(name: string): LookupCard[] {
    return (this.at('lookups', name).peek<LookupCard[]>() ?? []) as LookupCard[];
  }

  /**
   * Seed the query leaves, register the result sinks, and wire the watchers
   * and the tray. Call at the start of render(), before anything the data
   * layer reads: mount() wires the queries right after render().
   */
  protected wireSchedule(): void {
    this.at('datedTree').set(undefined);
    this.at('undatedTree').set(undefined);
    const version = this.at('queryVersion');
    if (version.peek<number>() === undefined) version.set(0);
    if (this.at('lookupVersion').peek<number>() === undefined) this.at('lookupVersion').set(0);

    this.handler('landScheduleTasks', (out) => {
      this.at('tasks').set(((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? []);
    });
    this.handler('landUnscheduled', (out) => {
      this.at('unscheduled').set(((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? []);
    });
    for (const l of SCHEDULE_LOOKUPS) {
      this.handler(`landLookup:${l.name}`, (out) => {
        const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
        const cards = sortLookups(rows.map(lookupCardOf));
        this.at('lookups', l.name).set(cards);
        if (l.name === 'statuses') this.rebuildStatusInfo(cards);
        this.bumpLookups();
      });
    }
    // A refused write rolled its patch back; re-read so the server's dates win.
    this.handler('scheduleFailed', () => this.bumpQuery());
    // A tray drop landed: re-read so the tray and the dated list agree.
    this.handler('scheduleDropped', () => this.bumpQuery());

    this.effect(() => {
      this.ctx.tree.at(['scope', 'projectId']).get();
      this.bumpQuery();
    }, `${this.prefix}.scopeWatch`);
    this.effect(() => {
      const search = this.ctx.tree.at(['screen', 'search']).get<string>() ?? '';
      const predicate = this.ctx.tree.at(['screen', 'predicate']).get<Predicate | null>() ?? null;
      const fields = this.ctx.tree.at(['screen', 'searchFields']).get<string[]>() ?? ['title'];
      const scopeTree = this.ctx.tree.at(['screen', 'scopeTree']).get<WireNode | null>() ?? null;
      const { dated, undated } = scheduleFilterTrees(search, fields, predicate, scopeTree);
      this.at('datedTree').set(dated);
      this.at('undatedTree').set(undated);
      this.bumpQuery();
    }, `${this.prefix}.filterWatch`);
    // A task made anywhere (quick entry) shows up without a reload.
    this.effect(() => {
      const nonce = this.ctx.tree.at(['tasks', 'createdNonce']).get<number>() ?? 0;
      if (nonce > 0) this.bumpQuery();
    }, `${this.prefix}.refreshOnCreate`);

    const fault = document.createElement('div');
    fault.className = 'schedule__fault';
    fault.setAttribute('role', 'alert');
    fault.style.display = 'none';
    this.faultEl = fault;
    this.effect(() => {
      const f = this.fault.get();
      fault.style.display = f ? '' : 'none';
      fault.textContent = f ? `Couldn't load the tasks: ${describeFault(f)}` : '';
    }, `${this.prefix}.fault`);

    this.tray = new UnscheduledTray({
      onPress: (ev, row, el) => this.pressTrayRow(ev, row, el),
      onOpen: (row) => this.openTask(row.id),
    });
    this.onDestroy(() => this.tray.dispose());
    // The tray lists the undated rows the view hasn't just scheduled (a drop
    // moves a row into the dated list before the re-read lands).
    this.effect(() => {
      const undated = (this.at('unscheduled').get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
      const dated = new Set(this.tasks().map((t) => t.id));
      const rows = undated.filter((r) => !dated.has(r.id));
      this.tray.update(rows.slice(0, UNSCHEDULED_LIMIT), undated.length > UNSCHEDULED_LIMIT);
    }, `${this.prefix}.tray`);
  }

  /** Re-fire both task reads (a plain write outside any tracked effect). */
  protected bumpQuery(): void {
    const node = this.at('queryVersion');
    node.set((node.peek<number>() ?? 0) + 1);
  }

  private bumpLookups(): void {
    const node = this.at('lookupVersion');
    node.set((node.peek<number>() ?? 0) + 1);
  }

  private rebuildStatusInfo(statuses: readonly LookupCard[]): void {
    this.statusInfo.clear();
    for (const s of statuses) {
      if (s.phase === undefined) continue;
      this.statusInfo.set(s.id.toString(), {
        label: s.label,
        phase: s.phase,
        sortOrder: Number.isFinite(s.sortOrder) ? s.sortOrder : 0,
        ...(s.parentId !== undefined ? { groupKey: s.parentId.toString() } : {}),
      });
    }
    applyStatusGlyphs(this.statusInfo);
  }

  /** The task's status display info, if its status has loaded. */
  protected statusOf(row: CardWithAttrs): StatusInfo | undefined {
    const s = row.attributes['status'];
    return s === undefined || s === null ? undefined : this.statusInfo.get(String(s));
  }

  /** A closed (done / cancelled) task draws muted. */
  protected isClosed(row: CardWithAttrs): boolean {
    return this.statusOf(row)?.phase === 'terminal';
  }

  /** The status glyph for a row (an empty placeholder before statuses land). */
  protected statusGlyph(row: CardWithAttrs, size = 12): HTMLElement {
    const info = this.statusOf(row);
    if (info === undefined) {
      const span = document.createElement('span');
      span.className = 'status-icon status-icon--none';
      span.setAttribute('aria-hidden', 'true');
      return span;
    }
    return statusIcon(info, size);
  }

  /** A value-card's label by id ('' when unknown). */
  protected labelIn(lookup: string, id: unknown): string {
    if (id === undefined || id === null) return '';
    const key = String(id);
    return this.lookup(lookup).find((c) => c.id.toString() === key)?.label ?? '';
  }

  /** Open a task, handing task detail this view's order for prev / next. */
  protected openTask(id: bigint): void {
    publishTaskNav(this.ctx.tree, this.navOrder());
    navigate(taskUrl(id));
  }

  /** The task order task detail steps through (the view's own order). */
  protected navOrder(): bigint[] {
    return this.tasks().map((t) => t.id);
  }

  /** Plan a drag's writes for a row (null = nothing changes). */
  protected planFor(row: CardWithAttrs, drag: DragResult): ReschedulePlan | null {
    return planReschedule(datesOf(row.attributes), drag);
  }

  /** Write a drag's result: the ordered date writes, one batch. */
  protected reschedule(row: CardWithAttrs, drag: DragResult, fromTray = false): void {
    const plan = this.planFor(row, drag);
    if (plan === null) return;
    fireReschedule((name, payload) => this.intent(name, payload), row.id, plan, fromTray ? row : undefined);
  }

  /** The drag tooltip: where the task would land. */
  protected describeLanding(row: CardWithAttrs, drag: DragResult): string {
    const plan = this.planFor(row, drag);
    const next: TaskDates = plan?.next ?? datesOf(row.attributes);
    if (next.start !== null && next.due !== null) {
      return next.start === next.due ? formatDay(next.due) : `${formatDay(next.start)} → ${formatDay(next.due)}`;
    }
    if (next.due !== null) return `Due ${formatDay(next.due)}`;
    if (next.start !== null) return `Starts ${formatDay(next.start)}`;
    return '';
  }

  /** The day under a viewport point, or null — the view's geometry. */
  protected abstract dayAt(clientX: number, clientY: number): string | null;

  /** Show / clear the days a drag would land on. */
  protected abstract previewDrop(row: CardWithAttrs | null, drag: DragResult | null): void;

  /** A press on a tray row: drag it onto a day to give it a due date. */
  private pressTrayRow(ev: PointerEvent, row: CardWithAttrs, el: HTMLElement): void {
    startDayDrag({
      event: ev,
      source: el,
      dayAt: (x, y) => this.dayAt(x, y),
      describe: (day) => this.describeLanding(row, { kind: 'drop', day }),
      onHover: (day) => this.previewDrop(day === null ? null : row, day === null ? null : { kind: 'drop', day }),
      onDrop: (day) => {
        this.previewDrop(null, null);
        this.reschedule(row, { kind: 'drop', day }, true);
      },
      onCancel: () => this.previewDrop(null, null),
    });
  }
}

export function describeFault(f: ApiFault): string {
  switch (f.kind) {
    case 'sub_error':
      return f.message;
    case 'http':
      return `HTTP ${f.status}`;
    case 'network':
      return `network: ${f.message}`;
    case 'decode':
      return `decode: ${f.message}`;
    case 'aborted':
      return `aborted: ${f.reason}`;
  }
}

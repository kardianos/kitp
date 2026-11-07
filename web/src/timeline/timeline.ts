/**
 * Timeline — the `timeline` screen layout (docs/TIMELINE_AND_CALENDAR.md).
 *
 * A row per task: on the left its status, title, assignee and #id (a
 * subtask's relation icon too); on the right a bar from its start to its due
 * date on a day axis — a dot for a due date alone, a dot with a tail for a
 * start with no due date. A today line runs down the axis. Zoom Week /
 * Month / Quarter sets a day's width. The screen's GROUP picker makes bands
 * (milestone, assignee, component, status, …), in the axis's own order —
 * milestones by their date, with the date as a ◆ on the band's row — and
 * `(unset)` last; a band collapses to its header.
 *
 * It reads the tasks the filter bar selects (the shared ScheduleView reads).
 * Drag a bar to move it (both dates, the length kept), either end to change
 * that one date, a tray task onto a day to give it that due date, or the
 * empty axis to scroll. Keyboard: ↑ / ↓ (j / k) move between rows, Enter
 * opens (or folds a band), Alt + ← / → moves the task a day (Shift: a week) —
 * the same writes as a drag — and `t` scrolls to today.
 *
 * Rows recycle through one `virtualList` (fixed row height) so long projects
 * scroll smoothly; the title column is sticky, and the axis header follows the
 * body's horizontal scroll. Zoom and the left edge ride in the URL query
 * (`?zoom=month&at=2026-11-01`).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { HotkeyBinding } from '../core/hotkeys.js';
import { computed, signal } from '../core/signal.js';
import { virtualList, type VirtualListHandle } from '../core/virtual-list.js';
import { bucketKeyOf, type CardWithAttrs } from '../kanban/kanban-helpers.js';
import type { GroupAttr } from '../filter/group-axis.js';
import { tagIdUnderRoot, tagLeaf } from '../filter/tag-prefix.js';
import { readQueryParam, writeQueryParams } from '../shell/router.js';
import { rowLink, setRowLinkHref } from '../shell/popout.js';
import { relationIcon } from '../ui/relation-icon.js';
import { icon } from '../ui/icons.js';
import {
  addDays,
  daysBetween,
  firstOfMonth,
  formatDay,
  formatRange,
  monthOf,
  monthShort,
  parseIsoDate,
  addMonths,
  todayIso,
  weekdayOf,
} from '../schedule/dates.js';
import { datesOf, placementOf, type Placement } from '../schedule/placement.js';
import type { DragResult } from '../schedule/reschedule.js';
import { scheduleActions, scheduleQueries, taskTitle } from '../schedule/schedule-data.js';
import { ScheduleView } from '../schedule/schedule-view.js';
import { startDayDrag, isDragPress } from '../schedule/day-drag.js';
import {
  axisRange,
  dayOfX,
  DAY_WIDTH,
  parseZoom,
  timelineItems,
  UNSET_BAND,
  xOfDay,
  type BandInfo,
  type TimelineItem,
  type TimelineTask,
  type Zoom,
} from './timeline-layout.js';

export interface TimelineConfig extends BaseControlConfig {
  type: 'Timeline';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    Timeline: TimelineConfig;
  }
}

/** Row height (px) — tasks and band headers alike (the virtualList's pitch). */
export const TIMELINE_ROW_HEIGHT = 32;
/** The sticky title column's width (px); styles.css reads it as --tl-label-w. */
export const TIMELINE_LABEL_WIDTH = 300;

type Item = TimelineItem<CardWithAttrs>;
type Drawn = Exclude<Placement, { kind: 'unscheduled' }>;

interface Geometry {
  start: string;
  days: number;
  dayWidth: number;
  today: string;
}

/** What one recycled row slot holds. */
interface Slot {
  label: HTMLElement;
  chev: HTMLElement;
  glyph: HTMLElement;
  rel: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  link: HTMLAnchorElement;
  track: HTMLElement;
  today: HTMLElement;
  bar: HTMLElement;
  barLabel: HTMLElement;
  marker: HTMLElement;
  extent: HTMLElement;
}

/** Days a header ‹ › press scrolls, by zoom. */
const PAGE_DAYS: Readonly<Record<Zoom, number>> = { week: 7, month: 28, quarter: 91 };

export class Timeline extends ScheduleView<TimelineConfig> {
  protected readonly prefix = 'timeline';
  static override queries = scheduleQueries('timeline');
  static override actions = scheduleActions('timeline');

  private readonly zoom = signal<Zoom>('month', 'timeline.zoom');
  private readonly collapsedVersion = signal(0, 'timeline.collapsed');
  private readonly collapsed = new Set<string>();

  private readonly geom = computed<Geometry>(() => {
    const today = todayIso();
    const drawn: Drawn[] = [];
    for (const t of this.tasks()) {
      const p = placementOf(datesOf(t.attributes));
      if (p.kind !== 'unscheduled') drawn.push(p);
    }
    const r = axisRange(drawn, today);
    return { start: r.start, days: r.days, dayWidth: DAY_WIDTH[this.zoom.get()], today };
  }, 'timeline.geom');

  private readonly items = computed<Item[]>(() => {
    const tasks = this.tasks();
    this.at('lookupVersion').get();
    this.collapsedVersion.get();
    const axis = this.ctx.tree.at(['screen', 'groupAxis']).get<GroupAttr | null>() ?? null;
    const drawn: TimelineTask<CardWithAttrs>[] = [];
    for (const row of tasks) {
      const p = placementOf(datesOf(row.attributes));
      if (p.kind === 'unscheduled') continue;
      drawn.push({ row, id: row.id.toString(), title: taskTitle(row), placement: p });
    }
    return timelineItems(drawn, this.bandKeyer(axis), (key) => this.bandInfo(axis, key), this.collapsed);
  }, 'timeline.items');

  private head!: HTMLElement;
  private strip!: HTMLElement;
  /** The month labels drawn on the axis, with the x span of their month. */
  private monthLabels: Array<{ el: HTMLElement; x0: number; x1: number }> = [];
  private countEl!: HTMLElement;
  private body!: HTMLElement;
  private spacer: HTMLElement | null = null;
  private vlist: VirtualListHandle | null = null;
  private zoomBtns = new Map<Zoom, HTMLButtonElement>();
  private readonly slots = new WeakMap<HTMLElement, Slot>();
  private readonly slotItems = new WeakMap<HTMLElement, Item>();

  /** The geometry the axis was last drawn for (scroll is kept across a change). */
  private drawnGeom: Geometry | null = null;
  /** A day to bring to the left edge once the body has a size. */
  private pendingDay: string | null = null;
  private atTimer: ReturnType<typeof setTimeout> | null = null;
  /** The row the keyboard cursor sits on ('band:<key>' / 'task:<id>'). */
  private cursorKey: string | null = null;
  private cursorVisible = false;
  /** A drag's live position for one task, drawn in place of its stored dates. */
  private preview: { id: string; start: string; end: string } | null = null;
  /** A tray drag's hovered day, marked on the axis. */
  private dropDay: string | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'timeline schedule';
    el.dataset.control = 'Timeline';
    return el;
  }

  protected render(): void {
    this.wireSchedule();
    const zoom = parseZoom(readQueryParam('zoom'));
    if (zoom !== null) this.zoom.set(zoom);
    const at = readQueryParam('at');
    this.pendingDay = parseIsoDate(at) !== null ? (at as string) : addDays(todayIso(), -leadDays(this.zoom.peek()));

    const head = document.createElement('div');
    head.className = 'schedule__head';
    const nav = document.createElement('div');
    nav.className = 'schedule__nav';
    const prev = navButton('chevron-left', 'Earlier', 'tlPrev');
    const today = document.createElement('button');
    today.type = 'button';
    today.className = 'btn schedule__today';
    today.dataset.tlToday = '';
    today.textContent = 'Today';
    const next = navButton('chevron-right', 'Later', 'tlNext');
    const title = document.createElement('h2');
    title.className = 'schedule__title';
    title.textContent = 'Timeline';
    nav.append(prev, today, next, title);
    const seg = document.createElement('div');
    seg.className = 'schedule__seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Zoom');
    for (const [z, label] of [['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter']] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'schedule__segbtn';
      b.dataset.tlZoom = z;
      b.textContent = label;
      this.listen(b, 'click', () => this.setZoom(z));
      this.zoomBtns.set(z, b);
      seg.append(b);
    }
    const tools = document.createElement('div');
    tools.className = 'schedule__tools';
    tools.append(seg, this.tray.toggle);
    head.append(nav, tools);

    const main = document.createElement('div');
    main.className = 'schedule__main';
    const frame = document.createElement('div');
    frame.className = 'tl';
    frame.style.setProperty?.('--tl-label-w', `${TIMELINE_LABEL_WIDTH}px`);
    const axisHead = document.createElement('div');
    axisHead.className = 'tl-head';
    const corner = document.createElement('div');
    corner.className = 'tl-head__corner';
    const count = document.createElement('span');
    count.className = 'muted';
    count.dataset.tlCount = '';
    this.countEl = count;
    corner.append(count);
    const axisView = document.createElement('div');
    axisView.className = 'tl-head__axis';
    const strip = document.createElement('div');
    strip.className = 'tl-head__strip';
    strip.dataset.tlAxis = '';
    axisView.append(strip);
    axisHead.append(corner, axisView);
    this.head = axisHead;
    this.strip = strip;

    const body = document.createElement('div');
    body.className = 'tl-body';
    body.dataset.tlBody = '';
    body.tabIndex = 0;
    body.setAttribute('role', 'grid');
    body.setAttribute('aria-label', 'Timeline');
    body.style.overflowX = 'auto';
    this.body = body;
    frame.append(axisHead, body);
    main.append(frame, this.tray.panel);
    this.el.append(this.faultEl, head, main);

    this.listen(prev, 'click', () => this.page(-1));
    this.listen(next, 'click', () => this.page(1));
    this.listen(today, 'click', () => this.scrollToToday());
    this.listen(body, 'scroll', () => this.onScroll());
    this.listen(body, 'pointerdown', (ev) => this.onPress(ev as PointerEvent));
    this.listen(body, 'click', (ev) => this.onClick(ev as MouseEvent));
    this.onDestroy(() => {
      if (this.atTimer !== null) clearTimeout(this.atTimer);
    });

    this.vlist = virtualList<Item>({
      container: body,
      rowHeight: TIMELINE_ROW_HEIGHT,
      data: () => {
        this.geom.get(); // a zoom / axis change redraws every row
        return this.items.get();
      },
      create: (el) => this.createSlot(el),
      update: (el, item, index) => this.fillSlot(el, item, index),
      overscan: 6,
      name: 'timeline.rows',
    });
    this.onDestroy(() => this.vlist?.dispose());
    this.spacer = body.querySelector('[data-role="vlist-spacer"]') as HTMLElement | null;

    // Axis header + horizontal extent, and keeping the view still when the
    // axis grows (a task far out lands) or the zoom changes.
    this.effect(() => {
      const g = this.geom.get();
      this.applyGeometry(g);
    }, 'timeline.axis');

    this.effect(() => {
      const items = this.items.get();
      const tasks = items.filter((i) => i.kind === 'task').length;
      this.countEl.textContent = tasks === 1 ? '1 task' : `${tasks} tasks`;
    }, 'timeline.count');

    this.effect(() => {
      const z = this.zoom.get();
      for (const [k, b] of this.zoomBtns) b.setAttribute('aria-pressed', k === z ? 'true' : 'false');
    }, 'timeline.zoomButtons');
  }

  override hotkeys(): readonly HotkeyBinding[] {
    return [
      { binding: ['ArrowDown', 'j'], label: 'Next row', run: () => this.moveCursor(1) },
      { binding: ['ArrowUp', 'k'], label: 'Previous row', run: () => this.moveCursor(-1) },
      { binding: ['Enter', 'o'], label: 'Open the task (fold a band)', run: () => this.activateCursor() },
      { binding: 'Alt+ArrowRight', label: 'Move the task a day later', run: () => this.nudge(1) },
      { binding: 'Alt+ArrowLeft', label: 'Move the task a day earlier', run: () => this.nudge(-1) },
      { binding: 'Alt+Shift+ArrowRight', label: 'Move the task a week later', run: () => this.nudge(7) },
      { binding: 'Alt+Shift+ArrowLeft', label: 'Move the task a week earlier', run: () => this.nudge(-7) },
      { binding: 't', label: 'Scroll to today', run: () => this.scrollToToday() },
      ...(this.config.hotkeys ?? []),
    ];
  }

  /* ------------------------------- bands -------------------------------- */

  /** A task's band key under the GROUP axis, or null for no bands. */
  private bandKeyer(axis: GroupAttr | null): ((t: TimelineTask<CardWithAttrs>) => string) | null {
    if (axis === null) return null;
    if (axis.tagPrefix !== undefined) {
      const roots = new Map<string, string>();
      for (const t of this.lookup('tags')) if (t.rootExclusiveAt !== undefined) roots.set(t.id.toString(), t.rootExclusiveAt);
      const prefix = axis.tagPrefix;
      return (t) => tagIdUnderRoot(t.row.attributes['tags'], roots, prefix) ?? UNSET_BAND;
    }
    return (t) => {
      const v = t.row.attributes[axis.attr];
      return bucketKeyOf(Array.isArray(v) ? v[0] : v);
    };
  }

  private bandInfo(axis: GroupAttr | null, key: string): BandInfo {
    if (key === UNSET_BAND) return { key, label: '(unset)', sortOrder: Number.POSITIVE_INFINITY };
    const lookup = axis?.lookup ?? null;
    const card = lookup !== null ? this.lookup(lookup).find((c) => c.id.toString() === key) : undefined;
    if (card === undefined) {
      return { key, label: lookup !== null ? `#${key}` : key, sortOrder: Number.POSITIVE_INFINITY };
    }
    const label = axis?.tagPrefix !== undefined ? tagLeaf(card.path ?? card.label) : card.label;
    return { key, label, sortOrder: card.sortOrder, ...(card.due !== undefined ? { date: card.due } : {}) };
  }

  private toggleBand(key: string): void {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.collapsedVersion.set(this.collapsedVersion.peek() + 1);
  }

  /* ------------------------------- rows --------------------------------- */

  private createSlot(el: HTMLElement): void {
    el.className = 'tl-row';
    el.dataset.tlRow = '';
    const label = document.createElement('div');
    label.className = 'tl-row__label';
    const chev = document.createElement('span');
    chev.className = 'tl-row__chev';
    const glyph = document.createElement('span');
    glyph.className = 'tl-row__glyph';
    const rel = document.createElement('span');
    rel.className = 'tl-row__rel';
    const title = document.createElement('span');
    title.className = 'tl-row__title';
    const meta = document.createElement('span');
    meta.className = 'tl-row__meta muted';
    const link = rowLink();
    label.append(chev, glyph, rel, title, meta, link);

    const track = document.createElement('div');
    track.className = 'tl-row__track';
    const today = document.createElement('div');
    today.className = 'tl-row__today';
    const extent = document.createElement('div');
    extent.className = 'tl-extent';
    const bar = document.createElement('div');
    bar.className = 'tl-bar';
    bar.dataset.tlBar = '';
    const hs = document.createElement('div');
    hs.className = 'tl-bar__handle tl-bar__handle--start';
    hs.dataset.tlHandle = 'start';
    const barLabel = document.createElement('span');
    barLabel.className = 'tl-bar__label';
    const he = document.createElement('div');
    he.className = 'tl-bar__handle tl-bar__handle--end';
    he.dataset.tlHandle = 'end';
    bar.append(hs, barLabel, he);
    const marker = document.createElement('div');
    marker.className = 'tl-marker';
    track.append(today, extent, bar, marker);
    el.append(label, track);
    this.slots.set(el, { label, chev, glyph, rel, title, meta, link, track, today, bar, barLabel, marker, extent });
  }

  private fillSlot(el: HTMLElement, item: Item, index: number): void {
    const s = this.slots.get(el);
    if (s === undefined) return;
    this.slotItems.set(el, item);
    const g = this.geom.peek();
    el.dataset.index = String(index);
    el.dataset.kind = item.kind;
    s.track.style.width = `${g.days * g.dayWidth}px`;
    // Weekends shaded (the axis starts on a Sunday); too fine to read at Quarter.
    s.track.style.backgroundImage = item.kind === 'task' && g.dayWidth >= DAY_WIDTH.month ? weekendStripes(g.dayWidth) : 'none';
    s.today.style.left = `${xOfDay(g.start, g.today, g.dayWidth) + Math.floor(g.dayWidth / 2)}px`;
    const key = item.kind === 'band' ? `band:${item.band.key}` : `task:${item.id}`;
    el.classList.toggle('tl-row--cursor', this.cursorVisible && key === this.cursorKey);

    if (item.kind === 'band') {
      el.dataset.cardId = '';
      el.classList.remove('tl-row--closed', 'tl-row--overdue');
      el.classList.add('tl-row--band');
      el.setAttribute('aria-expanded', item.collapsed ? 'false' : 'true');
      s.chev.replaceChildren(icon(item.collapsed ? 'chevron-right' : 'chevron-down', 14));
      s.glyph.replaceChildren();
      s.rel.replaceChildren();
      s.title.textContent = item.band.label;
      s.meta.textContent = String(item.count);
      s.link.removeAttribute('href');
      s.link.style.display = 'none';
      s.bar.style.display = 'none';
      if (item.band.date !== undefined) {
        s.marker.style.display = '';
        s.marker.style.left = `${xOfDay(g.start, item.band.date, g.dayWidth) + Math.floor(g.dayWidth / 2)}px`;
        s.marker.title = `${item.band.label}: ${formatDay(item.band.date)}`;
      } else {
        s.marker.style.display = 'none';
      }
      if (item.extent !== null) {
        s.extent.style.display = '';
        s.extent.style.left = `${xOfDay(g.start, item.extent.start, g.dayWidth)}px`;
        s.extent.style.width = `${(daysBetween(item.extent.start, item.extent.end) + 1) * g.dayWidth}px`;
      } else {
        s.extent.style.display = 'none';
      }
      return;
    }

    const row = item.row;
    el.dataset.cardId = item.id;
    el.classList.remove('tl-row--band');
    el.removeAttribute('aria-expanded');
    s.chev.replaceChildren();
    s.glyph.replaceChildren(this.statusGlyph(row));
    const rel = relationIcon(row, 12);
    s.rel.replaceChildren(...(rel !== null ? [rel] : []));
    s.title.textContent = item.title;
    const who = this.labelIn('persons', row.attributes['assignee']);
    s.meta.textContent = who !== '' ? `${who} · #${item.id}` : `#${item.id}`;
    s.link.style.display = '';
    setRowLinkHref(s.link, row.id);
    s.marker.style.display = 'none';
    s.extent.style.display = 'none';

    const closed = this.isClosed(row);
    const due = datesOf(row.attributes).due;
    el.classList.toggle('tl-row--closed', closed);
    el.classList.toggle('tl-row--overdue', !closed && due !== null && due < g.today);

    const pv = this.preview !== null && this.preview.id === item.id ? this.preview : null;
    const p = item.placement;
    const start = pv?.start ?? p.start;
    const end = pv?.end ?? p.end;
    const kind = pv !== null ? (start === end && p.kind === 'point' ? 'point' : p.kind) : p.kind;
    s.bar.style.display = '';
    s.bar.className = `tl-bar tl-bar--${kind}`;
    s.bar.classList.toggle('tl-bar--open', p.openEnded);
    s.bar.classList.toggle('tl-bar--inverted', p.inverted);
    s.bar.classList.toggle('tl-bar--moving', pv !== null);
    const phase = this.statusOf(row)?.phase;
    if (phase !== undefined) s.bar.dataset.phase = phase;
    else delete s.bar.dataset.phase;
    const x = xOfDay(g.start, start, g.dayWidth);
    const w = (daysBetween(start, end) + 1) * g.dayWidth;
    s.bar.style.left = `${x}px`;
    s.bar.style.width = `${kind === 'span' ? w : g.dayWidth}px`;
    s.barLabel.textContent = kind === 'span' && w >= 60 ? item.title : '';
    s.bar.title =
      kind === 'span'
        ? `${item.title} · ${formatRange(start, end)}`
        : p.openEnded
          ? `${item.title} · starts ${formatDay(start)}, no due date`
          : `${item.title} · due ${formatDay(start)}`;
  }

  /* ------------------------------- axis --------------------------------- */

  private applyGeometry(g: Geometry): void {
    const prev = this.drawnGeom;
    const width = g.days * g.dayWidth;
    if (this.spacer !== null) this.spacer.style.width = `${TIMELINE_LABEL_WIDTH + width}px`;
    this.drawAxis(g);
    if (prev !== null && this.pendingDay === null) {
      // Keep the day at the left edge where it was.
      const leftDay = dayOfX(prev.start, this.body.scrollLeft || 0, prev.dayWidth);
      this.body.scrollLeft = xOfDay(g.start, leftDay, g.dayWidth);
    }
    this.drawnGeom = g;
    this.applyPendingScroll();
  }

  /** Bring the pending day to the left edge once the body is laid out. */
  private applyPendingScroll(tries = 0): void {
    const day = this.pendingDay;
    const g = this.drawnGeom;
    if (day === null || g === null) return;
    if ((this.body.clientWidth || 0) > 0) {
      this.pendingDay = null;
      this.body.scrollLeft = Math.max(0, xOfDay(g.start, day, g.dayWidth));
      this.syncHead();
      return;
    }
    if (tries < 20 && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (this.isAlive()) this.applyPendingScroll(tries + 1);
      });
    }
  }

  private drawAxis(g: Geometry): void {
    const strip = this.strip;
    strip.replaceChildren();
    strip.style.width = `${g.days * g.dayWidth}px`;
    const end = addDays(g.start, g.days - 1);
    // Months along the top; each label stays in view while its month is (syncHead).
    this.monthLabels = [];
    for (let ym = monthOf(g.start); ym <= monthOf(end); ym = addMonths(ym, 1)) {
      const from = firstOfMonth(ym) < g.start ? g.start : firstOfMonth(ym);
      const next = firstOfMonth(addMonths(ym, 1));
      const m = document.createElement('div');
      m.className = 'tl-head__month';
      const x0 = xOfDay(g.start, from, g.dayWidth);
      m.style.left = `${x0}px`;
      const month = Number(ym.slice(5, 7));
      m.textContent = g.dayWidth >= DAY_WIDTH.month || month === 1 ? `${monthShort(month)} ${ym.slice(0, 4)}` : monthShort(month);
      strip.append(m);
      this.monthLabels.push({ el: m, x0, x1: xOfDay(g.start, next, g.dayWidth) });
    }
    // Ticks: every day at Week zoom, every Sunday otherwise.
    for (let i = 0; i < g.days; i++) {
      const day = addDays(g.start, i);
      const sunday = weekdayOf(day) === 0;
      if (g.dayWidth < DAY_WIDTH.week && !sunday) continue;
      const t = document.createElement('div');
      t.className = 'tl-head__tick';
      if (sunday) t.classList.add('tl-head__tick--week');
      if (g.dayWidth >= DAY_WIDTH.week) t.classList.add('tl-head__tick--day');
      if (day === g.today) t.classList.add('tl-head__tick--today');
      t.style.left = `${i * g.dayWidth}px`;
      t.style.width = `${g.dayWidth >= DAY_WIDTH.week ? g.dayWidth : 7 * g.dayWidth}px`;
      if (g.dayWidth >= DAY_WIDTH.month) t.textContent = String(Number(day.slice(8, 10)));
      strip.append(t);
    }
    const today = document.createElement('div');
    today.className = 'tl-head__today';
    today.style.left = `${xOfDay(g.start, g.today, g.dayWidth) + Math.floor(g.dayWidth / 2)}px`;
    today.title = `Today, ${formatDay(g.today)}`;
    strip.append(today);
    if (this.dropDay !== null) {
      const d = document.createElement('div');
      d.className = 'tl-head__drop';
      d.style.left = `${xOfDay(g.start, this.dropDay, g.dayWidth)}px`;
      d.style.width = `${g.dayWidth}px`;
      strip.append(d);
    }
    this.syncHead();
  }

  private syncHead(): void {
    const sl = this.body.scrollLeft || 0;
    this.strip.style.transform = `translateX(${-sl}px)`;
    // The month at the left edge keeps its name in view until the next one.
    for (const m of this.monthLabels) {
      const pinned = sl > m.x0 && sl < m.x1 ? Math.min(sl, m.x1 - 80) : m.x0;
      m.el.style.left = `${Math.max(m.x0, pinned)}px`;
    }
  }

  private onScroll(): void {
    this.syncHead();
    if (this.atTimer !== null) clearTimeout(this.atTimer);
    this.atTimer = setTimeout(() => {
      this.atTimer = null;
      const g = this.drawnGeom;
      if (g !== null && this.isAlive()) writeQueryParams({ at: dayOfX(g.start, this.body.scrollLeft || 0, g.dayWidth) });
    }, 300);
  }

  private setZoom(z: Zoom): void {
    if (z === this.zoom.peek()) return;
    this.zoom.set(z);
    writeQueryParams({ zoom: z });
  }

  private page(n: number): void {
    const g = this.drawnGeom;
    if (g === null) return;
    this.body.scrollLeft = (this.body.scrollLeft || 0) + n * PAGE_DAYS[this.zoom.peek()] * g.dayWidth;
    this.syncHead();
  }

  private scrollToToday(): void {
    const g = this.drawnGeom;
    if (g === null) return;
    const trackW = Math.max(0, (this.body.clientWidth || 0) - TIMELINE_LABEL_WIDTH);
    this.body.scrollLeft = Math.max(0, xOfDay(g.start, g.today, g.dayWidth) - Math.floor(trackW / 3));
    this.syncHead();
  }

  /* ------------------------------ pointer ------------------------------- */

  protected dayAt(x: number, y: number): string | null {
    const g = this.drawnGeom;
    const r = this.body.getBoundingClientRect?.();
    if (g === null || r === undefined) return null;
    if (x < r.left + TIMELINE_LABEL_WIDTH || x > r.right || y < r.top - (this.head.offsetHeight || 0) || y > r.bottom) return null;
    const day = dayOfX(g.start, x - r.left - TIMELINE_LABEL_WIDTH + (this.body.scrollLeft || 0), g.dayWidth);
    return day >= g.start && day <= addDays(g.start, g.days - 1) ? day : null;
  }

  protected previewDrop(row: CardWithAttrs | null, drag: DragResult | null): void {
    this.preview = null;
    this.dropDay = null;
    if (row !== null && drag !== null) {
      if (drag.kind === 'drop') this.dropDay = drag.day;
      else {
        const next = this.planFor(row, drag)?.next;
        const p = next !== undefined ? placementOf(next) : placementOf(datesOf(row.attributes));
        if (p.kind !== 'unscheduled') this.preview = { id: row.id.toString(), start: p.start, end: p.end };
      }
    }
    if (this.drawnGeom !== null) this.drawAxis(this.drawnGeom);
    this.vlist?.refresh();
  }

  private rowAt(target: EventTarget | null): { el: HTMLElement; item: Item } | null {
    const el = (target as Element | null)?.closest?.('[data-tl-row]') as HTMLElement | null | undefined;
    if (el === null || el === undefined) return null;
    const item = this.slotItems.get(el);
    return item !== undefined ? { el, item } : null;
  }

  private onPress(ev: PointerEvent): void {
    const hit = this.rowAt(ev.target);
    const target = ev.target as Element | null;
    const onBar = hit !== null && hit.item.kind === 'task' && target?.closest?.('[data-tl-bar]') != null;
    if (!onBar) {
      // The empty axis pans; the title column doesn't.
      if (target?.closest?.('.tl-row__label') == null) this.pan(ev);
      return;
    }
    if (hit === null || hit.item.kind !== 'task') return;
    const row = hit.item.row;
    const handle = (target?.closest?.('[data-tl-handle]') as HTMLElement | null | undefined)?.dataset.tlHandle;
    const hasSpan = hit.item.placement.kind === 'span';
    const origin = this.dayAt(ev.clientX, ev.clientY);
    if (origin === null) return;
    const dragOf = (day: string): DragResult =>
      hasSpan && handle === 'start'
        ? { kind: 'resizeStart', day }
        : hasSpan && handle === 'end'
          ? { kind: 'resizeEnd', day }
          : { kind: 'move', days: daysBetween(origin, day) };
    this.cursorKey = `task:${hit.item.id}`;
    startDayDrag({
      event: ev,
      source: hit.el,
      ghost: false,
      dayAt: (x, y) => this.dayAt(x, y),
      describe: (day) => this.describeLanding(row, dragOf(day)),
      onHover: (day) => this.previewDrop(day === null ? null : row, day === null ? null : dragOf(day)),
      onDrop: (day) => {
        this.previewDrop(null, null);
        this.reschedule(row, dragOf(day));
      },
      onCancel: () => this.previewDrop(null, null),
    });
  }

  /** Drag on the empty axis scrolls it sideways. */
  private pan(ev: PointerEvent): void {
    if (!isDragPress(ev)) return;
    const x0 = ev.clientX;
    const s0 = this.body.scrollLeft || 0;
    let moved = false;
    const onMove = (e: Event): void => {
      const dx = (e as PointerEvent).clientX - x0;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      this.body.classList.add('tl-body--panning');
      this.body.scrollLeft = s0 - dx;
      this.syncHead();
    };
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      this.body.classList.remove('tl-body--panning');
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
  }

  private onClick(ev: MouseEvent): void {
    const hit = this.rowAt(ev.target);
    if (hit === null) return;
    this.body.focus?.();
    if (hit.item.kind === 'band') {
      this.cursorKey = `band:${hit.item.band.key}`;
      this.toggleBand(hit.item.band.key);
      return;
    }
    this.cursorKey = `task:${hit.item.id}`;
    // A click on the title column opens the task; on the axis it only selects.
    if ((ev.target as Element | null)?.closest?.('.tl-row__label') != null || (ev.target as Element | null)?.closest?.('[data-tl-bar]') != null) {
      this.openTask(hit.item.row.id);
    } else {
      this.vlist?.refresh();
    }
  }

  /* ------------------------------ keyboard ------------------------------ */

  private cursorIndex(items: readonly Item[]): number {
    if (this.cursorKey === null) return -1;
    return items.findIndex((i) => (i.kind === 'band' ? `band:${i.band.key}` : `task:${i.id}`) === this.cursorKey);
  }

  private moveCursor(n: number): void {
    const items = this.items.peek();
    if (items.length === 0) return;
    const at = this.cursorIndex(items);
    const next = Math.min(items.length - 1, Math.max(0, at === -1 ? 0 : at + n));
    const it = items[next]!;
    this.cursorKey = it.kind === 'band' ? `band:${it.band.key}` : `task:${it.id}`;
    this.cursorVisible = true;
    this.revealRow(next);
  }

  private revealRow(index: number): void {
    const top = index * TIMELINE_ROW_HEIGHT;
    const h = this.body.clientHeight || 0;
    if (top < (this.body.scrollTop || 0)) this.body.scrollTop = top;
    else if (h > 0 && top + TIMELINE_ROW_HEIGHT > (this.body.scrollTop || 0) + h) this.body.scrollTop = top + TIMELINE_ROW_HEIGHT - h;
    this.vlist?.refresh();
  }

  private activateCursor(): void {
    const items = this.items.peek();
    const it = items[this.cursorIndex(items)];
    if (it === undefined) return;
    if (it.kind === 'band') this.toggleBand(it.band.key);
    else this.openTask(it.row.id);
  }

  /** Alt + ← / →: the cursor's task moves by `days` (both dates). */
  private nudge(days: number): void {
    const items = this.items.peek();
    const it = items[this.cursorIndex(items)];
    if (it === undefined || it.kind !== 'task') return;
    this.cursorVisible = true;
    this.reschedule(it.row, { kind: 'move', days });
  }

  /** Task detail steps through the rows in the order shown. */
  protected override navOrder(): bigint[] {
    return this.items.peek().flatMap((i) => (i.kind === 'task' ? [i.row.id] : []));
  }
}

/** Saturday + Sunday shading across a Sunday-start track. */
function weekendStripes(dw: number): string {
  const w = 'var(--tl-weekend)';
  return `repeating-linear-gradient(90deg, ${w} 0 ${dw}px, transparent ${dw}px ${6 * dw}px, ${w} ${6 * dw}px ${7 * dw}px)`;
}

/** Days before today the view opens on, by zoom. */
function leadDays(z: Zoom): number {
  return z === 'week' ? 3 : z === 'month' ? 7 : 21;
}

function navButton(name: 'chevron-left' | 'chevron-right', label: string, data: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn schedule__navbtn';
  b.dataset[data] = '';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.append(icon(name, 16));
  return b;
}

export function registerTimeline(): void {
  Control.register('Timeline', Timeline);
}

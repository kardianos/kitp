/**
 * Calendar — the `calendar` screen layout (docs/TIMELINE_AND_CALENDAR.md).
 *
 * A month grid of six Sunday-start weeks, or one week (Month | Week). A task
 * with a due date sits on that day; one with a start and a due date is a bar
 * across those days, wrapping at the week's end; a start with no due date is
 * a chip on the start day, marked open-ended. Milestones with a date show as
 * a ◆ by their day's number. Each week lays its items into lanes
 * (calendar-layout.ts); a day that overflows shows "+N more", which opens
 * the day's full list.
 *
 * It reads the tasks the screen's filter bar selects (the shared ScheduleView
 * reads), ignores GROUP (the bar hides it here), and lets a task be dragged to
 * another day — both its dates move by the same number of days — or dragged
 * in from the Unscheduled tray to get that due date. Clicking a task opens it.
 *
 * The shown month (`?month=2026-11`) or week (`?view=week&week=2026-11-08`)
 * rides in the URL query. Keyboard: arrows move the focused day, Enter opens
 * its first task, `t` goes to today, PageUp / PageDown step a month (a week).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { HotkeyBinding } from '../core/hotkeys.js';
import { signal } from '../core/signal.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { readQueryParam, writeQueryParams } from '../shell/router.js';
import { rowLink, setRowLinkHref } from '../shell/popout.js';
import { icon } from '../ui/icons.js';
import {
  addDays,
  addMonths,
  daysBetween,
  formatDay,
  formatRange,
  monthGridWeeks,
  monthOf,
  monthShort,
  monthTitle,
  parseIsoDate,
  parseMonth,
  startOfWeek,
  todayIso,
  weekDays,
  weekdayNames,
  isWeekend,
} from '../schedule/dates.js';
import { datesOf, placementOf, type Placement } from '../schedule/placement.js';
import type { DragResult } from '../schedule/reschedule.js';
import { scheduleActions, scheduleQueries, taskTitle } from '../schedule/schedule-data.js';
import { ScheduleView } from '../schedule/schedule-view.js';
import { startDayDrag } from '../schedule/day-drag.js';
import { hiddenPerDay, keysOnDay, layoutWeek, type LaidItem, type WeekItem } from './calendar-layout.js';

export interface CalendarConfig extends BaseControlConfig {
  type: 'Calendar';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    Calendar: CalendarConfig;
  }
}

type Mode = 'month' | 'week';

/** Lanes a week shows before "+N more": a month row, and the taller week view. */
export const MONTH_LANES = 3;
export const WEEK_LANES = 12;

export class Calendar extends ScheduleView<CalendarConfig> {
  protected readonly prefix = 'calendar';
  static override queries = scheduleQueries('calendar');
  static override actions = scheduleActions('calendar');

  private readonly mode = signal<Mode>('month', 'calendar.mode');
  /** A day inside the shown month / week. */
  private readonly anchor = signal<string>(todayIso(), 'calendar.anchor');

  private focusDay = todayIso();
  /** The focus ring shows once the keyboard moves it (not on a click). */
  private focusVisible = false;

  private titleEl!: HTMLElement;
  private monthBtn!: HTMLButtonElement;
  private weekBtn!: HTMLButtonElement;
  private gridEl!: HTMLElement;
  private weeksEl!: HTMLElement;
  private moreEl: HTMLElement | null = null;

  /** What the last draw put on screen — for hit-testing, keys and previews. */
  private shownWeeks: string[] = [];
  private weekEls: HTMLElement[] = [];
  private readonly dayEls = new Map<string, HTMLElement>();
  private readonly laidByWeek = new Map<string, LaidItem[]>();
  private readonly rowsById = new Map<string, CardWithAttrs>();
  private readonly placements = new Map<string, Placement>();

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'calendar schedule';
    el.dataset.control = 'Calendar';
    return el;
  }

  protected render(): void {
    this.wireSchedule();
    this.readUrl();

    const head = document.createElement('div');
    head.className = 'schedule__head';
    const nav = document.createElement('div');
    nav.className = 'schedule__nav';
    const prev = navButton('chevron-left', 'Previous', 'calPrev');
    const today = document.createElement('button');
    today.type = 'button';
    today.className = 'btn schedule__today';
    today.dataset.calToday = '';
    today.textContent = 'Today';
    const next = navButton('chevron-right', 'Next', 'calNext');
    const title = document.createElement('h2');
    title.className = 'schedule__title';
    title.dataset.calTitle = '';
    this.titleEl = title;
    nav.append(prev, today, next, title);

    const seg = document.createElement('div');
    seg.className = 'schedule__seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Calendar view');
    this.monthBtn = segButton('Month', 'calMonth');
    this.weekBtn = segButton('Week', 'calWeek');
    seg.append(this.monthBtn, this.weekBtn);
    const right = document.createElement('div');
    right.className = 'schedule__tools';
    right.append(seg, this.tray.toggle);
    head.append(nav, right);

    const main = document.createElement('div');
    main.className = 'schedule__main';
    const grid = document.createElement('div');
    grid.className = 'cal';
    grid.dataset.calGrid = '';
    grid.tabIndex = 0;
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', 'Calendar');
    const names = document.createElement('div');
    names.className = 'cal__weekdays';
    names.setAttribute('role', 'row');
    for (const n of weekdayNames()) {
      const c = document.createElement('div');
      c.className = 'cal__weekday';
      c.setAttribute('role', 'columnheader');
      c.textContent = n;
      names.append(c);
    }
    const weeks = document.createElement('div');
    weeks.className = 'cal__weeks';
    grid.append(names, weeks);
    this.gridEl = grid;
    this.weeksEl = weeks;
    main.append(grid, this.tray.panel);
    this.el.append(this.faultEl, head, main);

    this.listen(prev, 'click', () => this.step(-1));
    this.listen(next, 'click', () => this.step(1));
    this.listen(today, 'click', () => this.goToday());
    this.listen(this.monthBtn, 'click', () => this.setMode('month'));
    this.listen(this.weekBtn, 'click', () => this.setMode('week'));
    // One set of listeners on the weeks host (items are redrawn, the host isn't).
    this.listen(weeks, 'pointerdown', (ev) => this.onPress(ev as PointerEvent));
    this.listen(weeks, 'click', (ev) => this.onClick(ev as MouseEvent));
    this.listen(document, 'pointerdown', (ev) => {
      if (this.moreEl !== null && !this.moreEl.contains(ev.target as Node)) this.closeMore();
    });

    this.effect(() => {
      const mode = this.mode.get();
      const anchor = this.anchor.get();
      const tasks = this.tasks();
      this.at('lookupVersion').get();
      this.draw(mode, anchor, tasks);
    }, 'calendar.draw');
  }

  override hotkeys(): readonly HotkeyBinding[] {
    return [
      { binding: 'ArrowLeft', label: 'Previous day', run: () => this.moveFocus(-1) },
      { binding: 'ArrowRight', label: 'Next day', run: () => this.moveFocus(1) },
      { binding: 'ArrowUp', label: 'Same day, week before', run: () => this.moveFocus(-7) },
      { binding: 'ArrowDown', label: 'Same day, week after', run: () => this.moveFocus(7) },
      { binding: 'PageUp', label: 'Previous month (week)', run: () => this.step(-1) },
      { binding: 'PageDown', label: 'Next month (week)', run: () => this.step(1) },
      { binding: 'Enter', label: "Open the day's first task", run: () => this.openFocusedDay() },
      { binding: 't', label: 'Go to today', run: () => this.goToday() },
      ...(this.config.hotkeys ?? []),
    ];
  }

  /* ------------------------------ navigation ---------------------------- */

  private readUrl(): void {
    const week = parseIsoDate(readQueryParam('week')) !== null ? (readQueryParam('week') as string) : null;
    if (readQueryParam('view') === 'week') {
      this.mode.set('week');
      if (week !== null) this.anchor.set(week);
    } else {
      const month = parseMonth(readQueryParam('month'));
      if (month !== null) this.anchor.set(month === monthOf(todayIso()) ? todayIso() : `${month}-01`);
    }
    this.focusDay = this.anchor.peek();
  }

  private writeUrl(): void {
    const mode = this.mode.peek();
    const anchor = this.anchor.peek();
    writeQueryParams(
      mode === 'week'
        ? { view: 'week', week: startOfWeek(anchor), month: null }
        : { view: null, week: null, month: monthOf(anchor) },
    );
  }

  private setAnchor(day: string): void {
    this.anchor.set(day);
    this.writeUrl();
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode.peek()) return;
    // Keep the focused day in view across the switch.
    const inView = this.shownWeeks.length > 0 && this.inShownRange(this.focusDay);
    this.mode.set(mode);
    this.setAnchor(inView ? this.focusDay : this.anchor.peek());
  }

  /** Previous / next month (or week). */
  private step(n: number): void {
    const anchor = this.anchor.peek();
    if (this.mode.peek() === 'week') {
      const day = addDays(anchor, 7 * n);
      this.focusDay = addDays(this.focusDay, 7 * n);
      this.setAnchor(day);
      return;
    }
    const ym = addMonths(monthOf(anchor), n);
    this.focusDay = `${ym}-01`;
    this.setAnchor(`${ym}-01`);
  }

  private goToday(): void {
    const t = todayIso();
    this.focusDay = t;
    this.setAnchor(t);
  }

  private inShownRange(day: string): boolean {
    const first = this.shownWeeks[0];
    const last = this.shownWeeks[this.shownWeeks.length - 1];
    if (first === undefined || last === undefined) return false;
    return day >= first && day <= addDays(last, 6);
  }

  private moveFocus(days: number): void {
    this.focusVisible = true;
    const next = addDays(this.focusDay, days);
    this.focusDay = next;
    // In month view, a day outside the month turns the page to it.
    const leaves = this.mode.peek() === 'month' ? monthOf(next) !== monthOf(this.anchor.peek()) : !this.inShownRange(next);
    if (leaves) this.setAnchor(next);
    else this.paintFocus();
  }

  private openFocusedDay(): void {
    const sunday = startOfWeek(this.focusDay);
    const laid = this.laidByWeek.get(sunday);
    if (laid === undefined) return;
    const key = keysOnDay(laid, daysBetween(sunday, this.focusDay))[0];
    const row = key !== undefined ? this.rowsById.get(key) : undefined;
    if (row !== undefined) this.openTask(row.id);
  }

  private paintFocus(): void {
    for (const [day, el] of this.dayEls) {
      el.classList.toggle('cal-day--focus', this.focusVisible && day === this.focusDay);
      el.setAttribute('aria-selected', day === this.focusDay ? 'true' : 'false');
    }
  }

  /* -------------------------------- draw -------------------------------- */

  private draw(mode: Mode, anchor: string, tasks: readonly CardWithAttrs[]): void {
    this.closeMore();
    const today = todayIso();
    const ym = monthOf(anchor);
    const weeks = mode === 'month' ? monthGridWeeks(ym) : [startOfWeek(anchor)];
    const refYear = Number(today.slice(0, 4));
    const first = weeks[0] ?? startOfWeek(anchor);
    this.titleEl.textContent = mode === 'month' ? monthTitle(ym) : formatRange(first, addDays(first, 6), refYear);
    this.monthBtn.setAttribute('aria-pressed', mode === 'month' ? 'true' : 'false');
    this.weekBtn.setAttribute('aria-pressed', mode === 'week' ? 'true' : 'false');
    this.gridEl.classList.toggle('cal--week', mode === 'week');

    this.rowsById.clear();
    this.placements.clear();
    const items: WeekItem[] = [];
    for (const row of tasks) {
      const p = placementOf(datesOf(row.attributes));
      if (p.kind === 'unscheduled') continue;
      const key = row.id.toString();
      this.rowsById.set(key, row);
      this.placements.set(key, p);
      items.push({ key, start: p.start, end: p.end });
    }
    const milestonesByDay = new Map<string, string[]>();
    for (const m of this.lookup('milestones')) {
      if (m.due === undefined) continue;
      const list = milestonesByDay.get(m.due) ?? [];
      list.push(m.label);
      milestonesByDay.set(m.due, list);
    }

    const maxLanes = mode === 'month' ? MONTH_LANES : WEEK_LANES;
    this.shownWeeks = weeks;
    this.weekEls = [];
    this.dayEls.clear();
    this.laidByWeek.clear();
    const weekEls = weeks.map((sunday) => {
      const laid = layoutWeek(items, sunday);
      this.laidByWeek.set(sunday, laid);
      const el = this.weekEl(sunday, laid, mode, ym, today, maxLanes, milestonesByDay);
      this.weekEls.push(el);
      return el;
    });
    this.weeksEl.replaceChildren(...weekEls);
    this.paintFocus();
  }

  private weekEl(
    sunday: string,
    laid: readonly LaidItem[],
    mode: Mode,
    ym: string,
    today: string,
    maxLanes: number,
    milestonesByDay: ReadonlyMap<string, string[]>,
  ): HTMLElement {
    const week = document.createElement('div');
    week.className = 'cal-week';
    week.dataset.calWeek = sunday;
    week.setAttribute('role', 'row');
    const laneCount = laid.reduce((n, it) => Math.max(n, it.lane + 1), 0);
    // Month rows all keep the same lane count so the grid stays even.
    const lanes = mode === 'month' ? maxLanes : Math.max(1, Math.min(laneCount, maxLanes));
    const hidden = hiddenPerDay(laid, maxLanes);
    week.style.gridTemplateRows = `var(--cal-head-h) repeat(${lanes}, var(--cal-lane-h)) auto`;

    weekDays(sunday).forEach((day, col) => {
      const cell = document.createElement('div');
      cell.className = 'cal-day';
      cell.dataset.day = day;
      cell.setAttribute('role', 'gridcell');
      cell.style.gridColumn = String(col + 1);
      cell.style.gridRow = '1 / -1';
      if (day === today) cell.classList.add('cal-day--today');
      if (mode === 'month' && monthOf(day) !== ym) cell.classList.add('cal-day--outside');
      if (isWeekend(day)) cell.classList.add('cal-day--weekend');
      const head = document.createElement('div');
      head.className = 'cal-day__head';
      const num = document.createElement('span');
      num.className = 'cal-day__num';
      const d = Number(day.slice(8, 10));
      num.textContent = d === 1 || (col === 0 && mode === 'week') ? `${monthShort(Number(day.slice(5, 7)))} ${d}` : String(d);
      head.append(num);
      for (const m of milestonesByDay.get(day) ?? []) {
        const ms = document.createElement('span');
        ms.className = 'cal-day__milestone';
        ms.dataset.calMilestone = '';
        ms.title = `Milestone: ${m}`;
        ms.textContent = `◆ ${m}`;
        head.append(ms);
      }
      cell.append(head);
      week.append(cell);
      this.dayEls.set(day, cell);
    });

    for (const it of laid) {
      if (it.lane >= maxLanes) continue;
      const row = this.rowsById.get(it.key);
      const p = this.placements.get(it.key);
      if (row === undefined || p === undefined || p.kind === 'unscheduled') continue;
      week.append(this.itemEl(row, it, p, today));
    }

    hidden.forEach((n, col) => {
      if (n === 0) return;
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'cal-more';
      more.dataset.calMore = addDays(sunday, col);
      more.style.gridColumn = String(col + 1);
      more.style.gridRow = String(lanes + 2);
      more.textContent = `+${n} more`;
      week.append(more);
    });
    return week;
  }

  private itemEl(row: CardWithAttrs, it: LaidItem, p: Exclude<Placement, { kind: 'unscheduled' }>, today: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `cal-item cal-item--${p.kind}`;
    el.dataset.calItem = '';
    el.dataset.cardId = row.id.toString();
    el.style.gridColumn = `${it.col + 1} / span ${it.span}`;
    el.style.gridRow = String(it.lane + 2);
    if (it.continuesBefore) el.classList.add('cal-item--cont-before');
    if (it.continuesAfter) el.classList.add('cal-item--cont-after');
    if (p.openEnded) el.classList.add('cal-item--open');
    if (p.inverted) el.classList.add('cal-item--inverted');
    const closed = this.isClosed(row);
    if (closed) el.classList.add('cal-item--closed');
    const due = datesOf(row.attributes).due;
    if (!closed && due !== null && due < today) el.classList.add('cal-item--overdue');
    const title = taskTitle(row);
    el.title = this.tooltip(row, p);
    el.setAttribute('aria-label', el.title);
    if (!it.continuesBefore) el.append(this.statusGlyph(row));
    const label = document.createElement('span');
    label.className = 'cal-item__title';
    label.textContent = it.continuesBefore ? `… ${title}` : title;
    el.append(label);
    const link = rowLink();
    setRowLinkHref(link, row.id);
    el.append(link);
    return el;
  }

  private tooltip(row: CardWithAttrs, p: Exclude<Placement, { kind: 'unscheduled' }>): string {
    const parts = [`#${row.id.toString()} ${taskTitle(row)}`];
    if (p.kind === 'span') parts.push(formatRange(p.start, p.end));
    else if (p.openEnded) parts.push(`starts ${formatDay(p.start)}, no due date`);
    else parts.push(`due ${formatDay(p.start)}`);
    const status = this.statusOf(row)?.label;
    if (status) parts.push(status);
    const who = this.labelIn('persons', row.attributes['assignee']);
    if (who) parts.push(who);
    return parts.join(' · ');
  }

  /* ------------------------------ pointer ------------------------------- */

  protected dayAt(x: number, y: number): string | null {
    for (let i = 0; i < this.weekEls.length; i++) {
      const r = this.weekEls[i]!.getBoundingClientRect?.();
      if (r === undefined || y < r.top || y > r.bottom || x < r.left || x > r.right || r.width <= 0) continue;
      const col = Math.min(6, Math.max(0, Math.floor(((x - r.left) / r.width) * 7)));
      const sunday = this.shownWeeks[i];
      return sunday !== undefined ? addDays(sunday, col) : null;
    }
    return null;
  }

  protected previewDrop(row: CardWithAttrs | null, drag: DragResult | null): void {
    let from = '';
    let to = '';
    if (row !== null && drag !== null) {
      const next = this.planFor(row, drag)?.next;
      const p = next !== undefined ? placementOf(next) : placementOf(datesOf(row.attributes));
      if (p.kind !== 'unscheduled') {
        from = p.start;
        to = p.end;
      }
    }
    for (const [day, el] of this.dayEls) el.classList.toggle('cal-day--target', from !== '' && day >= from && day <= to);
  }

  private onPress(ev: PointerEvent): void {
    const item = (ev.target as Element | null)?.closest?.('[data-cal-item]') as HTMLElement | null | undefined;
    if (item === null || item === undefined) return;
    const row = this.rowsById.get(item.dataset.cardId ?? '');
    const origin = this.dayAt(ev.clientX, ev.clientY);
    if (row === undefined || origin === null) return;
    const moveTo = (day: string): DragResult => ({ kind: 'move', days: daysBetween(origin, day) });
    startDayDrag({
      event: ev,
      source: item,
      dayAt: (x, y) => this.dayAt(x, y),
      describe: (day) => this.describeLanding(row, moveTo(day)),
      onStart: () => item.classList.add('cal-item--dragging'),
      onHover: (day) => this.previewDrop(day === null ? null : row, day === null ? null : moveTo(day)),
      onDrop: (day) => {
        item.classList.remove('cal-item--dragging');
        this.previewDrop(null, null);
        this.reschedule(row, moveTo(day));
      },
      onCancel: () => {
        item.classList.remove('cal-item--dragging');
        this.previewDrop(null, null);
      },
    });
  }

  private onClick(ev: MouseEvent): void {
    const target = ev.target as Element | null;
    const more = target?.closest?.('[data-cal-more]') as HTMLElement | null | undefined;
    if (more) {
      this.openMore(more.dataset.calMore ?? '', more);
      return;
    }
    const item = target?.closest?.('[data-cal-item]') as HTMLElement | null | undefined;
    if (item) {
      const row = this.rowsById.get(item.dataset.cardId ?? '');
      if (row !== undefined) this.openTask(row.id);
      return;
    }
    const day = (target?.closest?.('[data-day]') as HTMLElement | null | undefined)?.dataset.day;
    if (day !== undefined) {
      this.focusDay = day;
      this.focusVisible = false;
      this.paintFocus();
      this.gridEl.focus?.();
    }
  }

  /** The day's full list, under its "+N more". */
  private openMore(day: string, anchor: HTMLElement): void {
    this.closeMore();
    const sunday = startOfWeek(day);
    const laid = this.laidByWeek.get(sunday);
    if (laid === undefined) return;
    const panel = document.createElement('div');
    panel.className = 'cal-day-pop';
    panel.dataset.calDayPop = day;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', formatDay(day));
    const head = document.createElement('div');
    head.className = 'cal-day-pop__head';
    head.textContent = formatDay(day);
    panel.append(head);
    for (const key of keysOnDay(laid, daysBetween(sunday, day))) {
      const row = this.rowsById.get(key);
      const p = this.placements.get(key);
      if (row === undefined || p === undefined || p.kind === 'unscheduled') continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day-pop__row';
      btn.append(this.statusGlyph(row));
      const t = document.createElement('span');
      t.className = 'cal-day-pop__title';
      t.textContent = taskTitle(row);
      const when = document.createElement('span');
      when.className = 'cal-day-pop__when muted';
      when.textContent = p.kind === 'span' ? formatRange(p.start, p.end) : p.openEnded ? 'start' : 'due';
      btn.append(t, when);
      btn.addEventListener('click', () => {
        this.closeMore();
        this.openTask(row.id);
      });
      panel.append(btn);
    }
    const host = this.el.getBoundingClientRect?.();
    const at = anchor.getBoundingClientRect?.();
    if (host !== undefined && at !== undefined) {
      panel.style.left = `${Math.max(0, at.left - host.left - 8)}px`;
      panel.style.top = `${at.bottom - host.top + 4}px`;
    }
    this.el.append(panel);
    this.moreEl = panel;
    const onKey = (ev: Event): void => {
      if ((ev as KeyboardEvent).key === 'Escape') this.closeMore();
    };
    panel.addEventListener('keydown', onKey);
    (panel.querySelector('button') as HTMLElement | null)?.focus?.();
  }

  private closeMore(): void {
    this.moreEl?.remove();
    this.moreEl = null;
  }

  /** Task detail steps through the tasks by date, like the grid shows them. */
  protected override navOrder(): bigint[] {
    return [...this.tasks()]
      .map((t) => ({ id: t.id, p: placementOf(datesOf(t.attributes)) }))
      .filter((x) => x.p.kind !== 'unscheduled')
      .sort((a, b) => {
        const as = a.p.kind === 'unscheduled' ? '' : a.p.start;
        const bs = b.p.kind === 'unscheduled' ? '' : b.p.start;
        return as < bs ? -1 : as > bs ? 1 : 0;
      })
      .map((x) => x.id);
  }
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

function segButton(label: string, data: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'schedule__segbtn';
  b.dataset[data] = '';
  b.textContent = label;
  return b;
}

export function registerCalendar(): void {
  Control.register('Calendar', Calendar);
}

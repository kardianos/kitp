/**
 * The Timeline's geometry and row model (docs/TIMELINE_AND_CALENDAR.md). Pure:
 * the control draws what these return.
 *
 *   - the AXIS covers every drawn task with a margin, and always a window
 *     around today; it starts on a Sunday so weeks line up;
 *   - ZOOM sets a day's width (Week / Month / Quarter);
 *   - ROWS are one per task, grouped into BANDS by the screen's GROUP axis:
 *     bands in the axis's own order (a date first — milestones by their date —
 *     then the value-card's sort order, then the label), `(unset)` last; tasks
 *     in a band by start, then end, then title. A collapsed band keeps its
 *     header row and drops its tasks.
 */

import { addDays, daysBetween, startOfWeek } from '../schedule/dates.js';
import type { Placement } from '../schedule/placement.js';

export type Zoom = 'week' | 'month' | 'quarter';

/** A day's width (px) at each zoom. */
export const DAY_WIDTH: Readonly<Record<Zoom, number>> = { week: 44, month: 18, quarter: 6 };

export function parseZoom(v: unknown): Zoom | null {
  return v === 'week' || v === 'month' || v === 'quarter' ? v : null;
}

/** Days the axis keeps around today, and past the first / last task. */
const BEFORE_TODAY = 35;
const AFTER_TODAY = 150;
const MARGIN_BEFORE = 14;
const MARGIN_AFTER = 45;

export interface AxisRange {
  /** First day (a Sunday). */
  start: string;
  /** Number of days drawn. */
  days: number;
}

/** The axis for these drawn placements. */
export function axisRange(placements: ReadonlyArray<{ start: string; end: string }>, today: string): AxisRange {
  let lo = addDays(today, -BEFORE_TODAY);
  let hi = addDays(today, AFTER_TODAY);
  for (const p of placements) {
    const s = addDays(p.start, -MARGIN_BEFORE);
    const e = addDays(p.end, MARGIN_AFTER);
    if (s < lo) lo = s;
    if (e > hi) hi = e;
  }
  const start = startOfWeek(lo);
  return { start, days: daysBetween(start, hi) + 1 };
}

/** The left edge (px) of a day on the axis. */
export function xOfDay(axisStart: string, day: string, dayWidth: number): number {
  return daysBetween(axisStart, day) * dayWidth;
}

/** The day at an x (px) on the axis. */
export function dayOfX(axisStart: string, x: number, dayWidth: number): string {
  return addDays(axisStart, Math.floor(x / dayWidth));
}

/** A band as the axis knows it. */
export interface BandInfo {
  key: string;
  label: string;
  /** A date that orders it first (a milestone's due date). */
  date?: string;
  /** The value-card's sort order (+Infinity when it has none). */
  sortOrder: number;
}

/** The key of the band for tasks with no value. */
export const UNSET_BAND = '__unset__';

export function compareBands(a: BandInfo, b: BandInfo): number {
  if (a.key === UNSET_BAND || b.key === UNSET_BAND) return a.key === b.key ? 0 : a.key === UNSET_BAND ? 1 : -1;
  if (a.date !== b.date) {
    if (a.date === undefined) return 1;
    if (b.date === undefined) return -1;
    return a.date < b.date ? -1 : 1;
  }
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.label.localeCompare(b.label);
}

/** One drawn task. */
export interface TimelineTask<R> {
  row: R;
  id: string;
  title: string;
  placement: Exclude<Placement, { kind: 'unscheduled' }>;
}

export function compareTasks<R>(a: TimelineTask<R>, b: TimelineTask<R>): number {
  const pa = a.placement;
  const pb = b.placement;
  if (pa.start !== pb.start) return pa.start < pb.start ? -1 : 1;
  if (pa.end !== pb.end) return pa.end < pb.end ? -1 : 1;
  const t = a.title.localeCompare(b.title);
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type TimelineItem<R> =
  | {
      kind: 'band';
      band: BandInfo;
      count: number;
      collapsed: boolean;
      /** The band's tasks' extent (a faint summary bar). */
      extent: { start: string; end: string } | null;
    }
  | ({ kind: 'task'; band: string | null } & TimelineTask<R>);

/**
 * The rows the timeline lists. `bandOf` returns a task's band (null when the
 * screen has no GROUP); `bandInfo` describes a band key.
 */
export function timelineItems<R>(
  tasks: ReadonlyArray<TimelineTask<R>>,
  bandOf: ((t: TimelineTask<R>) => string) | null,
  bandInfo: (key: string) => BandInfo,
  collapsed: ReadonlySet<string>,
): TimelineItem<R>[] {
  const sorted = [...tasks].sort(compareTasks);
  if (bandOf === null) return sorted.map((t) => ({ kind: 'task', band: null, ...t }));
  const byBand = new Map<string, TimelineTask<R>[]>();
  for (const t of sorted) {
    const key = bandOf(t);
    const list = byBand.get(key);
    if (list) list.push(t);
    else byBand.set(key, [t]);
  }
  const bands = [...byBand.keys()].map(bandInfo).sort(compareBands);
  const out: TimelineItem<R>[] = [];
  for (const band of bands) {
    const list = byBand.get(band.key) ?? [];
    let lo: string | null = null;
    let hi: string | null = null;
    for (const t of list) {
      if (lo === null || t.placement.start < lo) lo = t.placement.start;
      if (hi === null || t.placement.end > hi) hi = t.placement.end;
    }
    const isCollapsed = collapsed.has(band.key);
    out.push({
      kind: 'band',
      band,
      count: list.length,
      collapsed: isCollapsed,
      extent: lo !== null && hi !== null ? { start: lo, end: hi } : null,
    });
    if (!isCollapsed) for (const t of list) out.push({ kind: 'task', band: band.key, ...t });
  }
  return out;
}

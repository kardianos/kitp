/**
 * Where a task draws on a Calendar or Timeline (docs/TIMELINE_AND_CALENDAR.md
 * T2), from its `start_date` / `due_date`:
 *
 *   start + due → a SPAN from start to due (one day when they're equal);
 *   due only    → a POINT on the due day;
 *   start only  → a POINT on the start day, marked open-ended (no due date);
 *   neither     → UNSCHEDULED (the views' tray lists it).
 *
 * The server never stores a start after its due date (T8); a pair that is
 * inverted anyway (data from before the rule) draws as a span over the two
 * days, flagged, rather than vanishing. Pure: no DOM.
 */

import { isoDateOf } from './dates.js';

export const START_ATTR = 'start_date';
export const DUE_ATTR = 'due_date';

export type Placement =
  | {
      kind: 'span' | 'point';
      /** First day drawn (ISO). */
      start: string;
      /** Last day drawn (ISO), inclusive; equals start for a point. */
      end: string;
      /** A point from a start date with no due date. */
      openEnded: boolean;
      /** The stored pair is start-after-due (drawn over both days anyway). */
      inverted: boolean;
    }
  | { kind: 'unscheduled' };

/** The two stored dates of a task (null when unset or not a real day). */
export interface TaskDates {
  start: string | null;
  due: string | null;
}

export function datesOf(attributes: Readonly<Record<string, unknown>>): TaskDates {
  return { start: isoDateOf(attributes[START_ATTR]), due: isoDateOf(attributes[DUE_ATTR]) };
}

export function placementOf(dates: TaskDates): Placement {
  const { start, due } = dates;
  if (start !== null && due !== null) {
    const inverted = start > due;
    return {
      kind: 'span',
      start: inverted ? due : start,
      end: inverted ? start : due,
      openEnded: false,
      inverted,
    };
  }
  if (due !== null) return { kind: 'point', start: due, end: due, openEnded: false, inverted: false };
  if (start !== null) return { kind: 'point', start, end: start, openEnded: true, inverted: false };
  return { kind: 'unscheduled' };
}

/** Does a drawn placement touch the inclusive day range [from, to]? */
export function touches(p: Placement, from: string, to: string): boolean {
  if (p.kind === 'unscheduled') return false;
  return p.start <= to && p.end >= from;
}

/** Whether a task has a date the views draw (anything but unscheduled). */
export function isScheduled(dates: TaskDates): boolean {
  return dates.start !== null || dates.due !== null;
}

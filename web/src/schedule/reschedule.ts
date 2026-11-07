/**
 * A drag on the Calendar or Timeline → the date writes it makes
 * (docs/TIMELINE_AND_CALENDAR.md T3, T4, T8). Whole days only:
 *
 *   move        — both dates shift by the same number of days (the length is
 *                 kept); a point moves its one date;
 *   resizeStart — the start moves (the timeline's left handle), never past
 *                 the due date;
 *   resizeEnd   — the due date moves (the right handle), never before the
 *                 start;
 *   drop        — a task from the Unscheduled tray lands on a day: that day
 *                 becomes its due date.
 *
 * The server refuses any write that leaves a start after its due date (T8),
 * one statement at a time, so a move ORDERS its two writes to keep the pair
 * valid on the way through: moving later writes the due date first, moving
 * earlier writes the start first. Pure: the views turn a plan into
 * `attribute.update` intents (schedule-data.ts).
 */

import { addDays } from './dates.js';
import { DUE_ATTR, START_ATTR, type TaskDates } from './placement.js';

export type DragResult =
  | { kind: 'move'; days: number }
  | { kind: 'resizeStart'; day: string }
  | { kind: 'resizeEnd'; day: string }
  | { kind: 'drop'; day: string };

export interface DateWrite {
  attr: typeof START_ATTR | typeof DUE_ATTR;
  /** ISO day; null clears the date. */
  value: string | null;
}

export interface ReschedulePlan {
  /** The writes, in the order they must reach the server. */
  writes: DateWrite[];
  /** The task's dates once every write lands (the optimistic patch). */
  next: TaskDates;
}

/** Plan the writes for a drag, or null when it changes nothing. */
export function planReschedule(cur: TaskDates, drag: DragResult): ReschedulePlan | null {
  switch (drag.kind) {
    case 'move': {
      if (drag.days === 0 || (cur.start === null && cur.due === null)) return null;
      const next: TaskDates = {
        start: cur.start !== null ? addDays(cur.start, drag.days) : null,
        due: cur.due !== null ? addDays(cur.due, drag.days) : null,
      };
      const start: DateWrite[] = next.start !== null ? [{ attr: START_ATTR, value: next.start }] : [];
      const due: DateWrite[] = next.due !== null ? [{ attr: DUE_ATTR, value: next.due }] : [];
      // Later: the due date moves out of the way first. Earlier: the start does.
      const writes = drag.days > 0 ? [...due, ...start] : [...start, ...due];
      return { writes, next };
    }
    case 'resizeStart': {
      if (cur.start === null) return null;
      const day = cur.due !== null && drag.day > cur.due ? cur.due : drag.day;
      if (day === cur.start) return null;
      return { writes: [{ attr: START_ATTR, value: day }], next: { start: day, due: cur.due } };
    }
    case 'resizeEnd': {
      if (cur.due === null) return null;
      const day = cur.start !== null && drag.day < cur.start ? cur.start : drag.day;
      if (day === cur.due) return null;
      return { writes: [{ attr: DUE_ATTR, value: day }], next: { start: cur.start, due: day } };
    }
    case 'drop': {
      // A start already set can't be after the new due date: land on it.
      const day = cur.start !== null && drag.day < cur.start ? cur.start : drag.day;
      if (day === cur.due) return null;
      return { writes: [{ attr: DUE_ATTR, value: day }], next: { start: cur.start, due: day } };
    }
  }
}

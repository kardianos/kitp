/**
 * The Calendar's week layout (docs/TIMELINE_AND_CALENDAR.md): every task
 * drawn in a week takes a LANE — a row under the day numbers — across the
 * days it covers there. Lanes are filled greedily, longest first (so long
 * spans stay straight, then shorter ones and single days pack the gaps),
 * ties by start then id, so a week lays out the same way on every draw.
 * A week shows a few lanes; what doesn't fit counts into its days' "+N more".
 * Pure: no DOM.
 */

import { addDays, daysBetween } from '../schedule/dates.js';

export interface WeekItem {
  /** A stable key (the task id). */
  key: string;
  /** First and last day drawn (ISO, inclusive) — may reach outside the week. */
  start: string;
  end: string;
}

export interface LaidItem {
  key: string;
  /** 0-based lane (row) within the week. */
  lane: number;
  /** 0 = Sunday … 6 = Saturday, the first day drawn in this week. */
  col: number;
  /** Days drawn in this week (1–7). */
  span: number;
  /** The item started before this week / runs on after it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Lay out the items that touch the week starting `sunday`. */
export function layoutWeek(items: readonly WeekItem[], sunday: string): LaidItem[] {
  const saturday = addDays(sunday, 6);
  const clipped = items
    .filter((it) => it.start <= saturday && it.end >= sunday)
    .map((it) => {
      const s = it.start < sunday ? sunday : it.start;
      const e = it.end > saturday ? saturday : it.end;
      const col = daysBetween(sunday, s);
      return {
        key: it.key,
        col,
        span: daysBetween(s, e) + 1,
        continuesBefore: it.start < sunday,
        continuesAfter: it.end > saturday,
        fullLength: daysBetween(it.start, it.end) + 1,
        start: it.start,
      };
    });
  clipped.sort((a, b) => {
    if (a.span !== b.span) return b.span - a.span;
    if (a.fullLength !== b.fullLength) return b.fullLength - a.fullLength;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const lanes: boolean[][] = [];
  const out: LaidItem[] = [];
  for (const c of clipped) {
    let lane = 0;
    for (; ; lane++) {
      const occ = lanes[lane] ?? (lanes[lane] = [false, false, false, false, false, false, false]);
      let free = true;
      for (let d = c.col; d < c.col + c.span; d++) {
        if (occ[d]) {
          free = false;
          break;
        }
      }
      if (free) {
        for (let d = c.col; d < c.col + c.span; d++) occ[d] = true;
        break;
      }
    }
    out.push({
      key: c.key,
      lane,
      col: c.col,
      span: c.span,
      continuesBefore: c.continuesBefore,
      continuesAfter: c.continuesAfter,
    });
  }
  return out;
}

/** Per day of the week, how many laid items sit in lanes ≥ `maxLanes` (hidden). */
export function hiddenPerDay(laid: readonly LaidItem[], maxLanes: number): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const it of laid) {
    if (it.lane < maxLanes) continue;
    for (let d = it.col; d < it.col + it.span; d++) counts[d] = (counts[d] ?? 0) + 1;
  }
  return counts;
}

/** The keys of the items drawn on one day (col), in lane order. */
export function keysOnDay(laid: readonly LaidItem[], col: number): string[] {
  return laid
    .filter((it) => it.col <= col && it.col + it.span > col)
    .sort((a, b) => a.lane - b.lane)
    .map((it) => it.key);
}

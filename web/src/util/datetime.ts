/**
 * Timestamp display: an ISO-style date + time in the VIEWER'S local zone.
 *
 * `YYYY-MM-DD HH:MM` (e.g. "2026-10-21 14:03") — sortable and unambiguous
 * across locales, unlike `toLocaleString`, while still reading in local time.
 * Used where an exact moment matters (comments, comm messages, links); the
 * activity feed keeps its compact relative form ("2h ago").
 */

import { formatRelativeTime } from '../task-detail/activity-text.js';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD HH:MM` in local time; the raw string when it doesn't parse. */
export function formatLocalDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/** The local zone's UTC offset as `UTC±HH:MM` for the given moment. */
export function formatUtcOffset(d: Date): string {
  const mins = -d.getTimezoneOffset();
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * A `<time>` element showing {@link formatLocalDateTime}, with the machine
 * timestamp in `datetime` and a tooltip carrying seconds, the zone offset and
 * the relative age ("2026-10-21 14:03:09 UTC-07:00 · 2h ago").
 */
export function localTimeEl(iso: string, className: string, now: number = Date.now()): HTMLTimeElement {
  const el = document.createElement('time');
  el.className = className;
  el.textContent = formatLocalDateTime(iso);
  const t = Date.parse(iso);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    el.dateTime = d.toISOString();
    el.title = `${formatLocalDateTime(iso)}:${pad2(d.getSeconds())} ${formatUtcOffset(d)} · ${formatRelativeTime(iso, now)}`;
  }
  return el;
}

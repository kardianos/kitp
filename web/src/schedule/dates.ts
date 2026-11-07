/**
 * Whole-day date math for the Calendar and Timeline layouts
 * (docs/TIMELINE_AND_CALENDAR.md). Every date is an ISO `YYYY-MM-DD` string —
 * what the server stores for `start_date` / `due_date` — and every step goes
 * through a LOCAL-midnight `Date`, like the DatePicker, so a round trip is
 * stable in any timezone (no UTC drift across a DST change). Weeks start on
 * Sunday, as the DatePicker's do. Pure: no DOM, no tree.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ISO `YYYY-MM-DD` → local-midnight Date, or null when it isn't a real day. */
export function parseIsoDate(s: unknown): Date | null {
  if (typeof s !== 'string') return null;
  const m = ISO_RE.exec(s);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const out = new Date(y, mo, d);
  // Reject rollovers ("2026-02-30" → Mar 2): a stored date is always real.
  if (out.getFullYear() !== y || out.getMonth() !== mo || out.getDate() !== d) return null;
  return out;
}

/** A value that is a real ISO day, else null — how a view reads a date attribute. */
export function isoDateOf(v: unknown): string | null {
  return parseIsoDate(v) !== null ? (v as string) : null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Date → its local calendar day as ISO `YYYY-MM-DD`. */
export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Today in the viewer's zone. `now` is injectable for tests. */
export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now);
}

/** `iso` moved by `n` days (negative = earlier). */
export function addDays(iso: string, n: number): string {
  const d = parseIsoDate(iso);
  if (d === null) return iso;
  return toIsoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Whole days from `a` to `b` (b − a): 0 for the same day, negative when b is earlier. */
export function daysBetween(a: string, b: string): number {
  const da = parseIsoDate(a);
  const db = parseIsoDate(b);
  if (da === null || db === null) return 0;
  // Date.UTC on the calendar fields counts days without the local DST hour.
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(iso: string): number {
  return parseIsoDate(iso)?.getDay() ?? 0;
}

export function isWeekend(iso: string): boolean {
  const w = weekdayOf(iso);
  return w === 0 || w === 6;
}

/** The Sunday on or before `iso`. */
export function startOfWeek(iso: string): string {
  return addDays(iso, -weekdayOf(iso));
}

/** `YYYY-MM` of a day. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** A `YYYY-MM` value, or null. */
export function parseMonth(s: unknown): string | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}$/.test(s)) return null;
  return parseIsoDate(`${s}-01`) !== null ? s : null;
}

/** First day of the month `ym` (`YYYY-MM`). */
export function firstOfMonth(ym: string): string {
  return `${ym}-01`;
}

/** Last day of the month `ym`. */
export function lastOfMonth(ym: string): string {
  const d = parseIsoDate(`${ym}-01`);
  if (d === null) return `${ym}-28`;
  return toIsoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/** The month `n` months from `ym`. */
export function addMonths(ym: string, n: number): string {
  const d = parseIsoDate(`${ym}-01`);
  if (d === null) return ym;
  return toIsoDate(new Date(d.getFullYear(), d.getMonth() + n, 1)).slice(0, 7);
}

/**
 * The six Sunday-start weeks a month grid shows: the first starts on the
 * Sunday on or before the 1st. Six rows always, so the grid never changes
 * height between months.
 */
export function monthGridWeeks(ym: string): string[] {
  const first = startOfWeek(firstOfMonth(ym));
  return [0, 1, 2, 3, 4, 5].map((w) => addDays(first, w * 7));
}

/** The seven days of the week starting `sunday`. */
export function weekDays(sunday: string): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => addDays(sunday, d));
}

/** Clamp `iso` into [lo, hi] (ISO strings order as dates). */
export function clampIso(iso: string, lo: string, hi: string): string {
  if (iso < lo) return lo;
  if (iso > hi) return hi;
  return iso;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "November 2026". Fixed English names, like the DatePicker's header. */
export function monthTitle(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return `${MONTHS[m - 1] ?? ym} ${ym.slice(0, 4)}`;
}

/** "Nov" for a month number 1–12. */
export function monthShort(month: number): string {
  return MONTHS_SHORT[month - 1] ?? '';
}

/** Short weekday names, Sunday first ("Sun" … "Sat"). */
export function weekdayNames(): readonly string[] {
  return WEEKDAYS_SHORT;
}

/** "Tue Nov 18" — the drag tooltip's day. */
export function formatDay(iso: string): string {
  const d = parseIsoDate(iso);
  if (d === null) return iso;
  return `${WEEKDAYS_SHORT[d.getDay()]} ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/** "Nov 18" (and the year when it isn't `refYear`). */
export function formatShortDay(iso: string, refYear?: number): string {
  const d = parseIsoDate(iso);
  if (d === null) return iso;
  const base = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  return refYear !== undefined && d.getFullYear() !== refYear ? `${base}, ${d.getFullYear()}` : base;
}

/** "Nov 10 – Nov 13", "Nov 18" for one day. */
export function formatRange(start: string, end: string, refYear?: number): string {
  if (start === end) return formatShortDay(start, refYear);
  return `${formatShortDay(start, refYear)} – ${formatShortDay(end, refYear)}`;
}

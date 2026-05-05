/**
 * Tiny dependency-free relative-time formatter shared by the activity
 * stream and any other UI surface that wants to render a created_at
 * timestamp humanely.
 *
 * No locale handling beyond English; we deliberately do not pull in
 * date-fns / Intl.RelativeTimeFormat (the latter would work but isn't
 * needed at the granularity we use). The thresholds match the rough
 * UX-convention of GitHub / Linear.
 */

/** Parse an ISO-8601 timestamp; returns NaN on bad input. */
function parseIso(iso: string): number {
  const ms = Date.parse(iso);
  return ms;
}

/**
 * Format a delta into a human "x ago" string. Returns:
 *   < 60s        → "just now"
 *   < 60m        → "N minute(s) ago"
 *   < 24h        → "N hour(s) ago"
 *   < 7d         → "N day(s) ago"
 *   < 30d        → "N week(s) ago"
 *   < 365d       → "N month(s) ago"
 *   else         → "N year(s) ago"
 *
 * Negative deltas (timestamps in the future, e.g. clock skew) are clamped
 * to "just now".
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const t = parseIso(iso);
  if (!Number.isFinite(t)) return iso;

  const deltaMs = now.getTime() - t;
  if (deltaMs < 0) return 'just now';

  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return 'just now';

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} ${pluralize(min, 'minute')} ago`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${pluralize(hr, 'hour')} ago`;

  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} ${pluralize(day, 'day')} ago`;

  const week = Math.floor(day / 7);
  if (day < 30) return `${week} ${pluralize(week, 'week')} ago`;

  const month = Math.floor(day / 30);
  if (day < 365) return `${month} ${pluralize(month, 'month')} ago`;

  const year = Math.floor(day / 365);
  return `${year} ${pluralize(year, 'year')} ago`;
}

function pluralize(n: number, unit: string): string {
  return n === 1 ? unit : `${unit}s`;
}

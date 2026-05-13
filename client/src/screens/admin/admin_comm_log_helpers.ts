/**
 * Pure helpers for `AdminCommLogScreen`. Extracted as a TypeScript module
 * so the per-kind detail renderers + time-window mapping can be unit-tested
 * without a Svelte mount runtime (vitest is node-only).
 *
 * Spec: email_comm_spec.md §"Comm log admin area" (L188).
 *
 *   - `TIME_WINDOWS` enumerates the four preset windows the screen
 *     surfaces (1h / 24h / 7d / custom). The first three map to an ISO
 *     `since` timestamp at fetch time; "custom" feeds a free-form input.
 *   - `windowSince` converts a window key + a reference timestamp into
 *     the ISO `since` value the server expects.
 *   - `renderCommLogDetail` formats the per-kind detail jsonb into the
 *     human-readable text shown on each row. The eight kinds in
 *     COMM_LOG_KINDS each get a renderer; unknown kinds fall back to
 *     JSON.stringify so the GUI never blank-renders.
 *   - `filterKindList` filters the kinds chip-bar to a sensible
 *     authoring order: poll / send_* first (the noisy ones), then the
 *     error kinds, then the rare ones.
 */

import type { CommLogKind, CommLogRow } from '../../reg/types.js';

/** The four time-window presets surfaced on the screen. */
export type TimeWindowKey = '1h' | '24h' | '7d' | 'custom';

/** Display labels mirrored by the chip group. */
export const TIME_WINDOWS: ReadonlyArray<{ key: TimeWindowKey; label: string }> = [
  { key: '1h', label: '1 hour' },
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: 'custom', label: 'Custom' },
] as const;

/** Default window: spec says "defaults to last 24 hours" (L191). */
export const DEFAULT_TIME_WINDOW: TimeWindowKey = '24h';

/**
 * Convert a window key + a reference timestamp into the ISO `since`
 * value the server expects. For `'custom'` the caller supplies the
 * custom override; this helper returns the empty string so the call
 * site can pass through the operator's typed timestamp verbatim.
 *
 * Returning the empty string for `custom` (rather than `null`) keeps
 * the dispatcher input shape stable: the encoder omits empty strings,
 * matching the server's "no since => 24h default" branch.
 */
export function windowSince(
  key: TimeWindowKey,
  now: Date,
  custom?: string,
): string {
  if (key === 'custom') return custom ?? '';
  const ms = now.getTime();
  if (key === '1h') return new Date(ms - 60 * 60 * 1000).toISOString();
  if (key === '24h') return new Date(ms - 24 * 60 * 60 * 1000).toISOString();
  if (key === '7d') return new Date(ms - 7 * 24 * 60 * 60 * 1000).toISOString();
  return '';
}

/* -------------------------------------------------------------------------- */
/* Per-kind detail renderers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Render a comm_log row's detail jsonb into a single human-readable line.
 * Mirrors the spec's per-kind affordances (L194):
 *
 *   - poll:                 "Polled <N> messages"
 *   - send_ok:              "Sent to <recipient>"
 *   - send_bounce:          "Bounce to <recipient>: <code> <message>"
 *   - send_fail:            "Failed: <error>"
 *   - imap_auth_fail:       "Auth failed: <error>"
 *   - parse_error:          "Parse error on <message_id>: <snippet>"
 *   - unmatched_thread:     "No thread match for <message_id> (subject: '<subject>')"
 *   - attachment_too_large: "<filename>: <size> bytes (limit <limit>)"
 *
 * Unknown kinds fall back to `JSON.stringify(detail)` so the GUI surfaces
 * something — the row is admin-only, so verbatim JSON is acceptable.
 */
export function renderCommLogDetail(kind: string, detail: unknown): string {
  const d = isObj(detail) ? detail : {};
  switch (kind) {
    case 'poll': {
      // Server may use either `count` or `messages_seen` depending on
      // which Gate (5 / 6) wrote the row. Accept both.
      const n = asNum(d.count ?? d.messages_seen ?? 0);
      return `Polled ${n} message${n === 1 ? '' : 's'}`;
    }
    case 'send_ok': {
      const r = asStr(d.recipient ?? d.to);
      return r === '' ? 'Sent' : `Sent to ${r}`;
    }
    case 'send_bounce': {
      const r = asStr(d.recipient ?? d.to);
      const code = asStr(d.code);
      const msg = asStr(d.message ?? d.error);
      const head = r === '' ? 'Bounce' : `Bounce to ${r}`;
      if (code === '' && msg === '') return head;
      const tail = [code, msg].filter((s) => s !== '').join(' ');
      return `${head}: ${tail}`;
    }
    case 'send_fail': {
      const err = asStr(d.error ?? d.message);
      return err === '' ? 'Failed' : `Failed: ${err}`;
    }
    case 'imap_auth_fail': {
      const err = asStr(d.error ?? d.message ?? d.err);
      return err === '' ? 'Auth failed' : `Auth failed: ${err}`;
    }
    case 'parse_error': {
      const mid = asStr(d.message_id);
      const snippet = asStr(d.snippet);
      const head = mid === '' ? 'Parse error' : `Parse error on ${mid}`;
      return snippet === '' ? head : `${head}: ${snippet}`;
    }
    case 'unmatched_thread': {
      const mid = asStr(d.message_id);
      const subject = asStr(d.subject);
      if (mid === '' && subject === '') return 'No thread match';
      const head = mid === '' ? 'No thread match' : `No thread match for ${mid}`;
      return subject === '' ? head : `${head} (subject: '${subject}')`;
    }
    case 'attachment_too_large': {
      const filename = asStr(d.filename);
      const size = asNum(d.size);
      const limit = asNum(d.limit);
      const head = filename === '' ? 'Attachment too large' : filename;
      const sizePart = size === 0 ? '' : `${size} bytes`;
      const limitPart = limit === 0 ? '' : `(limit ${limit})`;
      const tail = [sizePart, limitPart].filter((s) => s !== '').join(' ');
      return tail === '' ? head : `${head}: ${tail}`;
    }
    default: {
      try {
        return JSON.stringify(detail) ?? '';
      } catch {
        return String(detail);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Kinds chip-bar ordering                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Return the kinds in the order the chip-bar should display them:
 * common / noisy kinds first (poll / send_ok), then the error kinds
 * (send_bounce / send_fail / imap_auth_fail / parse_error /
 * unmatched_thread), then the rare ones (attachment_too_large). The
 * order is a UI affordance; the server-side filter accepts any
 * single kind.
 */
export const COMM_LOG_KINDS_ORDERED: readonly CommLogKind[] = [
  'poll',
  'send_ok',
  'send_bounce',
  'send_fail',
  'imap_auth_fail',
  'parse_error',
  'unmatched_thread',
  'attachment_too_large',
] as const;

/* -------------------------------------------------------------------------- */
/* Auto-refresh constants                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Auto-refresh polling interval. Spec: "Auto-refresh is opt-in (a toggle
 * in the header), default off." (L195). 10 s matches the SMTP sender's
 * tick (Gate 5) — by the time the next poll cycle lands, the previous
 * one has had time to write its log entry.
 */
export const AUTO_REFRESH_INTERVAL_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* Project filter helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Project-row shape used by the filter dropdown.
 */
export interface ProjectOption {
  value: string;
  label: string;
}

/**
 * Filter the visible comm_log rows by an in-memory kind selector.
 * Empty `kindFilter` means "any kind". The project + time-window
 * filters happen server-side (via `project_id` / `since` parameters
 * on `comm_log.list`); we only filter client-side by kind here so the
 * screen can switch kinds without a re-fetch when the underlying row
 * set hasn't otherwise changed.
 */
export function applyClientFilters(
  rows: readonly CommLogRow[],
  kindFilter: string,
): CommLogRow[] {
  if (kindFilter === '') return [...rows];
  return rows.filter((r) => r.kind === kindFilter);
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function asNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

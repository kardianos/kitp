/**
 * Comm Gate 9 unit coverage for AdminCommLogScreen + its helpers.
 *
 * vitest is node-only, so we exercise the screen via:
 *   1. Pure helpers — `renderCommLogDetail`, `windowSince`,
 *      `applyClientFilters`, the `COMM_LOG_KINDS_ORDERED` ordering, the
 *      `AUTO_REFRESH_INTERVAL_MS` constant.
 *   2. Handler codec — `commLogList` encode/decode.
 *   3. A compile-smoke import of the .svelte component.
 */

import { describe, expect, it } from 'vitest';

import { commLogList } from '../../src/reg/handlers.js';
import type { CommLogRow } from '../../src/reg/types.js';
import {
  AUTO_REFRESH_INTERVAL_MS,
  COMM_LOG_KINDS_ORDERED,
  DEFAULT_TIME_WINDOW,
  TIME_WINDOWS,
  applyClientFilters,
  renderCommLogDetail,
  windowSince,
  type TimeWindowKey,
} from '../../src/screens/admin/admin_comm_log_helpers.js';

/* -------------------------------------------------------------------------- */
/* Filter constants                                                           */
/* -------------------------------------------------------------------------- */

describe('comm_log filter constants', () => {
  it('exposes all eight kinds in display order', () => {
    expect(COMM_LOG_KINDS_ORDERED).toEqual([
      'poll',
      'send_ok',
      'send_bounce',
      'send_fail',
      'imap_auth_fail',
      'parse_error',
      'unmatched_thread',
      'attachment_too_large',
    ]);
  });

  it('exposes the four time-window presets', () => {
    expect(TIME_WINDOWS.map((w) => w.key)).toEqual(['1h', '24h', '7d', 'custom']);
  });

  it('defaults to the 24-hour window (matches spec L191)', () => {
    expect(DEFAULT_TIME_WINDOW).toBe('24h');
  });

  it('uses a 10-second auto-refresh tick (spec implies tick ~= SMTP tick)', () => {
    expect(AUTO_REFRESH_INTERVAL_MS).toBe(10_000);
  });
});

/* -------------------------------------------------------------------------- */
/* windowSince                                                                */
/* -------------------------------------------------------------------------- */

describe('windowSince', () => {
  // A fixed reference timestamp so the math is deterministic.
  const NOW = new Date('2026-05-13T12:00:00.000Z');

  it.each<{
    key: TimeWindowKey;
    expected: string;
  }>([
    { key: '1h', expected: '2026-05-13T11:00:00.000Z' },
    { key: '24h', expected: '2026-05-12T12:00:00.000Z' },
    { key: '7d', expected: '2026-05-06T12:00:00.000Z' },
  ])('subtracts $key from now', ({ key, expected }) => {
    expect(windowSince(key, NOW)).toBe(expected);
  });

  it('returns the empty string for custom windows when no override is supplied', () => {
    expect(windowSince('custom', NOW)).toBe('');
  });

  it('returns the operator-supplied custom timestamp verbatim', () => {
    expect(windowSince('custom', NOW, '2026-01-01T00:00:00Z')).toBe(
      '2026-01-01T00:00:00Z',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* renderCommLogDetail                                                        */
/* -------------------------------------------------------------------------- */

describe('renderCommLogDetail', () => {
  it.each<{
    label: string;
    kind: string;
    detail: unknown;
    expected: string;
  }>([
    {
      label: 'poll with count',
      kind: 'poll',
      detail: { count: 5 },
      expected: 'Polled 5 messages',
    },
    {
      label: 'poll with messages_seen (alt key)',
      kind: 'poll',
      detail: { messages_seen: 2 },
      expected: 'Polled 2 messages',
    },
    {
      label: 'poll singular',
      kind: 'poll',
      detail: { count: 1 },
      expected: 'Polled 1 message',
    },
    {
      label: 'poll with zero count',
      kind: 'poll',
      detail: { count: 0 },
      expected: 'Polled 0 messages',
    },
    {
      label: 'send_ok with recipient',
      kind: 'send_ok',
      detail: { recipient: 'a@example.com' },
      expected: 'Sent to a@example.com',
    },
    {
      label: 'send_ok with `to` alias',
      kind: 'send_ok',
      detail: { to: 'b@example.com' },
      expected: 'Sent to b@example.com',
    },
    {
      label: 'send_ok with no recipient',
      kind: 'send_ok',
      detail: {},
      expected: 'Sent',
    },
    {
      label: 'send_bounce with code + message',
      kind: 'send_bounce',
      detail: {
        recipient: 'a@example.com',
        code: '550',
        message: 'Mailbox unavailable',
      },
      expected: 'Bounce to a@example.com: 550 Mailbox unavailable',
    },
    {
      label: 'send_bounce with only code',
      kind: 'send_bounce',
      detail: { recipient: 'a@example.com', code: '550' },
      expected: 'Bounce to a@example.com: 550',
    },
    {
      label: 'send_fail with error',
      kind: 'send_fail',
      detail: { error: 'connection refused' },
      expected: 'Failed: connection refused',
    },
    {
      label: 'send_fail with message alias',
      kind: 'send_fail',
      detail: { message: 'EOF' },
      expected: 'Failed: EOF',
    },
    {
      label: 'imap_auth_fail with err alias (server uses `err` per Gate 3 test)',
      kind: 'imap_auth_fail',
      detail: { err: 'bad creds' },
      expected: 'Auth failed: bad creds',
    },
    {
      label: 'imap_auth_fail with error alias',
      kind: 'imap_auth_fail',
      detail: { error: 'SASL fail' },
      expected: 'Auth failed: SASL fail',
    },
    {
      label: 'parse_error with message_id + snippet',
      kind: 'parse_error',
      detail: { message_id: '<m1@x>', snippet: 'unexpected EOF' },
      expected: 'Parse error on <m1@x>: unexpected EOF',
    },
    {
      label: 'parse_error with only message_id',
      kind: 'parse_error',
      detail: { message_id: '<m1@x>' },
      expected: 'Parse error on <m1@x>',
    },
    {
      label: 'unmatched_thread with full detail',
      kind: 'unmatched_thread',
      detail: { message_id: '<m2@x>', subject: 'Hi there' },
      expected: "No thread match for <m2@x> (subject: 'Hi there')",
    },
    {
      label: 'unmatched_thread with only message_id',
      kind: 'unmatched_thread',
      detail: { message_id: '<m2@x>' },
      expected: 'No thread match for <m2@x>',
    },
    {
      label: 'attachment_too_large with filename + size + limit',
      kind: 'attachment_too_large',
      detail: { filename: 'big.pdf', size: 5_242_880, limit: 1_048_576 },
      expected: 'big.pdf: 5242880 bytes (limit 1048576)',
    },
    {
      label: 'attachment_too_large with only filename',
      kind: 'attachment_too_large',
      detail: { filename: 'big.pdf' },
      expected: 'big.pdf',
    },
  ])('$label', ({ kind, detail, expected }) => {
    expect(renderCommLogDetail(kind, detail)).toBe(expected);
  });

  it('falls back to JSON.stringify for unknown kinds', () => {
    const out = renderCommLogDetail('weird_kind', { foo: 'bar', n: 1 });
    expect(out).toBe('{"foo":"bar","n":1}');
  });

  it('tolerates a null detail object', () => {
    // Per the server's CommLogRow contract, detail may be omitted; the
    // client decoder leaves the property undefined. Renderers must
    // therefore guard against non-object detail.
    expect(renderCommLogDetail('poll', null)).toBe('Polled 0 messages');
    expect(renderCommLogDetail('send_ok', undefined)).toBe('Sent');
    expect(renderCommLogDetail('parse_error', null)).toBe('Parse error');
  });

  it('handles a scalar detail value', () => {
    // Defensive: if the detail jsonb is a bare number (not a JSON object),
    // the per-kind renderer should still produce a non-empty string.
    expect(renderCommLogDetail('poll', 42)).toBe('Polled 0 messages');
  });
});

/* -------------------------------------------------------------------------- */
/* applyClientFilters                                                         */
/* -------------------------------------------------------------------------- */

describe('applyClientFilters', () => {
  function mkRow(kind: string, id: bigint): CommLogRow {
    return {
      id,
      channel_id: 0n,
      channel_name: '',
      kind,
      at: `2026-05-13T12:00:00.${id.toString().padStart(3, '0')}Z`,
    };
  }
  const ROWS: CommLogRow[] = [
    mkRow('poll', 1n),
    mkRow('send_ok', 2n),
    mkRow('send_bounce', 3n),
    mkRow('poll', 4n),
  ];

  it('returns every row when kind filter is empty', () => {
    expect(applyClientFilters(ROWS, '').map((r) => r.id)).toEqual([1n, 2n, 3n, 4n]);
  });

  it('filters by kind exactly', () => {
    expect(applyClientFilters(ROWS, 'poll').map((r) => r.id)).toEqual([1n, 4n]);
    expect(applyClientFilters(ROWS, 'send_ok').map((r) => r.id)).toEqual([2n]);
    expect(applyClientFilters(ROWS, 'nope')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const before = ROWS.map((r) => r.id);
    applyClientFilters(ROWS, 'poll');
    expect(ROWS.map((r) => r.id)).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* commLogList codec                                                          */
/* -------------------------------------------------------------------------- */

describe('commLogList codec', () => {
  it('encodes the project_id and omits empty optional filters', () => {
    const encoded = commLogList.encode({ projectId: 42n }) as Record<string, unknown>;
    expect(encoded).toEqual({ project_id: 42n });
  });

  it('emits kind / since / limit only when supplied', () => {
    const encoded = commLogList.encode({
      projectId: 42n,
      kind: 'poll',
      since: '2026-01-01T00:00:00Z',
      limit: 50,
    }) as Record<string, unknown>;
    expect(encoded).toEqual({
      project_id: 42n,
      kind: 'poll',
      since: '2026-01-01T00:00:00Z',
      limit: 50,
    });
  });

  it('omits an explicitly-zero limit (server applies the 200 default)', () => {
    const encoded = commLogList.encode({
      projectId: 42n,
      limit: 0,
    }) as Record<string, unknown>;
    expect(encoded.limit).toBeUndefined();
  });

  it('omits an empty-string kind / since', () => {
    const encoded = commLogList.encode({
      projectId: 42n,
      kind: '',
      since: '',
    }) as Record<string, unknown>;
    expect(encoded.kind).toBeUndefined();
    expect(encoded.since).toBeUndefined();
  });

  it('decodes a row envelope with detail jsonb pass-through', () => {
    const out = commLogList.decode({
      rows: [
        {
          id: 1n,
          channel_id: 7n,
          channel_name: 'Support',
          kind: 'send_ok',
          detail: { recipient: 'a@example.com' },
          at: '2026-05-13T12:00:00.000Z',
        },
      ],
    });
    expect(out.rows).toHaveLength(1);
    const r = out.rows[0]!;
    expect(r.id).toBe(1n);
    expect(r.channel_id).toBe(7n);
    expect(r.channel_name).toBe('Support');
    expect(r.kind).toBe('send_ok');
    expect(r.detail).toEqual({ recipient: 'a@example.com' });
    expect(r.at).toBe('2026-05-13T12:00:00.000Z');
  });

  it('defaults channel_id to 0 when the server omits it (pre-identification rows)', () => {
    const out = commLogList.decode({
      rows: [
        {
          id: 2n,
          kind: 'imap_auth_fail',
          at: '2026-05-13T12:00:00.000Z',
        },
      ],
    });
    expect(out.rows[0]!.channel_id).toBe(0n);
    expect(out.rows[0]!.channel_name).toBe('');
    expect(out.rows[0]!.detail).toBeUndefined();
  });

  it('exposes the registered endpoint / action pair', () => {
    expect(commLogList.endpoint).toBe('comm_log');
    expect(commLogList.action).toBe('list');
  });
});

/* -------------------------------------------------------------------------- */
/* Component compile-smoke                                                    */
/* -------------------------------------------------------------------------- */

describe('AdminCommLogScreen import', () => {
  it('the .svelte component module loads without throwing', async () => {
    const m = await import('../../src/screens/admin/AdminCommLogScreen.svelte');
    expect(m.default).toBeDefined();
  });
});

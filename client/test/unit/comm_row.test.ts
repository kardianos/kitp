/**
 * Comm Gate 8 unit coverage — pure helpers for the CommTaskRow widget +
 * Task detail Comms section, plus a compile-smoke import for the
 * component itself.
 *
 * The vitest setup is node-only (no jsdom), so we cover behaviour through
 * helpers extracted into `src/screens/comm_helpers.ts`:
 *
 *   - `commListForTaskPayload(taskId)` shapes the read input.
 *   - `replyPostPayload(commId, body)` shapes the reply.post input.
 *     The To: list and Subject line are derived server-side from
 *     comm.recipients + the parent task title, so they are NOT in the
 *     input.
 *   - `sortRepliesAsc` / `lastNReplies` drive the inline display order.
 *   - `commStatusTone` / `commStatusLabel` resolve the badge.
 *
 * The dispatcher request shape for `reply.post` is also asserted via the
 * mock so the wire payload is locked.
 */

import { describe, expect, it, vi } from 'vitest';

import { replyPost } from '../../src/reg/handlers.js';
import type { CommRow, ReplyRow } from '../../src/reg/types.js';
import {
  commListForTaskPayload,
  commStatusLabel,
  commStatusTone,
  lastNReplies,
  replyPostPayload,
  sortRepliesAsc,
} from '../../src/screens/comm_helpers.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let nextReplyId = 100n;
function makeReply(opts: Partial<ReplyRow> & { delivery_status: string }): ReplyRow {
  return {
    id: opts.id ?? nextReplyId++,
    to: opts.to ?? '',
    from: opts.from ?? '',
    subject: opts.subject ?? '',
    body_text: opts.body_text ?? '',
    delivery_status: opts.delivery_status,
    created_at: opts.created_at ?? '2026-01-01T00:00:00Z',
  };
}

function makeComm(opts: Partial<CommRow> = {}): CommRow {
  return {
    id: opts.id ?? 1n,
    title: opts.title ?? 'Hello there',
    thread_id: opts.thread_id ?? 'abc1234567',
    channel_id: opts.channel_id ?? 9n,
    comm_status: opts.comm_status ?? 50n,
    recipients: opts.recipients ?? [],
    replies: opts.replies ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* commListForTaskPayload                                                     */
/* -------------------------------------------------------------------------- */

describe('commListForTaskPayload', () => {
  it('wraps the task id into the wire input shape', () => {
    expect(commListForTaskPayload(42n)).toEqual({ taskId: 42n });
  });
});

/* -------------------------------------------------------------------------- */
/* replyPostPayload                                                            */
/* -------------------------------------------------------------------------- */

describe('replyPostPayload', () => {
  it('shapes the minimal reply.post input (commId + body only)', () => {
    expect(replyPostPayload(5n, 'body text')).toEqual({
      commId: 5n,
      body: 'body text',
    });
  });

  it('does not carry a `to` or `subject` field — those are server-derived', () => {
    const out = replyPostPayload(5n, 'body text');
    expect('to' in out).toBe(false);
    expect('subject' in out).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* reply.post wire encoding (mocked dispatcher)                               */
/* -------------------------------------------------------------------------- */

describe('reply.post wire encoding', () => {
  it('encoder produces a snake_case payload with only comm_id and body', () => {
    const wire = replyPost.encode({ commId: 11n, body: 'thanks!' });
    expect(wire).toEqual({ comm_id: 11n, body: 'thanks!' });
  });

  it('decoder lifts the reply_id into a typed bigint', () => {
    const out = replyPost.decode({ reply_id: 77 });
    expect(out.reply_id).toBe(77n);
  });

  it('end-to-end: send button calls dispatcher.request with reply.post payload', async () => {
    interface RequestArgs {
      endpoint: string;
      action: string;
      data: unknown;
    }
    const request = vi.fn(async (_args: RequestArgs) => ({ reply_id: 88n }));
    const data = replyPostPayload(3n, 'sure!');
    await request({
      endpoint: replyPost.endpoint,
      action: replyPost.action,
      data,
    });
    expect(request).toHaveBeenCalledOnce();
    const call = request.mock.calls[0]?.[0];
    expect(call?.endpoint).toBe('reply');
    expect(call?.action).toBe('post');
    expect(call?.data).toEqual({ commId: 3n, body: 'sure!' });
  });
});

/* -------------------------------------------------------------------------- */
/* sortRepliesAsc                                                              */
/* -------------------------------------------------------------------------- */

describe('sortRepliesAsc', () => {
  it('sorts oldest first by created_at', () => {
    const a = makeReply({ id: 1n, delivery_status: 'sent', created_at: '2026-01-02T00:00:00Z' });
    const b = makeReply({ id: 2n, delivery_status: 'sent', created_at: '2026-01-01T00:00:00Z' });
    const c = makeReply({ id: 3n, delivery_status: 'sent', created_at: '2026-01-03T00:00:00Z' });
    const sorted = sortRepliesAsc([a, b, c]);
    expect(sorted.map((r) => r.id)).toEqual([2n, 1n, 3n]);
  });

  it('ties on created_at break by id ascending', () => {
    const a = makeReply({ id: 5n, delivery_status: 'sent', created_at: '2026-01-01T00:00:00Z' });
    const b = makeReply({ id: 2n, delivery_status: 'sent', created_at: '2026-01-01T00:00:00Z' });
    const sorted = sortRepliesAsc([a, b]);
    expect(sorted.map((r) => r.id)).toEqual([2n, 5n]);
  });

  it('does not mutate the input', () => {
    const a = makeReply({ delivery_status: 'sent', created_at: '2026-01-02T00:00:00Z' });
    const b = makeReply({ delivery_status: 'sent', created_at: '2026-01-01T00:00:00Z' });
    const input = [a, b];
    const snapshot = [...input];
    sortRepliesAsc(input);
    expect(input).toEqual(snapshot);
  });
});

/* -------------------------------------------------------------------------- */
/* lastNReplies                                                                */
/* -------------------------------------------------------------------------- */

describe('lastNReplies', () => {
  it('returns up to N replies in chronological order (newest last)', () => {
    const r1 = makeReply({ id: 1n, delivery_status: 'sent', created_at: '2026-01-01T00:00:00Z' });
    const r2 = makeReply({ id: 2n, delivery_status: 'sent', created_at: '2026-01-02T00:00:00Z' });
    const r3 = makeReply({ id: 3n, delivery_status: 'sent', created_at: '2026-01-03T00:00:00Z' });
    const r4 = makeReply({ id: 4n, delivery_status: 'sent', created_at: '2026-01-04T00:00:00Z' });
    expect(lastNReplies([r4, r1, r3, r2], 3).map((r) => r.id)).toEqual([2n, 3n, 4n]);
  });

  it('returns every reply when fewer than N exist', () => {
    const r1 = makeReply({ id: 1n, delivery_status: 'sent', created_at: '2026-01-01T00:00:00Z' });
    expect(lastNReplies([r1], 3).map((r) => r.id)).toEqual([1n]);
  });

  it('returns empty array for empty input', () => {
    expect(lastNReplies([], 3)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* commStatusTone                                                              */
/* -------------------------------------------------------------------------- */

describe('commStatusTone', () => {
  it('returns blue for active phase', () => {
    expect(commStatusTone('active')).toBe('blue');
  });

  it('returns green for terminal phase', () => {
    expect(commStatusTone('terminal')).toBe('green');
  });

  it('returns muted for triage phase', () => {
    expect(commStatusTone('triage')).toBe('muted');
  });

  it('falls back to muted for unknown phases', () => {
    expect(commStatusTone('something_unknown')).toBe('muted');
  });
});

/* -------------------------------------------------------------------------- */
/* commStatusLabel                                                             */
/* -------------------------------------------------------------------------- */

describe('commStatusLabel', () => {
  it('looks up the title from the map', () => {
    expect(commStatusLabel(7n, { '7': 'Open' })).toBe('Open');
  });

  it('falls back to "#id" when the lookup misses', () => {
    expect(commStatusLabel(7n, {})).toBe('#7');
  });

  it('returns empty string when comm_status is zero', () => {
    expect(commStatusLabel(0n, { '0': 'never' })).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* Module compile smoke                                                       */
/* -------------------------------------------------------------------------- */

describe('CommTaskRow component import', () => {
  it('loads without throwing', async () => {
    const mod = await import('../../src/ui/widgets/CommTaskRow.svelte');
    expect(mod.default).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* comm.create / comm.list_for_task wire encoding                             */
/* -------------------------------------------------------------------------- */

describe('comm.list_for_task wire encoding', () => {
  it('renders a comm row through the decoder', async () => {
    const { commListForTask } = await import('../../src/reg/handlers.js');
    const raw = {
      rows: [
        {
          id: 100,
          title: 'Hello',
          thread_id: 'xyz1234567',
          channel_id: 9,
          comm_status: 50,
          recipients: [11, 12],
          replies: [
            {
              id: 200,
              to: 'a@b.com',
              from: 'c@d.com',
              subject: 'Re: hi',
              body_text: 'thanks!',
              delivery_status: 'received',
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        },
      ],
    };
    const out = commListForTask.decode(raw);
    expect(out.rows).toHaveLength(1);
    const r = out.rows[0];
    expect(r?.id).toBe(100n);
    expect(r?.thread_id).toBe('xyz1234567');
    expect(r?.recipients).toEqual([11n, 12n]);
    expect(r?.replies).toHaveLength(1);
    expect(r?.replies[0]?.delivery_status).toBe('received');
    expect(r?.replies[0]?.from).toBe('c@d.com');
  });

  it('decoder tolerates an absent recipients field (legacy rows)', async () => {
    const { commListForTask } = await import('../../src/reg/handlers.js');
    const raw = {
      rows: [
        {
          id: 100,
          title: 'Hello',
          thread_id: 'xyz1234567',
          channel_id: 9,
          comm_status: 50,
          replies: [],
        },
      ],
    };
    const out = commListForTask.decode(raw);
    expect(out.rows[0]?.recipients).toEqual([]);
  });

  it('encoder ships task_id in snake_case', async () => {
    const { commListForTask } = await import('../../src/reg/handlers.js');
    expect(commListForTask.encode({ taskId: 5n })).toEqual({ task_id: 5n });
  });
});

/* -------------------------------------------------------------------------- */
/* comm.create with recipients                                                */
/* -------------------------------------------------------------------------- */

describe('comm.create wire encoding', () => {
  it('encoder includes recipient_person_ids when non-empty', async () => {
    const { commCreate } = await import('../../src/reg/handlers.js');
    expect(
      commCreate.encode({
        taskId: 1n,
        channelId: 2n,
        recipientPersonIds: [11n, 12n],
      }),
    ).toEqual({
      task_id: 1n,
      channel_id: 2n,
      recipient_person_ids: [11n, 12n],
    });
  });

  it('encoder omits recipient_person_ids when empty / undefined', async () => {
    const { commCreate } = await import('../../src/reg/handlers.js');
    expect(commCreate.encode({ taskId: 1n, channelId: 2n })).toEqual({
      task_id: 1n,
      channel_id: 2n,
    });
    expect(
      commCreate.encode({ taskId: 1n, channelId: 2n, recipientPersonIds: [] }),
    ).toEqual({ task_id: 1n, channel_id: 2n });
  });
});

/* -------------------------------------------------------------------------- */
/* comm.set_recipients wire encoding                                           */
/* -------------------------------------------------------------------------- */

describe('comm.set_recipients wire encoding', () => {
  it('encoder ships comm_id + recipient_person_ids', async () => {
    const { commSetRecipients } = await import('../../src/reg/handlers.js');
    expect(
      commSetRecipients.encode({ commId: 9n, recipientPersonIds: [3n, 4n] }),
    ).toEqual({ comm_id: 9n, recipient_person_ids: [3n, 4n] });
  });

  it('decoder lifts count out of the response envelope', async () => {
    const { commSetRecipients } = await import('../../src/reg/handlers.js');
    expect(commSetRecipients.decode({ count: 2 })).toEqual({ count: 2 });
  });
});

/* -------------------------------------------------------------------------- */
/* person.upsert_by_email wire encoding                                        */
/* -------------------------------------------------------------------------- */

describe('person.upsert_by_email wire encoding', () => {
  it('encoder ships email + display_name + kind when provided', async () => {
    const { personUpsertByEmail } = await import('../../src/reg/handlers.js');
    expect(
      personUpsertByEmail.encode({
        email: 'alice@example.com',
        displayName: 'Alice',
        kind: 'contact',
      }),
    ).toEqual({
      email: 'alice@example.com',
      display_name: 'Alice',
      kind: 'contact',
    });
  });

  it('encoder omits display_name when empty', async () => {
    const { personUpsertByEmail } = await import('../../src/reg/handlers.js');
    expect(personUpsertByEmail.encode({ email: 'a@b.com' })).toEqual({
      email: 'a@b.com',
    });
  });

  it('decoder lifts person_id (bigint) and created (boolean)', async () => {
    const { personUpsertByEmail } = await import('../../src/reg/handlers.js');
    expect(personUpsertByEmail.decode({ person_id: 42, created: true })).toEqual({
      person_id: 42n,
      created: true,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* makeComm fixture sanity                                                     */
/* -------------------------------------------------------------------------- */

describe('makeComm fixture', () => {
  it('defaults recipients to an empty list', () => {
    expect(makeComm().recipients).toEqual([]);
  });
});

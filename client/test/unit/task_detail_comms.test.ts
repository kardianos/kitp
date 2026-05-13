/**
 * Comm Gate 8 unit coverage for the Task detail "Comms" section.
 *
 * Spec §"What about the Task detail view?" (email_comm_spec.md L154):
 *
 *   Task detail shows: internal comments (existing), attached comms
 *   (new), and the reply history of each comm (read-only on this
 *   screen). The "Reply" action is *not* available on Task detail; the
 *   user navigates to the Comms screen to post a reply.
 *
 * The vitest setup is node-only (no jsdom), so behavioural assertions
 * come from helpers + a compile-smoke for the component. The component
 * itself renders:
 *   - title, comm_status badge, thread_id
 *   - replies, oldest first (sortRepliesAsc)
 *   - a "Go to Comms" link to /project/<id>/screen/comms
 *
 * It explicitly does NOT render a Reply button — the file's source is
 * grep-asserted at the end to make the contract testable.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { commStatusLabel, sortRepliesAsc } from '../../src/screens/comm_helpers.js';
import type { CommRow, ReplyRow } from '../../src/reg/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeReply(opts: Partial<ReplyRow> & { delivery_status: string }): ReplyRow {
  return {
    id: opts.id ?? 1n,
    to: opts.to ?? '',
    from: opts.from ?? '',
    subject: opts.subject ?? '',
    body_text: opts.body_text ?? '',
    delivery_status: opts.delivery_status,
    created_at: opts.created_at ?? '2026-01-01T00:00:00Z',
  };
}

/* -------------------------------------------------------------------------- */
/* Comms section data-shape coverage                                          */
/* -------------------------------------------------------------------------- */

describe('Task detail Comms section — data shaping', () => {
  it('orders the reply chain oldest-first for the read-only display', () => {
    const replies: ReplyRow[] = [
      makeReply({ id: 3n, delivery_status: 'sent', created_at: '2026-01-03T00:00:00Z' }),
      makeReply({ id: 1n, delivery_status: 'received', created_at: '2026-01-01T00:00:00Z' }),
      makeReply({ id: 2n, delivery_status: 'sent', created_at: '2026-01-02T00:00:00Z' }),
    ];
    expect(sortRepliesAsc(replies).map((r) => r.id)).toEqual([1n, 2n, 3n]);
  });

  it('resolves comm_status to a badge label via the status title map', () => {
    expect(commStatusLabel(42n, { '42': 'Open' })).toBe('Open');
    expect(commStatusLabel(42n, {})).toBe('#42');
  });

  it('renders no badge label when comm_status is zero (defensive)', () => {
    expect(commStatusLabel(0n, { '0': 'never used' })).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* "Go to Comms" link URL contract                                            */
/* -------------------------------------------------------------------------- */

describe('Task detail — Go to Comms link', () => {
  it('targets /project/:id/screen/comms when the task has a project parent', () => {
    // The link is rendered by TaskDetailScreen.svelte; we read the
    // source and assert the URL template matches the spec — keeping the
    // boundary purely declarative without booting a DOM. If a refactor
    // accidentally drops the route, this fails.
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'TaskDetailScreen.svelte'),
      'utf8',
    );
    expect(src).toMatch(/\/project\/\{task\.parent_card_id\}\/screen\/comms/);
    // The link also has a stable test id so the e2e suite can find it.
    expect(src).toContain('data-testid="task-comms-goto-link"');
    // And the click handler navigates() to /project/<pid>/screen/comms.
    expect(src).toMatch(/navigate\(`\/project\/\$\{pid\}\/screen\/comms`\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* No Reply button on Task detail                                             */
/* -------------------------------------------------------------------------- */

describe('Task detail — Reply boundary (no Reply button)', () => {
  it('TaskDetailScreen.svelte does not import the CommTaskRow widget', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'TaskDetailScreen.svelte'),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"][^'"]*CommTaskRow\.svelte['"]/);
  });

  it('TaskDetailScreen.svelte does not call reply.post', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'TaskDetailScreen.svelte'),
      'utf8',
    );
    // The handler spec is `replyPost`; the action name on the wire is
    // 'post' on endpoint 'reply'. Neither should appear in the screen
    // source — replies live on the Comms screen only.
    expect(src).not.toMatch(/\breplyPost\b/);
    expect(src).not.toMatch(/endpoint:\s*['"]reply['"]/);
  });

  it('the Comms section has its own test id distinct from the comments composer', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'TaskDetailScreen.svelte'),
      'utf8',
    );
    expect(src).toContain('aria-labelledby="comms-heading"');
    expect(src).toContain('data-testid="task-comms-list"');
    // The Comments composer still exists alongside.
    expect(src).toContain('data-testid="task-comment-input"');
  });
});

/* -------------------------------------------------------------------------- */
/* Comms section structure expectations                                       */
/* -------------------------------------------------------------------------- */

describe('Task detail — Comms section rendering surface', () => {
  it('emits a stable empty-state when the task has no comms', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'TaskDetailScreen.svelte'),
      'utf8',
    );
    expect(src).toContain('data-testid="task-comms-empty"');
    expect(src).toMatch(/comms\.length\s*===\s*0/);
  });

  it('renders one row per comm with the thread_id badge and status', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'TaskDetailScreen.svelte'),
      'utf8',
    );
    expect(src).toContain('data-testid="task-comms-row"');
    expect(src).toContain('data-testid="task-comms-thread-id"');
    expect(src).toContain('data-testid="task-comms-status"');
  });

  it('emits the reply list with per-reply delivery_status surfaced', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'screens', 'TaskDetailScreen.svelte'),
      'utf8',
    );
    expect(src).toContain('data-testid="task-comms-replies"');
    expect(src).toContain('data-testid="task-comms-reply"');
    expect(src).toContain('data-delivery-status={r.delivery_status}');
  });
});

/* -------------------------------------------------------------------------- */
/* Compile smoke                                                              */
/* -------------------------------------------------------------------------- */

describe('TaskDetailScreen import', () => {
  it('loads without throwing', async () => {
    const mod = await import('../../src/screens/TaskDetailScreen.svelte');
    expect(mod.default).toBeDefined();
  });
});

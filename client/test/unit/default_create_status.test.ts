/**
 * default_create_status — Gate 6 of FLOW_AND_SCREEN_KERNEL.
 *
 * The resolver is a pure function; these tests pin every stop of the
 * chain (screen override → flow default → first triage → first active
 * → error) using table-driven `it.each` blocks.
 */

import { describe, expect, it } from 'vitest';

import {
  resolveDefaultCreateStatus,
  type FlowRow,
} from '../../src/quick_entry/default_status.svelte';
import type { CardWithAttrs, ID } from '../../src/reg/types';

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

function mkStatus(
  id: bigint,
  phase: 'triage' | 'active' | 'terminal',
  sortOrder: number,
  title = `s${id}`,
): CardWithAttrs {
  return {
    id,
    card_type_id: 7n,
    card_type_name: 'status',
    phase,
    attributes: { title, sort_order: sortOrder },
  };
}

function mkScreen(defaultCreateStatus?: ID): CardWithAttrs {
  const attrs: Record<string, unknown> = {
    title: 'Inbox',
    slug: 'inbox',
    layout: 'list',
  };
  if (defaultCreateStatus !== undefined) {
    attrs['default_create_status'] = defaultCreateStatus;
  }
  return {
    id: 100n,
    card_type_id: 9n,
    card_type_name: 'screen',
    phase: 'active',
    attributes: attrs,
  };
}

function mkFlow(defaultCreateStatusID?: ID): FlowRow {
  const out: FlowRow = {
    id: 1n,
    attribute_def_id: 5n,
    scope_card_id: 2n,
  };
  if (defaultCreateStatusID !== undefined) {
    out.default_create_status_id = defaultCreateStatusID;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('resolveDefaultCreateStatus — chain ordering', () => {
  const triage = mkStatus(10n, 'triage', 0);
  const active1 = mkStatus(20n, 'active', 1);
  const active2 = mkStatus(21n, 'active', 2);
  const terminal = mkStatus(30n, 'terminal', 4);

  const candidates = [triage, active1, active2, terminal];

  it('stop 1: screen.default_create_status wins over everything', () => {
    const r = resolveDefaultCreateStatus({
      screenCard: mkScreen(999n),
      flow: mkFlow(888n),
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: 999n });
  });

  it('stop 2: falls through to flow.default_create_status_id when screen has none', () => {
    const r = resolveDefaultCreateStatus({
      screenCard: mkScreen(),
      flow: mkFlow(888n),
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: 888n });
  });

  it('stop 3: first triage by sort_order when no screen / flow override', () => {
    const r = resolveDefaultCreateStatus({
      screenCard: mkScreen(),
      flow: mkFlow(),
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: triage.id });
  });

  it('stop 4: first active by sort_order when no triage exists', () => {
    // Drop the triage row from the candidate set.
    const noTriage = candidates.filter((c) => c.phase !== 'triage');
    const r = resolveDefaultCreateStatus({
      screenCard: mkScreen(),
      flow: mkFlow(),
      candidateStatuses: noTriage,
    });
    expect(r).toEqual({ statusCardId: active1.id });
  });

  it('stop 5: returns flow_no_default when no triage AND no active', () => {
    const terminalOnly = candidates.filter((c) => c.phase === 'terminal');
    const r = resolveDefaultCreateStatus({
      screenCard: mkScreen(),
      flow: mkFlow(),
      candidateStatuses: terminalOnly,
    });
    expect(r).toEqual({
      error: 'flow_no_default',
      message: expect.stringContaining('valid starting status'),
    });
  });

  it('stop 5: returns flow_no_default when candidate list is empty', () => {
    const r = resolveDefaultCreateStatus({
      screenCard: null,
      flow: null,
      candidateStatuses: [],
    });
    expect('error' in r ? r.error : null).toBe('flow_no_default');
  });
});

describe('resolveDefaultCreateStatus — sort_order tiebreaking', () => {
  it('within triage, picks the lowest sort_order', () => {
    const candidates: CardWithAttrs[] = [
      mkStatus(30n, 'triage', 100),
      mkStatus(31n, 'triage', 0),
      mkStatus(32n, 'triage', 50),
    ];
    const r = resolveDefaultCreateStatus({
      screenCard: null,
      flow: null,
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: 31n });
  });

  it('ties on sort_order break on id (ascending)', () => {
    const candidates: CardWithAttrs[] = [
      mkStatus(50n, 'triage', 5),
      mkStatus(40n, 'triage', 5),
      mkStatus(60n, 'triage', 5),
    ];
    const r = resolveDefaultCreateStatus({
      screenCard: null,
      flow: null,
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: 40n });
  });

  it('candidates without sort_order sink to the back', () => {
    const noSort: CardWithAttrs = {
      id: 99n,
      card_type_id: 7n,
      card_type_name: 'status',
      phase: 'active',
      attributes: { title: 'unsorted' }, // no sort_order
    };
    const sortedActive = mkStatus(20n, 'active', 5);
    const r = resolveDefaultCreateStatus({
      screenCard: null,
      flow: null,
      candidateStatuses: [noSort, sortedActive],
    });
    expect(r).toEqual({ statusCardId: 20n });
  });
});

describe('resolveDefaultCreateStatus — flow default_create_status_id edge cases', () => {
  const candidates = [mkStatus(10n, 'triage', 0)];

  it('treats flow.default_create_status_id === 0n as unset (falls through)', () => {
    const r = resolveDefaultCreateStatus({
      screenCard: null,
      flow: { id: 1n, attribute_def_id: 5n, scope_card_id: 2n, default_create_status_id: 0n },
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: 10n });
  });

  it('treats flow without default_create_status_id as unset', () => {
    const r = resolveDefaultCreateStatus({
      screenCard: null,
      flow: { id: 1n, attribute_def_id: 5n, scope_card_id: 2n },
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: 10n });
  });

  it('honours non-zero flow default_create_status_id', () => {
    const r = resolveDefaultCreateStatus({
      screenCard: null,
      flow: { id: 1n, attribute_def_id: 5n, scope_card_id: 2n, default_create_status_id: 42n },
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: 42n });
  });
});

describe('resolveDefaultCreateStatus — screen.default_create_status decoding', () => {
  const candidates = [mkStatus(10n, 'triage', 0)];

  it.each<['number' | 'string-of-digits' | 'bigint', unknown, ID]>([
    ['bigint', 777n, 777n],
    ['number', 777, 777n],
    ['string-of-digits', '777', 777n],
  ])('decodes %s screen attribute as bigint', (_label, raw, expected) => {
    const screen: CardWithAttrs = {
      id: 100n,
      card_type_id: 9n,
      card_type_name: 'screen',
      phase: 'active',
      attributes: { default_create_status: raw },
    };
    const r = resolveDefaultCreateStatus({
      screenCard: screen,
      flow: null,
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: expected });
  });

  it('ignores non-numeric strings on the screen attribute (falls through)', () => {
    const screen: CardWithAttrs = {
      id: 100n,
      card_type_id: 9n,
      card_type_name: 'screen',
      phase: 'active',
      attributes: { default_create_status: 'not-a-number' },
    };
    const r = resolveDefaultCreateStatus({
      screenCard: screen,
      flow: null,
      candidateStatuses: candidates,
    });
    expect(r).toEqual({ statusCardId: 10n });
  });
});

describe('resolveDefaultCreateStatus — null / undefined inputs', () => {
  it('null screenCard and null flow both bottom-out into phase walk', () => {
    const candidates = [mkStatus(10n, 'triage', 0)];
    expect(
      resolveDefaultCreateStatus({
        screenCard: null,
        flow: null,
        candidateStatuses: candidates,
      }),
    ).toEqual({ statusCardId: 10n });
  });

  it('undefined screenCard and undefined flow both bottom-out into phase walk', () => {
    const candidates = [mkStatus(10n, 'triage', 0)];
    expect(
      resolveDefaultCreateStatus({
        candidateStatuses: candidates,
      }),
    ).toEqual({ statusCardId: 10n });
  });
});

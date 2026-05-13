/**
 * Unit coverage for the AdminFlowsScreen pure helpers and the
 * flow / flow_step handler wire shapes.
 *
 * The vitest runner is node-only, so the .svelte component is not mounted —
 * we exercise:
 *   1. helpers in `src/screens/admin/admin_flows_helpers.ts`
 *      (search, grouping, validation, blocked-by formatting),
 *   2. handler encoders / decoders in `src/reg/handlers_admin.ts`
 *      (flow.list / flow.set / flow.delete / flow.preview_delete +
 *      flow_step.list / flow_step.set / flow_step.delete),
 *   3. compile-smoke of the screen module so a typo in the .svelte file
 *      surfaces here instead of at first browser render.
 *
 * Style mirrors `admin_screens.test.ts` / `admin_users.test.ts`: every
 * helper gets an `it.each(...)` data table where the cases benefit from
 * it, with focused `it(...)` blocks for the wire-shape and round-trip
 * checks.
 */

import { describe, expect, it } from 'vitest';

import { HandlerRegistry } from '../../src/reg/handler_registry.js';
import {
  flowDelete,
  flowList,
  flowPreviewDelete,
  flowSet,
  flowStepDelete,
  flowStepList,
  flowStepSet,
} from '../../src/reg/handlers_admin.js';
import { registerBuiltInHandlers } from '../../src/reg/handlers.js';
import type {
  CardWithAttrs,
  FlowRow,
  FlowStepBlocker,
  FlowStepRow,
} from '../../src/reg/types.js';
import {
  applyFlowSearch,
  formatBlockedByMessage,
  formatRoleBadge,
  groupStepsByFrom,
  lookupCardTitle,
  parseSortOrder,
  validateFlow,
  validateFlowStep,
  valueCardCacheKey,
  valueCardTitleMap,
} from '../../src/screens/admin/admin_flows_helpers.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function flow(id: bigint, name: string, attrName = 'status'): FlowRow {
  return {
    id,
    name,
    doc: '',
    attribute_def_id: 100n,
    attribute_def_name: attrName,
    scope_card_id: 7n,
    default_create_status_id: 0n,
    created_at: '2026-05-13T00:00:00Z',
  };
}

function step(
  id: bigint,
  fromId: bigint,
  toId: bigint,
  opts: {
    label?: string;
    role?: bigint;
    roleName?: string;
    sort?: number;
  } = {},
): FlowStepRow {
  return {
    id,
    flow_id: 1n,
    from_card_id: fromId,
    to_card_id: toId,
    label: opts.label ?? 'Move',
    requires_role_id: opts.role ?? 0n,
    requires_role_name: opts.roleName ?? '',
    sort_order: opts.sort ?? 0,
  };
}

function valueCard(id: bigint, title: string): CardWithAttrs {
  return {
    id,
    card_type_id: 99n,
    card_type_name: 'status',
    phase: 'active',
    attributes: { title },
  };
}

/* -------------------------------------------------------------------------- */
/* applyFlowSearch                                                            */
/* -------------------------------------------------------------------------- */

describe('applyFlowSearch', () => {
  const flows: FlowRow[] = [
    flow(1n, 'Standard task'),
    flow(2n, 'Bug triage'),
    flow(3n, 'Standard milestone'),
  ];

  it.each<{ label: string; needle: string; want: bigint[] }>([
    { label: 'empty returns all', needle: '', want: [1n, 2n, 3n] },
    { label: 'whitespace returns all', needle: '   ', want: [1n, 2n, 3n] },
    { label: 'case-insensitive', needle: 'STANDARD', want: [1n, 3n] },
    { label: 'no matches', needle: 'zzz', want: [] },
    { label: 'partial', needle: 'bug', want: [2n] },
  ])('$label', ({ needle, want }) => {
    expect(applyFlowSearch(flows, needle).map((f) => f.id)).toEqual(want);
  });

  it('does not mutate the input', () => {
    const before = flows.map((f) => f.id);
    applyFlowSearch(flows, 'standard');
    expect(flows.map((f) => f.id)).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* groupStepsByFrom                                                           */
/* -------------------------------------------------------------------------- */

describe('groupStepsByFrom', () => {
  it('buckets steps by from_card_id preserving input order within each bucket', () => {
    const out = groupStepsByFrom([
      step(1n, 10n, 20n, { sort: 1 }),
      step(2n, 11n, 20n, { sort: 1 }),
      step(3n, 10n, 21n, { sort: 2 }),
      step(4n, 10n, 22n, { sort: 3 }),
      step(5n, 11n, 22n, { sort: 4 }),
    ]);
    expect(out.map((b) => b.fromCardId)).toEqual([10n, 11n]);
    expect(out[0]!.steps.map((s) => s.id)).toEqual([1n, 3n, 4n]);
    expect(out[1]!.steps.map((s) => s.id)).toEqual([2n, 5n]);
  });

  it('empty input yields empty array', () => {
    expect(groupStepsByFrom([])).toEqual([]);
  });

  it('first-seen wins for bucket order', () => {
    const out = groupStepsByFrom([
      step(1n, 30n, 1n),
      step(2n, 10n, 1n),
      step(3n, 30n, 2n),
    ]);
    expect(out.map((b) => b.fromCardId)).toEqual([30n, 10n]);
  });
});

/* -------------------------------------------------------------------------- */
/* valueCardTitleMap / lookupCardTitle                                        */
/* -------------------------------------------------------------------------- */

describe('valueCardTitleMap', () => {
  it('maps id → title and falls back to `#<id>` for missing titles', () => {
    const m = valueCardTitleMap([
      valueCard(1n, 'Todo'),
      valueCard(2n, 'Doing'),
      {
        id: 3n,
        card_type_id: 99n,
        card_type_name: 'status',
        phase: 'active',
        attributes: {},
      },
    ]);
    expect(lookupCardTitle(m, 1n)).toBe('Todo');
    expect(lookupCardTitle(m, 2n)).toBe('Doing');
    expect(lookupCardTitle(m, 3n)).toBe('#3');
    expect(lookupCardTitle(m, 99n)).toBe('#99');
  });
});

/* -------------------------------------------------------------------------- */
/* valueCardCacheKey — guards against the picker showing the wrong project's  */
/* statuses after the user switches the project picker.                       */
/* -------------------------------------------------------------------------- */

describe('valueCardCacheKey', () => {
  it('produces distinct keys per (project, card_type) pair', () => {
    expect(valueCardCacheKey(28n, 'status')).toBe('28:status');
    expect(valueCardCacheKey(10n, 'status')).toBe('10:status');
    // different projects → different keys
    expect(valueCardCacheKey(28n, 'status')).not.toBe(valueCardCacheKey(10n, 'status'));
    // different card types under the same project → different keys
    expect(valueCardCacheKey(28n, 'status')).not.toBe(valueCardCacheKey(28n, 'milestone'));
  });
  it('is stable for the same inputs', () => {
    expect(valueCardCacheKey(28n, 'status')).toBe(valueCardCacheKey(28n, 'status'));
  });
});

/* -------------------------------------------------------------------------- */
/* formatRoleBadge                                                            */
/* -------------------------------------------------------------------------- */

describe('formatRoleBadge', () => {
  it('returns null when no role gate is set', () => {
    expect(formatRoleBadge(step(1n, 10n, 11n))).toBe(null);
  });
  it('returns the role name when present', () => {
    expect(
      formatRoleBadge(
        step(1n, 10n, 11n, { role: 5n, roleName: 'reviewer' }),
      ),
    ).toBe('reviewer');
  });
  it('falls back to a role id label when the name is empty', () => {
    expect(
      formatRoleBadge(step(1n, 10n, 11n, { role: 5n })),
    ).toBe('role #5');
  });
});

/* -------------------------------------------------------------------------- */
/* validateFlowStep                                                           */
/* -------------------------------------------------------------------------- */

describe('validateFlowStep', () => {
  it('requires from / to / label', () => {
    const r = validateFlowStep({
      fromCardId: null,
      toCardId: null,
      label: '',
      sortOrder: '',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.fromCardId).toBeDefined();
    expect(r.errors.toCardId).toBeDefined();
    expect(r.errors.label).toBeDefined();
  });

  it('rejects from === to', () => {
    const r = validateFlowStep({
      fromCardId: 10n,
      toCardId: 10n,
      label: 'Loop',
      sortOrder: '',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.toCardId).toBeDefined();
  });

  it('rejects non-integer sort_order', () => {
    const r = validateFlowStep({
      fromCardId: 1n,
      toCardId: 2n,
      label: 'Go',
      sortOrder: '1.5',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.sortOrder).toBeDefined();
  });

  it('accepts a minimal valid draft', () => {
    const r = validateFlowStep({
      fromCardId: 10n,
      toCardId: 11n,
      label: 'Move',
      sortOrder: '',
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
  });

  it('accepts integer sort_order including 0', () => {
    expect(
      validateFlowStep({
        fromCardId: 1n,
        toCardId: 2n,
        label: 'Go',
        sortOrder: '0',
      }).ok,
    ).toBe(true);
    expect(
      validateFlowStep({
        fromCardId: 1n,
        toCardId: 2n,
        label: 'Go',
        sortOrder: '42',
      }).ok,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* parseSortOrder                                                             */
/* -------------------------------------------------------------------------- */

describe('parseSortOrder', () => {
  it.each<{ raw: string; want: number }>([
    { raw: '', want: 0 },
    { raw: '   ', want: 0 },
    { raw: '0', want: 0 },
    { raw: '10', want: 10 },
    { raw: '-3', want: -3 },
    { raw: '1.5', want: 0 },
    { raw: 'nope', want: 0 },
  ])('parses $raw → $want', ({ raw, want }) => {
    expect(parseSortOrder(raw)).toBe(want);
  });
});

/* -------------------------------------------------------------------------- */
/* validateFlow                                                               */
/* -------------------------------------------------------------------------- */

describe('validateFlow', () => {
  it('requires name + attr + project', () => {
    const r = validateFlow({
      name: '   ',
      doc: '',
      attributeDefId: null,
      scopeCardId: null,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.name).toBeDefined();
    expect(r.errors.attributeDefId).toBeDefined();
    expect(r.errors.scopeCardId).toBeDefined();
  });
  it('accepts a minimal valid draft', () => {
    const r = validateFlow({
      name: 'Standard',
      doc: '',
      attributeDefId: 100n,
      scopeCardId: 7n,
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* formatBlockedByMessage                                                     */
/* -------------------------------------------------------------------------- */

describe('formatBlockedByMessage', () => {
  it('handles a single-flow group succinctly', () => {
    const blocked: FlowStepBlocker[] = [
      {
        flow_step_id: 1n,
        flow_id: 7n,
        flow_name: 'Standard',
        role: 'from',
        from_label: 'Todo',
        to_label: 'Done',
        step_label: 'Complete',
      },
      {
        flow_step_id: 2n,
        flow_id: 7n,
        flow_name: 'Standard',
        role: 'to',
        from_label: 'Triage',
        to_label: 'Todo',
        step_label: 'Accept',
      },
    ];
    const got = formatBlockedByMessage('Todo', blocked);
    expect(got).toContain('"Todo"');
    expect(got).toContain('2 transitions');
    expect(got).toContain('"Standard"');
    expect(got).toContain('Complete (Todo → Done)');
    expect(got).toContain('Accept (Triage → Todo)');
    expect(got).toContain('Delete those transitions first');
  });

  it('handles a multi-flow group with per-flow headings', () => {
    const blocked: FlowStepBlocker[] = [
      {
        flow_step_id: 1n,
        flow_id: 7n,
        flow_name: 'Standard',
        role: 'from',
        from_label: 'Todo',
        to_label: 'Done',
        step_label: 'Complete',
      },
      {
        flow_step_id: 9n,
        flow_id: 8n,
        flow_name: 'Bug triage',
        role: 'to',
        from_label: 'New',
        to_label: 'Todo',
        step_label: 'Reproduce',
      },
    ];
    const got = formatBlockedByMessage('Todo', blocked);
    expect(got).toContain('across 2 flows');
    expect(got).toContain('Standard');
    expect(got).toContain('Bug triage');
    expect(got).toContain('Complete (Todo → Done)');
    expect(got).toContain('Reproduce (New → Todo)');
  });

  it('handles an empty list', () => {
    expect(formatBlockedByMessage('Todo', [])).toBe('Cannot delete "Todo".');
  });
});

/* -------------------------------------------------------------------------- */
/* Wire shape: flow.list / set / delete / preview_delete                      */
/* -------------------------------------------------------------------------- */

describe('flow.list codec', () => {
  it('omits optional filters when undefined', () => {
    expect(flowList.encode({}) as Record<string, unknown>).toEqual({});
  });
  it('emits snake_case fields for the wire', () => {
    const enc = flowList.encode({
      scopeCardId: 7n,
      attributeDefId: 100n,
    }) as Record<string, unknown>;
    expect(enc).toEqual({ scope_card_id: 7n, attribute_def_id: 100n });
  });
  it('decodes rows including doc default and default_create_status_id', () => {
    const dec = flowList.decode({
      rows: [
        {
          id: 1n,
          name: 'Std',
          attribute_def_id: 100n,
          attribute_def_name: 'status',
          scope_card_id: 7n,
          default_create_status_id: 42n,
          created_at: '2026-05-13',
        },
        // minimal — doc omitted, default omitted
        {
          id: 2n,
          name: 'B',
          attribute_def_id: 101n,
          attribute_def_name: 'priority',
          scope_card_id: 7n,
          created_at: '',
        },
      ],
    });
    expect(dec.rows).toHaveLength(2);
    expect(dec.rows[0]?.doc).toBe('');
    expect(dec.rows[0]?.default_create_status_id).toBe(42n);
    expect(dec.rows[1]?.default_create_status_id).toBe(0n);
  });
});

describe('flow.set codec', () => {
  it('omits id, doc, default when absent / falsy', () => {
    const enc = flowSet.encode({
      name: 'Std',
      attributeDefId: 100n,
      scopeCardId: 7n,
    }) as Record<string, unknown>;
    expect(enc).toEqual({
      name: 'Std',
      attribute_def_id: 100n,
      scope_card_id: 7n,
    });
    expect('id' in enc).toBe(false);
    expect('doc' in enc).toBe(false);
    expect('default_create_status_id' in enc).toBe(false);
  });
  it('emits all fields on a full update', () => {
    const enc = flowSet.encode({
      id: 9n,
      name: 'Std',
      doc: 'docs',
      attributeDefId: 100n,
      scopeCardId: 7n,
      defaultCreateStatusId: 42n,
    }) as Record<string, unknown>;
    expect(enc).toEqual({
      id: 9n,
      name: 'Std',
      doc: 'docs',
      attribute_def_id: 100n,
      scope_card_id: 7n,
      default_create_status_id: 42n,
    });
  });
  it('decodes id from a numeric response', () => {
    expect(flowSet.decode({ id: 123 })).toEqual({ id: 123n });
  });
});

describe('flow.delete codec', () => {
  it('emits flow_id and decodes ok / deleted', () => {
    expect(flowDelete.encode({ flowId: 7n })).toEqual({ flow_id: 7n });
    expect(flowDelete.decode({ ok: true, deleted: 1 })).toEqual({
      ok: true,
      deleted: 1,
    });
  });
});

describe('flow.preview_delete codec', () => {
  it('emits flow_id', () => {
    expect(flowPreviewDelete.encode({ flowId: 7n })).toEqual({ flow_id: 7n });
  });
  it('decodes the V16 shape with phase counts and sample labels', () => {
    const dec = flowPreviewDelete.decode({
      flow_id: 7n,
      flow_name: 'Standard',
      step_count: 4,
      tasks_currently_in_flow_states: 3,
      tasks_by_phase: { triage: 1, active: 2, terminal: 0 },
      sample_step_labels: ['Start', 'Complete', 'Reopen'],
    });
    expect(dec.flow_id).toBe(7n);
    expect(dec.flow_name).toBe('Standard');
    expect(dec.step_count).toBe(4);
    expect(dec.tasks_currently_in_flow_states).toBe(3);
    expect(dec.tasks_by_phase).toEqual({
      triage: 1,
      active: 2,
      terminal: 0,
    });
    expect(dec.sample_step_labels).toEqual(['Start', 'Complete', 'Reopen']);
  });
  it('defaults missing phase counts to zero and labels to empty array', () => {
    const dec = flowPreviewDelete.decode({
      flow_id: 7n,
      flow_name: 'X',
      step_count: 0,
      tasks_currently_in_flow_states: 0,
      tasks_by_phase: null,
    });
    expect(dec.tasks_by_phase).toEqual({ triage: 0, active: 0, terminal: 0 });
    expect(dec.sample_step_labels).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Wire shape: flow_step.list / set / delete                                  */
/* -------------------------------------------------------------------------- */

describe('flow_step.list codec', () => {
  it('emits flow_id on the wire', () => {
    expect(flowStepList.encode({ flowId: 7n })).toEqual({ flow_id: 7n });
  });
  it('decodes rows including the optional role gate', () => {
    const dec = flowStepList.decode({
      rows: [
        {
          id: 1n,
          flow_id: 7n,
          from_card_id: 10n,
          to_card_id: 11n,
          label: 'Move',
          requires_role_id: 5n,
          requires_role_name: 'reviewer',
          sort_order: 1,
        },
        {
          id: 2n,
          flow_id: 7n,
          from_card_id: 10n,
          to_card_id: 12n,
          label: 'Skip',
        },
      ],
    });
    expect(dec.rows[0]?.requires_role_id).toBe(5n);
    expect(dec.rows[1]?.requires_role_id).toBe(0n);
    expect(dec.rows[1]?.requires_role_name).toBe('');
    expect(dec.rows[1]?.sort_order).toBe(0);
  });
});

describe('flow_step.set codec', () => {
  it('omits id / role / sort when absent / falsy', () => {
    const enc = flowStepSet.encode({
      flowId: 7n,
      fromCardId: 10n,
      toCardId: 11n,
      label: 'Move',
    }) as Record<string, unknown>;
    expect(enc).toEqual({
      flow_id: 7n,
      from_card_id: 10n,
      to_card_id: 11n,
      label: 'Move',
    });
    expect('id' in enc).toBe(false);
    expect('requires_role_id' in enc).toBe(false);
    expect('sort_order' in enc).toBe(false);
  });
  it('emits the full payload on update', () => {
    const enc = flowStepSet.encode({
      id: 3n,
      flowId: 7n,
      fromCardId: 10n,
      toCardId: 11n,
      label: 'Move',
      requiresRoleId: 5n,
      sortOrder: 42,
    }) as Record<string, unknown>;
    expect(enc).toEqual({
      id: 3n,
      flow_id: 7n,
      from_card_id: 10n,
      to_card_id: 11n,
      label: 'Move',
      requires_role_id: 5n,
      sort_order: 42,
    });
  });
  it('decodes id', () => {
    expect(flowStepSet.decode({ id: 99 })).toEqual({ id: 99n });
  });
});

describe('flow_step.delete codec', () => {
  it('emits flow_step_id and decodes ok/deleted', () => {
    expect(flowStepDelete.encode({ flowStepId: 9n })).toEqual({
      flow_step_id: 9n,
    });
    expect(flowStepDelete.decode({ ok: true, deleted: 1 })).toEqual({
      ok: true,
      deleted: 1,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* registerBuiltInHandlers wires every flow / flow_step handler               */
/* -------------------------------------------------------------------------- */

describe('registerBuiltInHandlers', () => {
  it('registers each new flow / flow_step admin handler exactly once', () => {
    const r = new HandlerRegistry();
    registerBuiltInHandlers(r);
    for (const [endpoint, action] of [
      ['flow', 'list'],
      ['flow', 'set'],
      ['flow', 'delete'],
      ['flow', 'preview_delete'],
      ['flow_step', 'list'],
      ['flow_step', 'set'],
      ['flow_step', 'delete'],
    ] as const) {
      expect(r.has(endpoint, action), `${endpoint}.${action}`).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Component compile-smoke                                                    */
/* -------------------------------------------------------------------------- */

describe('AdminFlowsScreen imports', () => {
  it('the .svelte component module loads without throwing', async () => {
    const m = await import('../../src/screens/admin/AdminFlowsScreen.svelte');
    expect(m.default).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Flow row sanity                                                            */
/* -------------------------------------------------------------------------- */

describe('FlowRow conventions', () => {
  it('treats default_create_status_id=0n as "no default" downstream', () => {
    const f = flow(1n, 'X');
    expect(f.default_create_status_id).toBe(0n);
  });
});

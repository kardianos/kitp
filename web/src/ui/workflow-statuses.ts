// Shared loader for a project's TASK-STATUS flow membership. The kanban hides
// out-of-flow status columns via its own `kanban.workflowStatusIds`; this puts
// the same set on a project-scoped tree leaf so the OTHER status surfaces
// (grid, task-detail badge, related-tasks, comm-threads) — which load every
// status card under a project, including ones from other flows — can scope
// their Linear-style icon ramp to the same statuses the kanban shows.

import type { ControlContext } from '../core/control.js';

/** Tree path holding a `ReadonlySet<string>` of the project's task-flow status
 *  id-strings, or `null` when the project has no status flow (→ surfaces ramp
 *  over whatever statuses they hold). Owned by the AppShell. */
export const WORKFLOW_STATUS_IDS_PATH = ['scope', 'workflowStatusIds'] as const;

/** Current task-flow status id set (peek — no subscription). null until loaded
 *  or when the project has no status flow. */
export function peekWorkflowStatusIds(ctx: ControlContext): ReadonlySet<string> | null {
  return ctx.tree.at(['scope', 'workflowStatusIds']).peek<ReadonlySet<string> | null>() ?? null;
}

/**
 * Resolve the task-status flow's member status ids for [projectId] into
 * {@link WORKFLOW_STATUS_IDS_PATH}. Two batched reads (`flow.list` →
 * `flow_step.list`); the second can't fire until the first resolves the flow id.
 */
export function loadWorkflowStatusIds(
  ctx: ControlContext,
  projectId: bigint | null,
  alive: () => boolean,
): void {
  const leaf = ctx.tree.at(['scope', 'workflowStatusIds']);
  if (projectId === null) {
    leaf.set(null);
    return;
  }
  ctx.api.callByName(
    'flow.list',
    { scopeCardId: projectId },
    (out) => {
      if (!alive()) return;
      const rows =
        ((out ?? {}) as { rows?: Array<{ id: string; attribute_def_name?: string }> }).rows ?? [];
      const flow = rows.find((r) => r.attribute_def_name === 'status') ?? null;
      if (flow === null) {
        leaf.set(null);
        return;
      }
      ctx.api.callByName(
        'flow_step.list',
        { flowId: flow.id },
        (stepsOut) => {
          if (!alive()) return;
          const stepRows =
            ((stepsOut ?? {}) as { rows?: Array<{ from_card_id: string; to_card_id: string }> })
              .rows ?? [];
          const ids = new Set<string>();
          for (const r of stepRows) {
            if (/^-?\d+$/.test(r.from_card_id)) ids.add(r.from_card_id);
            if (/^-?\d+$/.test(r.to_card_id)) ids.add(r.to_card_id);
          }
          leaf.set(ids.size > 0 ? ids : null);
        },
        { alive },
      );
    },
    { alive },
  );
}

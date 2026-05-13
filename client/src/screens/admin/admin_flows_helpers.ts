/**
 * Pure helpers for `AdminFlowsScreen`.
 *
 * Extracted as a TypeScript module so they can be unit-tested without a
 * Svelte component-mount runtime (vitest is node-only here). Mirrors the
 * extraction pattern of `admin_attributes_helpers.ts` /
 * `admin_screens_helpers.ts`.
 *
 *   - `applyFlowSearch`         case-insensitive substring filter on `name`.
 *   - `groupStepsByFrom`        bucket flow_steps by `from_card_id` so the
 *                               UI can render outgoing transitions per
 *                               value-card.
 *   - `valueCardTitleMap`       id → display title from CardWithAttrs[]
 *                               (used to label from/to in the step list).
 *   - `formatRoleBadge`         display string for a step's required role,
 *                               or null when no gate is set.
 *   - `validateFlowStep`        non-empty label + non-zero from/to ids;
 *                               sort_order must parse as an integer.
 *   - `validateFlow`            non-empty name + non-zero attribute_def_id
 *                               + non-zero scope_card_id.
 *   - `formatBlockedByMessage`  render the V8 blocked_by list as a
 *                               human-readable callout body (used by the
 *                               value-card delete error dialog).
 */

import type {
  CardWithAttrs,
  FlowRow,
  FlowStepBlocker,
  FlowStepRow,
  ID,
} from '../../reg/types.js';

// ----------------------------------------------------------------------------
// Search / grouping
// ----------------------------------------------------------------------------

/** Case-insensitive substring match on `name`. Whitespace-only returns input. */
export function applyFlowSearch(
  flows: readonly FlowRow[],
  search: string,
): FlowRow[] {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return flows.slice();
  const out: FlowRow[] = [];
  for (const f of flows) {
    if (f.name.toLowerCase().includes(needle)) out.push(f);
  }
  return out;
}

/**
 * Bucket flow_steps by `from_card_id`. Each bucket preserves the input
 * order (which the server sorts by sort_order then label) so the
 * caller can render outgoing transitions per value-card without an
 * additional sort.
 */
export interface FromBucket {
  fromCardId: ID;
  steps: FlowStepRow[];
}

export function groupStepsByFrom(
  steps: readonly FlowStepRow[],
): FromBucket[] {
  const order: ID[] = [];
  const byId = new Map<string, FromBucket>();
  for (const s of steps) {
    const key = s.from_card_id.toString();
    let b = byId.get(key);
    if (b === undefined) {
      b = { fromCardId: s.from_card_id, steps: [] };
      byId.set(key, b);
      order.push(s.from_card_id);
    }
    b.steps.push(s);
  }
  const out: FromBucket[] = [];
  for (const id of order) {
    const bucket = byId.get(id.toString());
    if (bucket !== undefined) out.push(bucket);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Value-card title resolver
// ----------------------------------------------------------------------------

/**
 * id → display title from a list of value-cards. Falls back to `#<id>` when
 * the card is missing or has no title attribute (mirrors the convention
 * used elsewhere in the admin UI).
 */
export function valueCardTitleMap(
  cards: readonly CardWithAttrs[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of cards) {
    const t = c.attributes['title'];
    const title = typeof t === 'string' && t.length > 0 ? t : `#${c.id}`;
    out.set(c.id.toString(), title);
  }
  return out;
}

/** Look up a card title via {@link valueCardTitleMap} keyed by id-as-string. */
export function lookupCardTitle(
  titles: Map<string, string>,
  id: ID,
): string {
  return titles.get(id.toString()) ?? `#${id}`;
}

// ----------------------------------------------------------------------------
// Role badge
// ----------------------------------------------------------------------------

/**
 * Returns a display string for a step's required role, or null when no
 * role gate is set. The server emits the joined role name on
 * `flow_step.list`, so this is mostly a "is there a gate" predicate that
 * preserves the existing label.
 */
export function formatRoleBadge(step: FlowStepRow): string | null {
  if (step.requires_role_id === 0n) return null;
  const name = step.requires_role_name.trim();
  return name === '' ? `role #${step.requires_role_id}` : name;
}

// ----------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
}

/** Draft shape for the inline flow-step editor in AdminFlowsScreen. */
export interface FlowStepDraft {
  fromCardId: ID | null;
  toCardId: ID | null;
  label: string;
  /** UI-side sort_order is a string so the input control can hold a partial
   *  entry; convert at save time via parseSortOrder. */
  sortOrder: string;
  requiresRoleId?: ID | null;
}

export function validateFlowStep(draft: FlowStepDraft): ValidationResult {
  const errors: Record<string, string> = {};
  if (draft.fromCardId === null || draft.fromCardId === 0n) {
    errors.fromCardId = 'Pick a starting value';
  }
  if (draft.toCardId === null || draft.toCardId === 0n) {
    errors.toCardId = 'Pick a destination value';
  }
  if (
    draft.fromCardId !== null &&
    draft.toCardId !== null &&
    draft.fromCardId === draft.toCardId &&
    draft.fromCardId !== 0n
  ) {
    errors.toCardId = 'From and To must differ';
  }
  if (draft.label.trim() === '') {
    errors.label = 'Label is required';
  }
  const trimmedSort = draft.sortOrder.trim();
  if (trimmedSort !== '') {
    const n = Number(trimmedSort);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      errors.sortOrder = 'Sort order must be a whole number';
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Coerce a sort_order UI string to a number (0 when empty / invalid). */
export function parseSortOrder(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 0;
  return n;
}

/** Draft shape for the inline / dialog flow editor in AdminFlowsScreen. */
export interface FlowDraft {
  name: string;
  doc: string;
  attributeDefId: ID | null;
  scopeCardId: ID | null;
  defaultCreateStatusId?: ID | null;
}

export function validateFlow(draft: FlowDraft): ValidationResult {
  const errors: Record<string, string> = {};
  if (draft.name.trim() === '') {
    errors.name = 'Name is required';
  }
  if (draft.attributeDefId === null || draft.attributeDefId === 0n) {
    errors.attributeDefId = 'Pick an attribute';
  }
  if (draft.scopeCardId === null || draft.scopeCardId === 0n) {
    errors.scopeCardId = 'Pick a project';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// ----------------------------------------------------------------------------
// Blocked-by formatting (value_referenced_by_flow rejection)
// ----------------------------------------------------------------------------

/**
 * Render the V8 `blocked_by[]` rejection detail as a human-readable
 * message body. Format mirrors the user-facing dialog:
 *
 *   "Cannot delete 'Todo': it's referenced by 2 transitions in 'Standard task' flow:
 *     • Complete (Todo → Done)
 *     • Accept (Triage → Todo)
 *   Delete those transitions first, then retry."
 *
 * Grouping is by `flow_name` so admins see "this flow has 3 references"
 * in one block rather than three separate lines for the same flow.
 */
export function formatBlockedByMessage(
  cardTitle: string,
  blockedBy: readonly FlowStepBlocker[],
): string {
  if (blockedBy.length === 0) {
    return `Cannot delete "${cardTitle}".`;
  }
  // Group by flow_name to keep the message compact.
  const byFlow = new Map<string, FlowStepBlocker[]>();
  for (const b of blockedBy) {
    const k = b.flow_name === '' ? `#${b.flow_id}` : b.flow_name;
    const cur = byFlow.get(k);
    if (cur === undefined) byFlow.set(k, [b]);
    else cur.push(b);
  }
  const flowCount = byFlow.size;
  const stepCount = blockedBy.length;
  const lines: string[] = [];
  const head =
    flowCount === 1
      ? `Cannot delete "${cardTitle}": it's referenced by ${plural(
          stepCount,
          'transition',
        )} in "${[...byFlow.keys()][0]}":`
      : `Cannot delete "${cardTitle}": it's referenced by ${plural(
          stepCount,
          'transition',
        )} across ${plural(flowCount, 'flow')}:`;
  lines.push(head);
  for (const [flowName, steps] of byFlow.entries()) {
    if (flowCount > 1) {
      lines.push(`  ${flowName}:`);
    }
    for (const s of steps) {
      const lbl = s.step_label === '' ? '(unnamed)' : s.step_label;
      const from = s.from_label === '' ? `#${s.flow_step_id}` : s.from_label;
      const to = s.to_label === '' ? '?' : s.to_label;
      lines.push(`  • ${lbl} (${from} → ${to})`);
    }
  }
  lines.push('Delete those transitions first, then retry.');
  return lines.join('\n');
}

function plural(n: number, word: string): string {
  return n === 1 ? `1 ${word}` : `${n} ${word}s`;
}

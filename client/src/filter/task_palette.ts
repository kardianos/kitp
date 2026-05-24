/**
 * Shared filter / picker palette for task-shaped screens.
 *
 * Every list screen (Inbox, Grid, Kanban, ProjectDetail) historically
 * built its own `FilterAttribute[]` inline, and they drifted: KanbanScreen
 * left milestone/component pickers without options, GridScreen used
 * `def.value_type` raw (skipping the `user_ref` -> `ref:user`
 * normalisation in `attribute_schema`), InboxScreen pooled milestones
 * and components into one cardTitles map (so each picker showed both
 * lists). This module is the single code path: same names, same
 * normalised types, same friendly labels, same option-resolution rules.
 *
 * Pair with the Combobox + ValueInput pair already used by FilterBar /
 * AttributeSidePanel for control unification.
 */

import type { CardWithAttrs, UserRow } from '../reg/types';
import { isAssignablePerson } from '../util/person';
import type {
  AttributeSchemaCache,
  FilterAttribute,
  FilterAttributeOption,
} from './attribute_schema.svelte';

/**
 * Build option list for a list of ref-target cards.
 *
 * Picks the ref label from the first defined of `attributes.title`,
 * `attributes.name`, `attributes.path` (in that order), so the same
 * helper covers project / milestone / component / person (title),
 * tag (path), and any future card type that uses `name`. Falls back
 * to `#<id>`.
 */
export function buildRefOptions(rows: CardWithAttrs[]): FilterAttributeOption[] {
  return rows.map((r) => {
    const a = r.attributes;
    const t = a['title'] ?? a['name'] ?? a['path'];
    const label = typeof t === 'string' && t.length > 0 ? t : `#${r.id}`;
    const opt: FilterAttributeOption = { value: r.id, label };
    if (r.phase === 'terminal') opt.isTerminal = true;
    return opt;
  });
}

/** Build option list from `UserRow[]` (legacy user-ref attributes). */
export function buildUserOptions(users: UserRow[]): FilterAttributeOption[] {
  return users.map((u) => ({ value: u.id, label: u.display_name }));
}

export interface TaskPaletteInputs {
  schema: AttributeSchemaCache;
  /**
   * Person cards (card_type_name='person'). Source for assignee option
   * resolution now that the `assignee` attribute_def is a `card_ref`
   * pointing at `person` cards (not a `user_ref` at user_account).
   */
  persons: CardWithAttrs[];
  milestones: CardWithAttrs[];
  components: CardWithAttrs[];
  tags?: CardWithAttrs[];
  /**
   * Status value cards (card_type_name='status'). Source for the
   * `status` ref attribute's options + the terminal-state detection
   * that drives the "Hide closed status" filter toggle.
   */
  statuses?: CardWithAttrs[];
  /**
   * Legacy user-account rows. Retained so any remaining `user_ref`
   * attribute_defs continue to resolve, but no longer used for
   * `assignee` after the schema flip.
   */
  users?: UserRow[];
  /**
   * Override the default attribute-name set (assignee / milestone_ref /
   * component_ref / tags). Order is preserved.
   */
  names?: readonly string[];
}

const DEFAULT_NAMES: readonly string[] = [
  'status',
  'assignee',
  'originator',
  'milestone_ref',
  'component_ref',
  'tags',
  // Surfaced for the advanced filter editor. Quick-filter dropdown
  // skips ref:task because there's no per-project task option list,
  // but the advanced "Add filter" path picks it up via the palette and
  // exposes `parent_status_phase` (the 2-hop traversal that lets
  // power users express "open tasks at the head of their chain").
  'parent_task',
  // Built-in `date`-typed attribute. Carries the `beforeToday` /
  // `withinDays` ops so the seeded "Overdue" / "Due within 3 days"
  // snippets render in the advanced editor instead of falling through
  // to the "#due_date / attribute not loaded" branch.
  'due_date',
];

/**
 * Synthetic text attributes added at the bottom of every task palette
 * so the FilterBar Add / Advanced editor can express `contains` leaves
 * against title / description / comments without a corresponding
 * attribute_def row. The server's where.go compiler routes `contains`
 * on these attr names to the right SQL subquery (attribute_value for
 * title/description; comment_body via activity for comments).
 */
const SYNTHETIC_TEXT_ATTRS: readonly FilterAttribute[] = [
  {
    name: 'title',
    label: 'Title',
    valueType: 'text',
    ops: ['contains', 'eq', 'ne', 'exists', 'notExists'],
  },
  {
    name: 'description',
    label: 'Description',
    valueType: 'text',
    ops: ['contains', 'exists', 'notExists'],
  },
  {
    name: 'comments',
    label: 'Comments',
    valueType: 'text',
    ops: ['contains'],
  },
];

/**
 * Standard filter palette for a task-shaped list screen.
 *
 * Returns an empty array until the schema cache has loaded — callers
 * who want a placeholder palette pre-load can render a skeleton in the
 * `!schema.loaded` branch.
 *
 * The `assignee` attribute_def is `card_ref → person` post-refactor,
 * so its options resolve from `persons`. The schema cache's name-based
 * card-type inference returns `ref:card` for `assignee` (no `_ref`
 * suffix to inspect), so we post-process the produced FilterAttribute:
 * relabel the valueType as `ref:person` and inject person-card options.
 * The legacy `user` branch is retained for any lingering `user_ref`
 * attribute_defs the schema might still expose.
 */
export function buildTaskFilterPalette(
  inputs: TaskPaletteInputs,
): FilterAttribute[] {
  const { schema, persons, milestones, components, tags, statuses, users } = inputs;
  if (!schema.loaded) return [];

  const refResolver = (cardTypeName: string): FilterAttributeOption[] => {
    // Assignee filter excludes contact-kind persons (email-only
    // contacts the comm recipient picker auto-created). Other person
    // refs reuse the same list — comm recipient filtering doesn't
    // currently exist as a separate palette entry.
    if (cardTypeName === 'person') {
      return buildRefOptions(persons.filter(isAssignablePerson));
    }
    if (cardTypeName === 'user') return buildUserOptions(users ?? []);
    if (cardTypeName === 'milestone') return buildRefOptions(milestones);
    if (cardTypeName === 'component') return buildRefOptions(components);
    if (cardTypeName === 'tag') return buildRefOptions(tags ?? []);
    if (cardTypeName === 'status') return buildRefOptions(statuses ?? []);
    return [];
  };

  const out: FilterAttribute[] = [];
  for (const name of inputs.names ?? DEFAULT_NAMES) {
    const fa = schema.toFilterAttribute(name, refResolver);
    if (fa === null) continue;
    // `assignee` is now a card_ref → person card. The schema cache can
    // only infer the target card type from a trailing `_ref` in the def
    // name (so `milestone_ref` → `ref:milestone`); without that hint it
    // falls back to the generic `ref:card`. Patch the palette entry in
    // place so its valueType + options come out as `ref:person` with
    // person-card options rather than an empty `ref:card` Combobox.
    if (fa.name === 'assignee' && fa.valueType === 'ref:card') {
      fa.valueType = 'ref:person';
      const opts = buildRefOptions(persons);
      if (opts.length > 0) fa.options = opts;
    }
    // `originator` follows the same shape as `assignee` — card_ref →
    // person, inferred as `ref:card` by the schema cache. Patch in
    // place so the picker resolves person labels.
    if (fa.name === 'originator' && fa.valueType === 'ref:card') {
      fa.valueType = 'ref:person';
      const opts = buildRefOptions(persons);
      if (opts.length > 0) fa.options = opts;
    }
    // `parent_task` is card_ref → task. The palette has no per-project
    // task option list (the screen feeds milestones, statuses, etc. but
    // never every task), so the value-picker ops (eq / ne / in / notIn)
    // would render an empty Combobox. Keep only the ops that don't
    // need a task picker:
    //   - `parentStatusPhase`: phase-checkbox picker; 2-hop traversal.
    //   - `exists` / `notExists`: structural — "any parent" / "no parent".
    // We also drop `hasPhase`, which on `parent_task` would inspect the
    // parent task's own `card.phase` (always default 'triage' for
    // non-value cards — useless filter). `parentStatusPhase` is the
    // useful equivalent. Listed first so the editor's default op is
    // immediately useful instead of falling back to `eq` with an empty
    // picker. See `where.go: parent_status_phase`.
    if (fa.name === 'parent_task') {
      fa.ops = ['parentStatusPhase', 'exists', 'notExists'];
    }
    out.push(fa);
  }
  // Append synthetic text attributes for Add filter / Advanced usage.
  // Skipped when caller supplied an explicit `names` list (they want a
  // narrowed palette).
  if (inputs.names === undefined) {
    for (const syn of SYNTHETIC_TEXT_ATTRS) {
      if (out.some((a) => a.name === syn.name)) continue;
      out.push({ ...syn });
    }
  }
  return out;
}

/**
 * Resolve a raw attribute value to its display label.
 *
 * - For enum / ref attributes, looks up the value in `attr.options`
 *   (or `refOverrides[attr.name]` when the caller has a fresher list,
 *   e.g. AttributeSidePanel injecting per-screen options).
 * - For arrays (multi-value), comma-joins the resolved labels.
 * - Falls through to `String(value)` so unknown values still render
 *   something rather than blank.
 */
export function resolveAttributeLabel(
  attr: FilterAttribute | undefined,
  value: unknown,
  refOverrides?: Record<string, FilterAttributeOption[]>,
): string {
  if (value === null || value === undefined) return '—';
  const opts =
    (attr !== undefined ? refOverrides?.[attr.name] : undefined) ??
    attr?.options ??
    [];
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    return value
      .map((v) => opts.find((o) => o.value === v)?.label ?? String(v))
      .join(', ');
  }
  const f = opts.find((o) => o.value === value);
  if (f !== undefined) return f.label;
  return String(value);
}

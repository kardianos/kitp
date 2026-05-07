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
 * helper covers project / milestone / component (title), tag (path),
 * and any future card type that uses `name`. Falls back to `#<id>`.
 */
export function buildRefOptions(rows: CardWithAttrs[]): FilterAttributeOption[] {
  return rows.map((r) => {
    const a = r.attributes;
    const t = a['title'] ?? a['name'] ?? a['path'];
    const label = typeof t === 'string' && t.length > 0 ? t : `#${r.id}`;
    return { value: r.id, label };
  });
}

/** Build option list from `UserRow[]` (assignee). */
export function buildUserOptions(users: UserRow[]): FilterAttributeOption[] {
  return users.map((u) => ({ value: u.id, label: u.display_name }));
}

export interface TaskPaletteInputs {
  schema: AttributeSchemaCache;
  users: UserRow[];
  milestones: CardWithAttrs[];
  components: CardWithAttrs[];
  tags?: CardWithAttrs[];
  /**
   * Override the default attribute-name set (status / assignee /
   * milestone_ref / component_ref / tags). Order is preserved.
   */
  names?: readonly string[];
}

const DEFAULT_NAMES: readonly string[] = [
  'status',
  'assignee',
  'milestone_ref',
  'component_ref',
  'tags',
];

/**
 * Standard filter palette for a task-shaped list screen.
 *
 * Returns an empty array until the schema cache has loaded — callers
 * who want a placeholder palette pre-load can render a skeleton in the
 * `!schema.loaded` branch.
 */
export function buildTaskFilterPalette(
  inputs: TaskPaletteInputs,
): FilterAttribute[] {
  const { schema, users, milestones, components, tags } = inputs;
  if (!schema.loaded) return [];

  const refResolver = (cardTypeName: string): FilterAttributeOption[] => {
    if (cardTypeName === 'user') return buildUserOptions(users);
    if (cardTypeName === 'milestone') return buildRefOptions(milestones);
    if (cardTypeName === 'component') return buildRefOptions(components);
    if (cardTypeName === 'tag') return buildRefOptions(tags ?? []);
    return [];
  };

  const out: FilterAttribute[] = [];
  for (const name of inputs.names ?? DEFAULT_NAMES) {
    const fa = schema.toFilterAttribute(name, refResolver);
    if (fa !== null) out.push(fa);
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

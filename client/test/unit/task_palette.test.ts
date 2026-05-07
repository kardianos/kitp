/**
 * Unit coverage for the shared task-palette helpers.
 *
 * The vitest runner is node-only (no jsdom). `buildTaskFilterPalette`
 * delegates to `AttributeSchemaCache.toFilterAttribute()`, so we stub
 * the cache with a minimal shape that satisfies the call sites. The
 * pure helpers (`buildRefOptions`, `buildUserOptions`,
 * `resolveAttributeLabel`) take no Svelte deps and run as-is.
 */

import { describe, expect, it } from 'vitest';

import type {
  AttributeSchemaCache,
  FilterAttribute,
  FilterAttributeOption,
} from '../../src/filter/attribute_schema.svelte.js';
import {
  buildRefOptions,
  buildTaskFilterPalette,
  buildUserOptions,
  resolveAttributeLabel,
} from '../../src/filter/task_palette.js';
import type { CardWithAttrs, UserRow } from '../../src/reg/types.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function card(
  id: number,
  type: string,
  attrs: Record<string, unknown>,
): CardWithAttrs {
  return { id, card_type_id: 1, card_type_name: type, attributes: attrs };
}

const USERS: UserRow[] = [
  { id: 1, display_name: 'alice' },
  { id: 2, display_name: 'bob' },
];

const MILESTONES: CardWithAttrs[] = [
  card(10, 'milestone', { title: 'M1' }),
  card(11, 'milestone', { title: 'M2' }),
];

const COMPONENTS: CardWithAttrs[] = [
  card(20, 'component', { title: 'frontend' }),
  card(21, 'component', { name: 'backend' }), // exercises name fallback
  card(22, 'component', {}), // exercises #id fallback
];

const TAGS: CardWithAttrs[] = [
  card(30, 'tag', { path: 'priority/high' }),
  card(31, 'tag', { path: 'area/api' }),
];

/* -------------------------------------------------------------------------- */
/* AttributeSchemaCache stub                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Minimal stand-in for AttributeSchemaCache. Only the surface
 * `buildTaskFilterPalette` actually touches: `loaded`, `defs`,
 * `defByName`, `toFilterAttribute`. Mirrors the real implementation's
 * normalisation rules (user_ref/card_ref → ref:*, friendly label).
 */
function makeStubCache(): AttributeSchemaCache {
  // Mirrors the production normalizeValueType + friendlyLabel logic
  // closely enough for assertion: the real helper itself is exercised
  // indirectly via the production cache in the screen tests.
  const defs = [
    {
      id: 1,
      name: 'status',
      value_type: 'enum',
      bound_to: [],
      options: [
        { value: 'todo', label: 'To do' },
        { value: 'doing', label: 'Doing' },
        { value: 'done', label: 'Done' },
      ],
    },
    { id: 2, name: 'assignee', value_type: 'user_ref', bound_to: [] },
    { id: 3, name: 'milestone_ref', value_type: 'card_ref', bound_to: [] },
    { id: 4, name: 'component_ref', value_type: 'card_ref', bound_to: [] },
    { id: 5, name: 'tags', value_type: 'card_ref', bound_to: [] },
  ];

  function friendly(name: string): string {
    let n = name;
    if (n.endsWith('_ref')) n = n.slice(0, -'_ref'.length);
    return n
      .split('_')
      .filter((p) => p.length > 0)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }

  function normalize(rawType: string, name: string): string {
    if (rawType === 'user_ref') return 'ref:user';
    if (rawType === 'card_ref') {
      if (name.endsWith('_ref')) return `ref:${name.slice(0, -'_ref'.length)}`;
      return `ref:${name}`; // tags → ref:tags
    }
    return rawType;
  }

  const stub = {
    defs,
    loaded: true,
    defByName(name: string) {
      return defs.find((d) => d.name === name);
    },
    toFilterAttribute(
      name: string,
      refResolver?: (ct: string) => FilterAttributeOption[],
    ): FilterAttribute | null {
      const def = defs.find((d) => d.name === name);
      if (def === undefined) return null;
      const valueType = normalize(def.value_type, def.name);
      const fa: FilterAttribute = {
        name: def.name,
        label: friendly(def.name),
        valueType,
        ops:
          valueType === 'enum' || valueType.startsWith('ref:')
            ? ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists']
            : ['eq', 'ne', 'exists', 'notExists'],
      };
      if (valueType === 'enum' && def.options !== undefined) {
        fa.options = def.options.map((o) => ({
          value: o.value,
          label: o.label,
        }));
      } else if (valueType.startsWith('ref:') && refResolver !== undefined) {
        const ct = valueType.slice('ref:'.length);
        // The production helper looks for `tag` (singular). The seed
        // schema's `tags` attribute is a card_ref to `tag`; this stub
        // mimics that by rewriting the suffix.
        const target = ct === 'tags' ? 'tag' : ct;
        const resolved = refResolver(target);
        if (resolved.length > 0) fa.options = resolved;
      }
      return fa;
    },
  };
  return stub as unknown as AttributeSchemaCache;
}

/* -------------------------------------------------------------------------- */
/* buildRefOptions / buildUserOptions                                          */
/* -------------------------------------------------------------------------- */

describe('buildRefOptions', () => {
  it('prefers title, then name, then #<id>', () => {
    const opts = buildRefOptions(COMPONENTS);
    expect(opts).toEqual([
      { value: 20, label: 'frontend' },
      { value: 21, label: 'backend' },
      { value: 22, label: '#22' },
    ]);
  });

  it('uses path for tag-shaped rows', () => {
    expect(buildRefOptions(TAGS)).toEqual([
      { value: 30, label: 'priority/high' },
      { value: 31, label: 'area/api' },
    ]);
  });
});

describe('buildUserOptions', () => {
  it('maps each user to value=id, label=display_name', () => {
    expect(buildUserOptions(USERS)).toEqual([
      { value: 1, label: 'alice' },
      { value: 2, label: 'bob' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* buildTaskFilterPalette                                                     */
/* -------------------------------------------------------------------------- */

describe('buildTaskFilterPalette', () => {
  it('returns the standard names in the expected order', () => {
    const fa = buildTaskFilterPalette({
      schema: makeStubCache(),
      users: USERS,
      milestones: MILESTONES,
      components: COMPONENTS,
      tags: TAGS,
    });
    expect(fa.map((a) => a.name)).toEqual([
      'status',
      'assignee',
      'milestone_ref',
      'component_ref',
      'tags',
    ]);
  });

  it('normalizes wire types into ref:* and produces friendly labels', () => {
    const fa = buildTaskFilterPalette({
      schema: makeStubCache(),
      users: USERS,
      milestones: MILESTONES,
      components: COMPONENTS,
      tags: TAGS,
    });
    const byName = Object.fromEntries(fa.map((a) => [a.name, a]));
    expect(byName['status']).toMatchObject({
      valueType: 'enum',
      label: 'Status',
    });
    expect(byName['assignee']).toMatchObject({
      valueType: 'ref:user',
      label: 'Assignee',
    });
    expect(byName['milestone_ref']).toMatchObject({
      valueType: 'ref:milestone',
      label: 'Milestone',
    });
    expect(byName['component_ref']).toMatchObject({
      valueType: 'ref:component',
      label: 'Component',
    });
    expect(byName['tags']).toMatchObject({
      label: 'Tags',
    });
  });

  it('populates options for each picker from the supplied row tables', () => {
    const fa = buildTaskFilterPalette({
      schema: makeStubCache(),
      users: USERS,
      milestones: MILESTONES,
      components: COMPONENTS,
      tags: TAGS,
    });
    const byName = Object.fromEntries(fa.map((a) => [a.name, a]));
    expect(byName['status']?.options).toEqual([
      { value: 'todo', label: 'To do' },
      { value: 'doing', label: 'Doing' },
      { value: 'done', label: 'Done' },
    ]);
    expect(byName['assignee']?.options).toEqual([
      { value: 1, label: 'alice' },
      { value: 2, label: 'bob' },
    ]);
    expect(byName['milestone_ref']?.options).toEqual([
      { value: 10, label: 'M1' },
      { value: 11, label: 'M2' },
    ]);
    expect(byName['component_ref']?.options).toEqual([
      { value: 20, label: 'frontend' },
      { value: 21, label: 'backend' },
      { value: 22, label: '#22' },
    ]);
    expect(byName['tags']?.options).toEqual([
      { value: 30, label: 'priority/high' },
      { value: 31, label: 'area/api' },
    ]);
  });

  it('returns [] until the schema cache loads', () => {
    const stub = makeStubCache();
    (stub as unknown as { loaded: boolean }).loaded = false;
    expect(
      buildTaskFilterPalette({
        schema: stub,
        users: USERS,
        milestones: MILESTONES,
        components: COMPONENTS,
        tags: TAGS,
      }),
    ).toEqual([]);
  });

  it('honours an explicit `names` override', () => {
    const fa = buildTaskFilterPalette({
      schema: makeStubCache(),
      users: USERS,
      milestones: MILESTONES,
      components: COMPONENTS,
      names: ['assignee', 'status'],
    });
    expect(fa.map((a) => a.name)).toEqual(['assignee', 'status']);
  });
});

/* -------------------------------------------------------------------------- */
/* resolveAttributeLabel                                                      */
/* -------------------------------------------------------------------------- */

describe('resolveAttributeLabel', () => {
  const enumAttr: FilterAttribute = {
    name: 'status',
    label: 'Status',
    valueType: 'enum',
    options: [
      { value: 'todo', label: 'To do' },
      { value: 'doing', label: 'Doing' },
    ],
    ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
  };
  const refAttr: FilterAttribute = {
    name: 'milestone_ref',
    label: 'Milestone',
    valueType: 'ref:milestone',
    options: [
      { value: 10, label: 'M1' },
      { value: 11, label: 'M2' },
    ],
    ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
  };

  it('returns the enum option label for a known scalar value', () => {
    expect(resolveAttributeLabel(enumAttr, 'todo')).toBe('To do');
    expect(resolveAttributeLabel(enumAttr, 'doing')).toBe('Doing');
  });

  it('falls back to String(value) for an unknown scalar', () => {
    expect(resolveAttributeLabel(enumAttr, 'archived')).toBe('archived');
  });

  it('renders null/undefined as a dash', () => {
    expect(resolveAttributeLabel(enumAttr, null)).toBe('—');
    expect(resolveAttributeLabel(enumAttr, undefined)).toBe('—');
  });

  it('joins multi values with comma and resolves each', () => {
    expect(resolveAttributeLabel(refAttr, [10, 11])).toBe('M1, M2');
  });

  it('renders empty arrays as a dash', () => {
    expect(resolveAttributeLabel(refAttr, [])).toBe('—');
  });

  it('prefers refOverrides[name] when supplied', () => {
    const overrides = {
      milestone_ref: [{ value: 10, label: 'Quarter 1' }],
    };
    expect(resolveAttributeLabel(refAttr, 10, overrides)).toBe('Quarter 1');
  });

  it('returns String(value) when attr is undefined and no overrides match', () => {
    expect(resolveAttributeLabel(undefined, 42)).toBe('42');
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-surface status label parity                                          */
/* -------------------------------------------------------------------------- */

describe('status label resolution agrees across surfaces', () => {
  // Mirrors how each consumer surface resolves a status value into a
  // visible label. If any of these stops agreeing, the status chip in
  // a list row, the column header in Kanban, the cell in Grid, and the
  // chip in FilterBar will start drifting — exactly the bug this whole
  // refactor exists to prevent.
  const palette = buildTaskFilterPalette({
    schema: makeStubCache(),
    users: USERS,
    milestones: MILESTONES,
    components: COMPONENTS,
    tags: TAGS,
  });
  const statusAttr = palette.find((a) => a.name === 'status');
  const statusOptions = statusAttr?.options;

  it.each([
    ['todo', 'To do'],
    ['doing', 'Doing'],
    ['done', 'Done'],
  ])('value %s resolves to %s on every surface', (value, expected) => {
    // FilterBar chip path (resolveAttributeLabel against palette attr).
    expect(resolveAttributeLabel(statusAttr, value)).toBe(expected);
    // GridScreen `statusOf()` path (same call).
    expect(resolveAttributeLabel(statusAttr, value)).toBe(expected);
    // KanbanScreen `labelFor()` path (palette lookup → resolveAttributeLabel).
    const fa = palette.find((a) => a.name === 'status');
    expect(resolveAttributeLabel(fa, value)).toBe(expected);
    // TaskRow `statusText` path (caller passes statusOptions, row finds match).
    const opt = statusOptions?.find((o) => o.value === value);
    expect(opt?.label).toBe(expected);
  });
});

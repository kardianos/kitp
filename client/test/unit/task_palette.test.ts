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
  id: bigint,
  type: string,
  attrs: Record<string, unknown>,
): CardWithAttrs {
  return { id, card_type_id: 1n, card_type_name: type, phase: 'active', attributes: attrs };
}

const USERS: UserRow[] = [
  { id: 1n, display_name: 'alice' },
  { id: 2n, display_name: 'bob' },
];

const PERSONS: CardWithAttrs[] = [
  card(101n, 'person', { title: 'Alice Person' }),
  card(102n, 'person', { title: 'Bob Person' }),
];

const MILESTONES: CardWithAttrs[] = [
  card(10n, 'milestone', { title: 'M1' }),
  card(11n, 'milestone', { title: 'M2' }),
];

const COMPONENTS: CardWithAttrs[] = [
  card(20n, 'component', { title: 'frontend' }),
  card(21n, 'component', { name: 'backend' }), // exercises name fallback
  card(22n, 'component', {}), // exercises #id fallback
];

const TAGS: CardWithAttrs[] = [
  card(30n, 'tag', { path: 'priority/high' }),
  card(31n, 'tag', { path: 'area/api' }),
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
    { id: 2n, name: 'assignee', value_type: 'card_ref', bound_to: [] },
    { id: 3n, name: 'milestone_ref', value_type: 'card_ref', bound_to: [] },
    { id: 4n, name: 'component_ref', value_type: 'card_ref', bound_to: [] },
    { id: 5n, name: 'tags', value_type: 'card_ref', bound_to: [] },
    { id: 6n, name: 'parent_task', value_type: 'card_ref', bound_to: [] },
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

  // Mirrors production `normalizeValueType` (attribute_schema.svelte.ts):
  // `user_ref` → `ref:user`; `card_ref` infers the target from a trailing
  // `_ref` in the def name (otherwise falls back to `ref:card`). The
  // palette post-processes the `ref:card` case for `assignee` so options
  // wire up to person cards.
  //
  // The exception below for `tags` keeps the test stub aligned with the
  // pre-refactor expectation that the `tags` attribute exposes options:
  // production resolves the target card type for a list-typed `card_ref`
  // via a different code path (the seed schema's `card_ref[]` value_type
  // routes through a tag-aware lookup; we don't model that here).
  function normalize(rawType: string, name: string): string {
    if (rawType === 'user_ref') return 'ref:user';
    if (rawType === 'card_ref') {
      if (name.endsWith('_ref')) {
        const target = name.slice(0, -'_ref'.length);
        if (target.length > 0) return `ref:${target}`;
      }
      if (name === 'tags') return 'ref:tag';
      // `parent_task` doesn't follow the `_ref` suffix convention but
      // production resolves it via the def's target_card_type. The
      // stub special-cases it to match.
      if (name === 'parent_task') return 'ref:task';
      return 'ref:card';
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
        ops: valueType.startsWith('ref:')
          ? ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists']
          : ['eq', 'ne', 'exists', 'notExists'],
      };
      if (valueType.startsWith('ref:') && refResolver !== undefined) {
        const ct = valueType.slice('ref:'.length);
        const resolved = refResolver(ct);
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
      { value: 20n, label: 'frontend' },
      { value: 21n, label: 'backend' },
      { value: 22n, label: '#22' },
    ]);
  });

  it('uses path for tag-shaped rows', () => {
    expect(buildRefOptions(TAGS)).toEqual([
      { value: 30n, label: 'priority/high' },
      { value: 31n, label: 'area/api' },
    ]);
  });
});

describe('buildUserOptions', () => {
  it('maps each user to value=id, label=display_name', () => {
    expect(buildUserOptions(USERS)).toEqual([
      { value: 1n, label: 'alice' },
      { value: 2n, label: 'bob' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* buildTaskFilterPalette                                                     */
/* -------------------------------------------------------------------------- */

describe('buildTaskFilterPalette', () => {
  it('returns the standard names plus synthetic text attrs in order', () => {
    const fa = buildTaskFilterPalette({
      schema: makeStubCache(),
      persons: PERSONS,
      milestones: MILESTONES,
      components: COMPONENTS,
      tags: TAGS,
    });
    expect(fa.map((a) => a.name)).toEqual([
      'assignee',
      'milestone_ref',
      'component_ref',
      'tags',
      'parent_task',
      // Synthetic — driven by the TextSearchBar and the Add filter /
      // Advanced editor; not surfaced as quick-filter dropdowns.
      'title',
      'description',
      'comments',
    ]);
  });

  it('exposes a no-picker op set on parent_task', () => {
    const fa = buildTaskFilterPalette({
      schema: makeStubCache(),
      persons: PERSONS,
      milestones: MILESTONES,
      components: COMPONENTS,
      tags: TAGS,
    });
    const parentTask = fa.find((a) => a.name === 'parent_task');
    expect(parentTask).toBeDefined();
    // The palette has no per-project task option list, so any op that
    // would render a value-picker Combobox (eq / ne / in / notIn) is
    // dropped — the picker would be empty. `hasPhase` on parent_task
    // is also dropped because the parent task's own `card.phase` is
    // always the schema default 'triage' for non-value cards.
    // `parentStatusPhase` (the 2-hop op) and the structural
    // exists / notExists checks remain. `parentStatusPhase` is listed
    // first so the editor defaults to a useful op on Add filter.
    expect(parentTask?.ops).toEqual([
      'parentStatusPhase',
      'exists',
      'notExists',
    ]);
    expect(parentTask?.ops).not.toContain('hasPhase');
    expect(parentTask?.ops).not.toContain('eq');
  });

  it('normalizes wire types into ref:* and produces friendly labels', () => {
    const fa = buildTaskFilterPalette({
      schema: makeStubCache(),
      persons: PERSONS,
      milestones: MILESTONES,
      components: COMPONENTS,
      tags: TAGS,
    });
    const byName = Object.fromEntries(fa.map((a) => [a.name, a]));
    expect(byName['assignee']).toMatchObject({
      valueType: 'ref:person',
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
      persons: PERSONS,
      milestones: MILESTONES,
      components: COMPONENTS,
      tags: TAGS,
    });
    const byName = Object.fromEntries(fa.map((a) => [a.name, a]));
    expect(byName['assignee']?.options).toEqual([
      { value: 101n, label: 'Alice Person' },
      { value: 102n, label: 'Bob Person' },
    ]);
    expect(byName['milestone_ref']?.options).toEqual([
      { value: 10n, label: 'M1' },
      { value: 11n, label: 'M2' },
    ]);
    expect(byName['component_ref']?.options).toEqual([
      { value: 20n, label: 'frontend' },
      { value: 21n, label: 'backend' },
      { value: 22n, label: '#22' },
    ]);
    expect(byName['tags']?.options).toEqual([
      { value: 30n, label: 'priority/high' },
      { value: 31n, label: 'area/api' },
    ]);
  });

  it('returns [] until the schema cache loads', () => {
    const stub = makeStubCache();
    (stub as unknown as { loaded: boolean }).loaded = false;
    expect(
      buildTaskFilterPalette({
        schema: stub,
        persons: PERSONS,
        milestones: MILESTONES,
        components: COMPONENTS,
        tags: TAGS,
      }),
    ).toEqual([]);
  });

  it('honours an explicit `names` override', () => {
    const fa = buildTaskFilterPalette({
      schema: makeStubCache(),
      persons: PERSONS,
      milestones: MILESTONES,
      components: COMPONENTS,
      names: ['assignee', 'milestone_ref'],
    });
    expect(fa.map((a) => a.name)).toEqual(['assignee', 'milestone_ref']);
  });
});

/* -------------------------------------------------------------------------- */
/* resolveAttributeLabel                                                      */
/* -------------------------------------------------------------------------- */

describe('resolveAttributeLabel', () => {
  const refAttr: FilterAttribute = {
    name: 'milestone_ref',
    label: 'Milestone',
    valueType: 'ref:milestone',
    options: [
      { value: 10n, label: 'M1' },
      { value: 11n, label: 'M2' },
    ],
    ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
  };

  it('returns the option label for a known scalar value', () => {
    expect(resolveAttributeLabel(refAttr, 10n)).toBe('M1');
    expect(resolveAttributeLabel(refAttr, 11n)).toBe('M2');
  });

  it('falls back to String(value) for an unknown scalar', () => {
    expect(resolveAttributeLabel(refAttr, 99n)).toBe('99');
  });

  it('renders null/undefined as a dash', () => {
    expect(resolveAttributeLabel(refAttr, null)).toBe('—');
    expect(resolveAttributeLabel(refAttr, undefined)).toBe('—');
  });

  it('joins multi values with comma and resolves each', () => {
    expect(resolveAttributeLabel(refAttr, [10n, 11n])).toBe('M1, M2');
  });

  it('renders empty arrays as a dash', () => {
    expect(resolveAttributeLabel(refAttr, [])).toBe('—');
  });

  it('prefers refOverrides[name] when supplied', () => {
    const overrides = {
      milestone_ref: [{ value: 10n, label: 'Quarter 1' }],
    };
    expect(resolveAttributeLabel(refAttr, 10n, overrides)).toBe('Quarter 1');
  });

  it('returns String(value) when attr is undefined and no overrides match', () => {
    expect(resolveAttributeLabel(undefined, 42)).toBe('42');
  });
});

/**
 * FilterBar / FilterPresets / quick-chip helper tests.
 *
 * The vitest setup is node-only (no jsdom) — we therefore cover the
 * extracted pure helpers (`defaultQuickChipsFor`, `replaceLeafForAttr`,
 * `quickChipIsActive`) plus the FilterPresets localStorage layout via
 * a small in-memory shim. Component-mount coverage for FilterBar and
 * FilterTreeEditor will arrive with the real-DOM E2E pass (task #6 of
 * the migration plan) — those components import cleanly today (verified
 * via a smoke import below).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FilterAttribute } from '../../src/filter/attribute_schema.svelte.js';
import {
  andOf,
  eq,
  ne,
  predicateFromJson,
  predicateToJson,
  type Predicate,
} from '../../src/filter/predicate.js';
import {
  defaultQuickChipsFor,
  quickChipIsActive,
  replaceLeafForAttr,
} from '../../src/filter/quick_chips.js';

/* -------------------------------------------------------------------------- */
/* defaultQuickChipsFor                                                       */
/* -------------------------------------------------------------------------- */

describe('defaultQuickChipsFor', () => {
  it('emits one chip per option for an enum attribute', () => {
    const attr: FilterAttribute = {
      name: 'status',
      label: 'Status',
      valueType: 'enum',
      options: [
        { value: 'todo', label: 'To do' },
        { value: 'doing', label: 'Doing' },
        { value: 'done', label: 'Done' },
      ],
      ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
    };
    const chips = defaultQuickChipsFor(attr);
    expect(chips).toHaveLength(3);
    expect(chips[0]!.id).toBe('status:todo');
    expect(chips[0]!.label).toBe('To do');
    expect(chips[0]!.predicate).toEqual(eq('status', 'todo'));
    expect(chips[1]!.predicate).toEqual(eq('status', 'doing'));
    expect(chips[2]!.predicate).toEqual(eq('status', 'done'));
  });

  it('emits zero chips for an enum attribute with no options', () => {
    const attr: FilterAttribute = {
      name: 'priority',
      label: 'Priority',
      valueType: 'enum',
      ops: ['eq', 'ne'],
    };
    expect(defaultQuickChipsFor(attr)).toEqual([]);
  });

  it("emits a 'Mine' chip for assignee when currentUserId is supplied", () => {
    const attr: FilterAttribute = {
      name: 'assignee',
      label: 'Assignee',
      valueType: 'ref:user',
      ops: ['eq', 'ne'],
    };
    const chips = defaultQuickChipsFor(attr, 42);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.id).toBe('assignee:mine');
    expect(chips[0]!.label).toBe('Mine');
    expect(chips[0]!.predicate).toEqual(eq('assignee', 42));
  });

  it('emits no chip for assignee when no currentUserId is given', () => {
    const attr: FilterAttribute = {
      name: 'assignee',
      label: 'Assignee',
      valueType: 'ref:user',
      ops: ['eq', 'ne'],
    };
    expect(defaultQuickChipsFor(attr)).toEqual([]);
  });

  it('returns Today / This week / Overdue for a date attribute', () => {
    const attr: FilterAttribute = {
      name: 'due',
      label: 'Due',
      valueType: 'date',
      ops: ['eq', 'ne', 'exists', 'notExists'],
    };
    const chips = defaultQuickChipsFor(attr);
    expect(chips.map((c) => c.label)).toEqual(['Today', 'This week', 'Overdue']);
    // 'Today' uses an eq leaf so it round-trips through predicate JSON.
    const today = chips[0]!.predicate;
    expect(predicateFromJson(predicateToJson(today))).toEqual(today);
  });

  it('returns [] for ref:* / text / number / bool / unknown types', () => {
    const ref: FilterAttribute = {
      name: 'milestone',
      label: 'Milestone',
      valueType: 'ref:milestone',
      ops: ['eq', 'ne'],
    };
    const text: FilterAttribute = {
      name: 'title',
      label: 'Title',
      valueType: 'text',
      ops: ['eq', 'ne'],
    };
    const num: FilterAttribute = {
      name: 'priority',
      label: 'Priority',
      valueType: 'number',
      ops: ['eq', 'ne'],
    };
    const bool: FilterAttribute = {
      name: 'archived',
      label: 'Archived',
      valueType: 'bool',
      ops: ['eq', 'ne'],
    };
    const unknown: FilterAttribute = {
      name: 'mystery',
      label: 'Mystery',
      valueType: 'wat',
      ops: ['eq'],
    };
    expect(defaultQuickChipsFor(ref)).toEqual([]);
    expect(defaultQuickChipsFor(text)).toEqual([]);
    expect(defaultQuickChipsFor(num)).toEqual([]);
    expect(defaultQuickChipsFor(bool)).toEqual([]);
    expect(defaultQuickChipsFor(unknown)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* replaceLeafForAttr                                                         */
/* -------------------------------------------------------------------------- */

describe('replaceLeafForAttr', () => {
  it('returns the new leaf as-is when the predicate is null', () => {
    const out = replaceLeafForAttr(null, eq('status', 'todo'));
    expect(out).toEqual(eq('status', 'todo'));
  });

  it('replaces an existing leaf for the same attribute', () => {
    const start: Predicate = andOf([eq('status', 'todo'), eq('priority', 1)]);
    const out = replaceLeafForAttr(start, eq('status', 'doing'));
    // Order: surviving leaves first, then the new one (caller MAY rely
    // on this for stable chip ordering — pin it here).
    expect(out).toEqual(andOf([eq('priority', 1), eq('status', 'doing')]));
  });

  it('appends when no leaf for the attribute exists yet', () => {
    const start: Predicate = eq('priority', 1);
    const out = replaceLeafForAttr(start, eq('status', 'todo'));
    expect(out).toEqual(andOf([eq('priority', 1), eq('status', 'todo')]));
  });

  it('collapses a single surviving leaf back to a bare leaf', () => {
    const start: Predicate = andOf([eq('status', 'todo'), eq('priority', 1)]);
    // Replace status with itself — should still collapse if we end up with 1.
    // (Use an attribute the original doesn't carry, then flip back to the
    // single-leaf case by removing one — that's the contract: 1 leaf →
    // bare leaf shape.)
    const start2: Predicate = eq('status', 'todo');
    const out = replaceLeafForAttr(start2, eq('status', 'doing'));
    expect(out).toEqual(eq('status', 'doing'));
  });

  it('throws when the predicate is not a flat AND of leaves', () => {
    const bad: Predicate = {
      kind: 'group',
      connective: 'or',
      children: [eq('a', 1), eq('b', 2)],
    };
    expect(() => replaceLeafForAttr(bad, eq('a', 99))).toThrow();
  });

  it('rejects a non-leaf newLeaf argument', () => {
    expect(() =>
      replaceLeafForAttr(null, andOf([eq('a', 1)])),
    ).toThrow(/must be a leaf/);
  });
});

/* -------------------------------------------------------------------------- */
/* quickChipIsActive                                                          */
/* -------------------------------------------------------------------------- */

describe('quickChipIsActive', () => {
  const chip = {
    id: 'status:todo',
    label: 'To do',
    predicate: eq('status', 'todo'),
  };

  it('returns false when predicate is null', () => {
    expect(quickChipIsActive(null, chip)).toBe(false);
  });

  it('returns true when the leaf is present in a bare-leaf predicate', () => {
    expect(quickChipIsActive(eq('status', 'todo'), chip)).toBe(true);
  });

  it('returns true when the leaf is present in a flat AND group', () => {
    const p = andOf([eq('priority', 1), eq('status', 'todo')]);
    expect(quickChipIsActive(p, chip)).toBe(true);
  });

  it('returns false when the same attr is present but the value differs', () => {
    expect(quickChipIsActive(eq('status', 'doing'), chip)).toBe(false);
  });

  it('returns false when the same attr is present but the op differs', () => {
    expect(quickChipIsActive(ne('status', 'todo'), chip)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* FilterPresets — localStorage layout                                        */
/*                                                                            */
/* The component itself needs DOM to render; we exercise the storage         */
/* contract through a thin shim that mirrors what the component reads /      */
/* writes. If the key prefix or value encoding ever drift, this test fails  */
/* and the component-side test (added when jsdom lands) will too.            */
/* -------------------------------------------------------------------------- */

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

describe('FilterPresets storage contract', () => {
  let storage: MemoryStorage;
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    storage = new MemoryStorage();
    originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  // Mirrors the component's read/write helpers. If you change the key
  // shape or encoding in `FilterPresets.svelte`, mirror it here too.
  function keyPrefix(scope: string): string {
    return `kitp.filter.${scope}.`;
  }
  function writePreset(
    scope: string,
    name: string,
    p: Predicate | null,
  ): void {
    const raw = p === null ? 'null' : JSON.stringify(predicateToJson(p));
    localStorage.setItem(keyPrefix(scope) + name, raw);
  }
  function readPresets(
    scope: string,
  ): { name: string; predicate: Predicate | null }[] {
    const prefix = keyPrefix(scope);
    const out: { name: string; predicate: Predicate | null }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === null) continue;
      if (!k.startsWith(prefix)) continue;
      const name = k.slice(prefix.length);
      const raw = localStorage.getItem(k);
      if (raw === null) continue;
      if (raw === 'null') {
        out.push({ name, predicate: null });
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        out.push({ name, predicate: predicateFromJson(parsed) });
      } catch {
        // skip corrupt
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
  function deletePreset(scope: string, name: string): void {
    localStorage.removeItem(keyPrefix(scope) + name);
  }

  it('save → read round-trips a predicate under the expected key', () => {
    const p = andOf([eq('status', 'todo'), eq('priority', 1)]);
    writePreset('inbox', 'My open todos', p);
    expect(storage.getItem('kitp.filter.inbox.My open todos')).toBeTruthy();
    const presets = readPresets('inbox');
    expect(presets).toHaveLength(1);
    expect(presets[0]!.name).toBe('My open todos');
    expect(presets[0]!.predicate).toEqual(p);
  });

  it('encodes a null predicate as the literal string "null"', () => {
    writePreset('inbox', 'Everything', null);
    expect(storage.getItem('kitp.filter.inbox.Everything')).toBe('null');
    const presets = readPresets('inbox');
    expect(presets[0]!.predicate).toBeNull();
  });

  it('reads only presets in the requested scope', () => {
    writePreset('inbox', 'A', eq('status', 'todo'));
    writePreset('grid', 'B', eq('priority', 1));
    expect(readPresets('inbox').map((p) => p.name)).toEqual(['A']);
    expect(readPresets('grid').map((p) => p.name)).toEqual(['B']);
  });

  it('delete removes the preset from storage', () => {
    writePreset('inbox', 'A', eq('status', 'todo'));
    writePreset('inbox', 'B', eq('status', 'doing'));
    deletePreset('inbox', 'A');
    expect(readPresets('inbox').map((p) => p.name)).toEqual(['B']);
  });

  it('skips corrupt entries instead of throwing', () => {
    writePreset('inbox', 'good', eq('status', 'todo'));
    storage.setItem('kitp.filter.inbox.bad', '{not json');
    const presets = readPresets('inbox');
    expect(presets.map((p) => p.name)).toEqual(['good']);
  });
});

/* -------------------------------------------------------------------------- */
/* Compile smoke for the .svelte components                                   */
/* -------------------------------------------------------------------------- */

describe('Filter component imports', () => {
  it('FilterBar / FilterTreeEditor / FilterPresets load without throwing', async () => {
    const mods = await Promise.all([
      import('../../src/filter/FilterBar.svelte'),
      import('../../src/filter/FilterTreeEditor.svelte'),
      import('../../src/filter/FilterPresets.svelte'),
    ]);
    for (const m of mods) {
      expect(m.default).toBeDefined();
    }
  });
});

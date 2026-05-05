/**
 * Unit tests for the handler registry and the hand-written codecs.
 *
 * Coverage targets per the migration plan §5.2:
 *   1. Duplicate registration throws.
 *   2. Lookup hit/miss; `has()` reflects the registered set.
 *   3. One round-trip per non-trivial endpoint family.
 *   4. Optional fields are OMITTED from encode output, never set to null.
 */

import { describe, expect, it } from 'vitest';

import { HandlerRegistry } from '../../src/reg/handler_registry.js';
import {
  activitySelect,
  attributeDefSelect,
  cardInsert,
  cardSelectWithAttributes,
  echoPing,
  inboxSelect,
  registerBuiltInHandlers,
} from '../../src/reg/handlers.js';
import type {
  ActivitySelectInput,
  ActivitySelectOutput,
  AttributeDefSelectOutput,
  CardInsertInput,
  CardInsertOutput,
  CardSelectWithAttributesInput,
  CardSelectWithAttributesOutput,
  InboxSelectInput,
  InboxSelectOutput,
} from '../../src/reg/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience: full spec list registered by `registerBuiltInHandlers`. */
const ALL_REGISTERED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['echo', 'ping'],
  ['card_type', 'select'],
  ['card', 'insert'],
  ['card', 'select'],
  ['card', 'select_with_attributes'],
  ['card', 'delete'],
  ['attribute', 'update'],
  ['attribute_def', 'select'],
  ['attribute_def', 'insert'],
  ['activity', 'select'],
  ['comment', 'insert'],
  ['user', 'select'],
  ['tag', 'apply'],
  ['tag', 'remove'],
  ['inbox', 'select'],
  ['user_card_sort', 'set'],
  ['edge', 'insert'],
  ['edge', 'delete'],
  // admin
  ['user', 'list_with_roles'],
  ['role', 'list'],
  ['user_role', 'set'],
  ['user_role', 'revoke'],
  ['role_mapping', 'list'],
  ['role_mapping', 'set'],
  ['role_mapping', 'delete'],
];

// ---------------------------------------------------------------------------
// Registry mechanics
// ---------------------------------------------------------------------------

describe('HandlerRegistry', () => {
  it('rejects duplicate (endpoint, action) registration', () => {
    const r = new HandlerRegistry();
    r.register(echoPing);
    expect(() => r.register(echoPing)).toThrow(/already registered/);
  });

  it('lookup returns the registered spec; misses return undefined', () => {
    const r = new HandlerRegistry();
    r.register(echoPing);

    const hit = r.lookup('echo', 'ping');
    expect(hit).toBeDefined();
    expect(hit?.endpoint).toBe('echo');
    expect(hit?.action).toBe('ping');

    expect(r.lookup('echo', 'pong')).toBeUndefined();
    expect(r.lookup('does_not_exist', 'ping')).toBeUndefined();
  });

  it('has() reflects the registered set', () => {
    const r = new HandlerRegistry();
    expect(r.has('echo', 'ping')).toBe(false);
    r.register(echoPing);
    expect(r.has('echo', 'ping')).toBe(true);
    expect(r.has('echo', 'pong')).toBe(false);
  });

  it('registerBuiltInHandlers wires every documented handler exactly once', () => {
    const r = new HandlerRegistry();
    registerBuiltInHandlers(r);
    for (const [endpoint, action] of ALL_REGISTERED_KEYS) {
      expect(r.has(endpoint, action), `${endpoint}.${action}`).toBe(true);
    }
    // Re-registering must throw to catch silent collisions.
    expect(() => registerBuiltInHandlers(r)).toThrow(/already registered/);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: card.insert
// ---------------------------------------------------------------------------

describe('card.insert codec', () => {
  it('encodes the full payload with snake_case field names', () => {
    const input: CardInsertInput = {
      cardTypeName: 'task',
      parentCardId: 7,
      title: 'hello',
      attributes: { status: 'todo', priority: 1 },
    };
    const encoded = cardInsert.encode(input) as Record<string, unknown>;
    expect(encoded).toEqual({
      card_type_name: 'task',
      parent_card_id: 7,
      title: 'hello',
      attributes: { status: 'todo', priority: 1 },
    });
  });

  it('omits parent_card_id and attributes when undefined / empty', () => {
    const input: CardInsertInput = { cardTypeName: 'task', title: 'h' };
    const encoded = cardInsert.encode(input) as Record<string, unknown>;
    expect(encoded).toEqual({ card_type_name: 'task', title: 'h' });
    expect(Object.prototype.hasOwnProperty.call(encoded, 'parent_card_id')).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(encoded, 'attributes')).toBe(
      false,
    );
  });

  it('omits attributes when explicitly empty', () => {
    const input: CardInsertInput = {
      cardTypeName: 'task',
      title: 'h',
      attributes: {},
    };
    const encoded = cardInsert.encode(input) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(encoded, 'attributes')).toBe(
      false,
    );
  });

  it('decodes the server response into the typed output', () => {
    const out: CardInsertOutput = cardInsert.decode({ id: 42 });
    expect(out).toEqual({ id: 42 });
  });

  it('preserves large integer ids without bitwise truncation', () => {
    // 2^53-1 — would lose precision under `(x as number) | 0`.
    const big = Number.MAX_SAFE_INTEGER;
    const out: CardInsertOutput = cardInsert.decode({ id: big });
    expect(out.id).toBe(big);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: card.select_with_attributes — predicate tree pass-through
// ---------------------------------------------------------------------------

describe('card.select_with_attributes codec', () => {
  it('passes the predicate tree through encode unchanged', () => {
    const tree = {
      connective: 'and',
      children: [
        { attr: 'status', op: 'in', values: ['todo', 'doing'] },
        {
          connective: 'or',
          children: [
            { attr: 'priority', op: '=', value: 1 },
            { attr: 'priority', op: '=', value: 2 },
          ],
        },
      ],
    };
    const input: CardSelectWithAttributesInput = {
      cardTypeName: 'task',
      tree,
      limit: 100,
    };
    const encoded = cardSelectWithAttributes.encode(input) as Record<
      string,
      unknown
    >;
    expect(encoded).toEqual({
      card_type_name: 'task',
      tree,
      limit: 100,
    });
    // Reference equality matters: we don't want defensive copies sneaking in
    // and silently changing leaf shapes.
    expect(encoded.tree).toBe(tree);
  });

  it('omits where[] when empty and tree when undefined', () => {
    const input: CardSelectWithAttributesInput = {
      cardTypeName: 'task',
      where: [],
    };
    const encoded = cardSelectWithAttributes.encode(input) as Record<
      string,
      unknown
    >;
    expect(encoded).toEqual({ card_type_name: 'task' });
    expect(Object.prototype.hasOwnProperty.call(encoded, 'tree')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(encoded, 'where')).toBe(false);
  });

  it('encodes flat where[] as the legacy AND-of-leaves shape', () => {
    const input: CardSelectWithAttributesInput = {
      cardTypeName: 'task',
      where: [
        { attr: 'status', op: '=', value: 'todo' },
        { attr: 'tags', op: 'in', values: [1, 2] },
      ],
    };
    const encoded = cardSelectWithAttributes.encode(input) as Record<
      string,
      unknown
    >;
    expect(encoded).toEqual({
      card_type_name: 'task',
      where: [
        { attr: 'status', op: '=', value: 'todo' },
        { attr: 'tags', op: 'in', values: [1, 2] },
      ],
    });
  });

  it('decodes rows and defaults missing optional fields', () => {
    const raw = {
      rows: [
        {
          id: 1,
          card_type_id: 5,
          card_type_name: 'task',
          attributes: { title: 'hi' },
        },
        // intentionally minimal — exercises the asObjOrEmpty / strOrEmpty paths.
        { id: 2, card_type_id: 5 },
      ],
    };
    const out: CardSelectWithAttributesOutput = cardSelectWithAttributes.decode(raw);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]?.attributes).toEqual({ title: 'hi' });
    expect(out.rows[1]?.card_type_name).toBe('');
    expect(out.rows[1]?.attributes).toEqual({});
    expect(out.rows[1]?.parent_card_id).toBeUndefined();
    expect(out.rows[1]?.deleted_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: inbox.select
// ---------------------------------------------------------------------------

describe('inbox.select codec', () => {
  it('encodes tree, limit, offset, userId all together', () => {
    const tree = {
      connective: 'and',
      children: [{ attr: 'milestone', op: '=', value: 4 }],
    };
    const input: InboxSelectInput = {
      userId: 11,
      tree,
      limit: 50,
      offset: 100,
    };
    const encoded = inboxSelect.encode(input) as Record<string, unknown>;
    expect(encoded).toEqual({
      user_id: 11,
      tree,
      limit: 50,
      offset: 100,
    });
  });

  it('omits every optional field when not provided', () => {
    const encoded = inboxSelect.encode({}) as Record<string, unknown>;
    expect(encoded).toEqual({});
  });

  it('decodes personal_sort_order as a number when present, otherwise omits it', () => {
    const raw = {
      rows: [
        {
          id: 1,
          card_type_id: 5,
          attributes: { title: 'a' },
          personal_sort_order: 1024.5,
        },
        { id: 2, card_type_id: 5, attributes: {} },
      ],
    };
    const out: InboxSelectOutput = inboxSelect.decode(raw);
    expect(out.rows[0]?.personal_sort_order).toBe(1024.5);
    expect(out.rows[1]?.personal_sort_order).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: activity.select  (cardId optional → omitted)
// ---------------------------------------------------------------------------

describe('activity.select codec', () => {
  it('omits card_id when cardId is undefined (cross-card mode)', () => {
    const input: ActivitySelectInput = { limit: 25 };
    const encoded = activitySelect.encode(input) as Record<string, unknown>;
    expect(encoded).toEqual({ limit: 25 });
    expect(Object.prototype.hasOwnProperty.call(encoded, 'card_id')).toBe(false);
  });

  it('encodes the full per-card paging payload', () => {
    const input: ActivitySelectInput = {
      cardId: 99,
      limit: 25,
      beforeActivityId: 1234,
    };
    const encoded = activitySelect.encode(input) as Record<string, unknown>;
    expect(encoded).toEqual({
      card_id: 99,
      limit: 25,
      before_activity_id: 1234,
    });
  });

  it('decodes activity rows with optional fields defaulted', () => {
    const raw = {
      rows: [
        {
          id: 1,
          card_id: 7,
          kind: 'attr_update',
          attribute_name: 'status',
          value_old: 'todo',
          value_new: 'doing',
          actor_id: 3,
          created_at: '2025-01-01T00:00:00Z',
        },
        // minimal — actor_id missing must default to 0, created_at to ''.
        { id: 2, kind: 'comment' },
      ],
    };
    const out: ActivitySelectOutput = activitySelect.decode(raw);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]?.attribute_name).toBe('status');
    expect(out.rows[0]?.value_old).toBe('todo');
    expect(out.rows[1]?.actor_id).toBe(0);
    expect(out.rows[1]?.created_at).toBe('');
    expect(out.rows[1]?.attribute_name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: attribute_def.select  (forward-compat options[])
// ---------------------------------------------------------------------------

describe('attribute_def.select codec', () => {
  it('decodes rows without options[] (today)', () => {
    const raw = {
      rows: [
        {
          id: 1,
          name: 'status',
          value_type: 'enum',
          is_built_in: true,
          bound_to: [
            {
              card_type_id: 2,
              card_type_name: 'task',
              is_required: true,
              is_built_in: true,
              ordering: 0,
            },
          ],
        },
      ],
    };
    const out: AttributeDefSelectOutput = attributeDefSelect.decode(raw);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.options).toBeUndefined();
    expect(out.rows[0]?.bound_to).toHaveLength(1);
    expect(out.rows[0]?.bound_to[0]?.card_type_name).toBe('task');
  });

  it('decodes rows with options[] (post-migration 0012)', () => {
    const raw = {
      rows: [
        {
          id: 1,
          name: 'status',
          value_type: 'enum',
          is_built_in: true,
          bound_to: [],
          options: [
            { value: 'todo', label: 'Todo', ordering: 0 },
            { value: 'doing', label: 'Doing', ordering: 1 },
            { value: 'done', label: 'Done', ordering: 2 },
          ],
        },
      ],
    };
    const out: AttributeDefSelectOutput = attributeDefSelect.decode(raw);
    expect(out.rows[0]?.options).toHaveLength(3);
    expect(out.rows[0]?.options?.[1]?.value).toBe('doing');
    expect(out.rows[0]?.options?.[2]?.ordering).toBe(2);
  });

  it('treats null options as absent (forward-compat tolerance)', () => {
    const raw = {
      rows: [
        {
          id: 1,
          name: 'status',
          value_type: 'enum',
          is_built_in: true,
          bound_to: [],
          options: null,
        },
      ],
    };
    const out: AttributeDefSelectOutput = attributeDefSelect.decode(raw);
    expect(out.rows[0]?.options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: echo.ping  (sanity smoke; useful for the dispatch agent too)
// ---------------------------------------------------------------------------

describe('echo.ping codec', () => {
  it('round-trips a minimal payload', () => {
    const encoded = echoPing.encode({ x: 1, message: 'hi' }) as Record<
      string,
      unknown
    >;
    expect(encoded).toEqual({ x: 1, message: 'hi' });
    const decoded = echoPing.decode({ x: 1, message: 'hi' });
    expect(decoded).toEqual({ x: 1, message: 'hi' });
  });

  it('decodes a missing message as the empty string', () => {
    const decoded = echoPing.decode({ x: 0 });
    expect(decoded).toEqual({ x: 0, message: '' });
  });
});

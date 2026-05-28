/**
 * Generic wire codec — the single normalization boundary between the client's
 * camelCase object world and the server's snake_case JSON wire.
 *
 * We own both ends, so the translation is mechanical and lives in ONE place
 * instead of being hand-written per spec:
 *
 *   - encodeWire(value)   camelCase keys → snake_case, bigint → string, drop
 *                     undefined-valued keys. Used as a spec `encode`.
 *   - decodeWire(value) snake_case keys → camelCase. Values pass through
 *                     unchanged (numbers stay numbers, id strings stay
 *                     strings). Used as a spec `decode`.
 *
 * Both recurse through arrays and nested plain objects. They only ever touch
 * KEYS — string VALUES (e.g. a predicate's `attr: "comm_status"`) are never
 * rewritten — so predicate trees and other data round-trip intact.
 *
 * Scope note: this is the keystone of the declarative-data-layer refactor; the
 * comm-channel specs are the first to adopt it (see admin/specs.ts).
 */

/** camelCase → snake_case for a single object key. `imapHost` → `imap_host`. */
export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

/** snake_case → camelCase for a single object key. `imap_host` → `imapHost`. */
export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Encode a camelCase client value to the snake_case wire shape. Recurses
 * arrays + nested objects; converts bigint to its decimal string (the
 * wire convention for ids); omits keys whose value is `undefined` (PATCH
 * semantics — an absent field means "leave unchanged" server-side).
 */
export function encodeWire(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(encodeWire);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[camelToSnake(k)] = encodeWire(v);
    }
    return out;
  }
  return value;
}

/**
 * Decode a snake_case wire value to the camelCase client shape. Recurses
 * arrays + nested objects; leaves all values as-is (an id stays the string
 * the server sent; a port stays a number).
 */
export function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[snakeToCamel(k)] = decodeWire(v);
    }
    return out;
  }
  return value;
}

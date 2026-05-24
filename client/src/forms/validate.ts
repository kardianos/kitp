/**
 * Validation engine for the form kernel.
 *
 * Pure function: given a JSON Schema (the subset the server publishes
 * — see schema/store.svelte.ts and docs/mcp-tags.md v2) and a draft
 * object, returns a `Record<fieldPath, message>` of validation
 * errors. Fields without errors are absent from the returned map.
 *
 * Honours, in roughly this priority order:
 *   - required        — empty / missing top-level fields
 *   - type            — string/integer/number/boolean basic shape
 *   - enum            — value must be in the allowed set
 *   - format          — email, url, json, uuid, date, date-time
 *   - minLength / maxLength on strings
 *   - minimum / maximum on numbers
 *   - pattern         — regex match on strings
 *
 * Field paths use dot notation for nested objects (we don't yet emit
 * indexed paths for array items — none of the current handler input
 * types nest arrays of objects that would need per-item errors).
 *
 * The engine does NOT walk into recursive schemas — those are flagged
 * as `additionalProperties: true` on the server side and treated as
 * opaque here. Callers needing deep validation on a free-form jsonb
 * field can pass `format=json` and the engine will at least check the
 * value parses as JSON.
 */

import type { JSONSchema } from '../reg/types';

export type Errors = Record<string, string>;

/**
 * Top-level entry. `path` is the prefix used when validating a nested
 * object — callers usually pass `''`.
 */
export function validateDraft(schema: JSONSchema | undefined, draft: unknown, path = ''): Errors {
  const errs: Errors = {};
  if (!schema) return errs;

  if (schema.type === 'object' || schema.properties) {
    const obj = (draft ?? {}) as Record<string, unknown>;
    // Required fields first — they short-circuit the other checks for
    // missing values (no point complaining about a string field's
    // pattern when the field is absent and required).
    if (schema.required) {
      for (const key of schema.required) {
        const v = obj[key];
        if (isEmpty(v)) {
          errs[joinPath(path, key)] = `${humanize(key)} is required`;
        }
      }
    }
    // Per-property type/format/length/pattern/enum checks. Skip empty
    // values — they're either covered by the required check above OR
    // intentionally absent on an optional field. isEmpty matches the
    // required-check rule, so '', null, 0n, [] all skip; `false` and
    // numeric 0 still run through (they're valid values, not "missing").
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const v = obj[key];
        if (isEmpty(v)) continue;
        const subPath = joinPath(path, key);
        // Don't overwrite a required-error already recorded for this path.
        if (errs[subPath]) continue;
        const fieldErr = validateValue(propSchema, v, key);
        if (fieldErr) errs[subPath] = fieldErr;
      }
    }
    return errs;
  }

  // Top-level non-object (rare for handler input but harmless).
  const top = validateValue(schema, draft, '');
  if (top) errs[path || '$'] = top;
  return errs;
}

function validateValue(schema: JSONSchema, value: unknown, key: string): string | null {
  const label = humanize(key);

  // Type
  if (schema.type) {
    const wrong = wrongType(schema.type, value);
    if (wrong) return `${label} ${wrong}`;
  }

  // Enum
  if (schema.enum && schema.enum.length > 0) {
    const sv = String(value);
    if (!schema.enum.includes(sv)) {
      return `${label} must be one of ${schema.enum.join(', ')}`;
    }
  }

  // String constraints
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${label} must be at least ${schema.minLength} character${schema.minLength === 1 ? '' : 's'}`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${label} must be at most ${schema.maxLength} character${schema.maxLength === 1 ? '' : 's'}`;
    }
    if (schema.pattern) {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) return `${label} doesn't match the required pattern`;
      } catch {
        // Bad regex from the server is the server's bug; don't crash the client.
      }
    }
    if (schema.format) {
      const fmtErr = checkFormat(schema.format, value, label);
      if (fmtErr) return fmtErr;
    }
  }

  // Numeric constraints
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${label} must be at least ${schema.minimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${label} must be at most ${schema.maximum}`;
    }
  }

  return null;
}

function wrongType(want: NonNullable<JSONSchema['type']>, value: unknown): string | null {
  switch (want) {
    case 'string':
      // bigint passes too: the MCP schema generator emits type:"string"
      // for Go fields tagged `json:",string"` (int64 ids that travel as
      // quoted decimals on the wire). The client stores those as bigint
      // in memory and `stringifyBigInt` converts at serialize time. So
      // bigint is wire-valid for a string-typed slot.
      if (typeof value === 'bigint') return null;
      return typeof value === 'string' ? null : 'must be a string';
    case 'integer':
      // bigint is valid — the client uses bigint for int64 IDs to avoid
      // precision loss; the dispatcher serialises to JSON number on wire.
      if (typeof value === 'bigint') return null;
      return typeof value === 'number' && Number.isInteger(value) ? null : 'must be a whole number';
    case 'number':
      if (typeof value === 'bigint') return null;
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'array':
      return Array.isArray(value) ? null : 'must be a list';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? null
        : 'must be an object';
  }
}

// Format checks — minimal set the form kernel actually needs.
function checkFormat(format: string, value: string, label: string): string | null {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : `${label} must be a valid email`;
    case 'url':
      try {
        new URL(value);
        return null;
      } catch {
        return `${label} must be a valid URL`;
      }
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? null
        : `${label} must be a UUID`;
    case 'json':
      try {
        JSON.parse(value);
        return null;
      } catch {
        return `${label} must be valid JSON`;
      }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : `${label} must be YYYY-MM-DD`;
    case 'date-time':
      // Loose check — the server will reject anything that doesn't round-trip.
      return !isNaN(Date.parse(value)) ? null : `${label} must be a valid date/time`;
  }
  return null;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v === '';
  if (typeof v === 'bigint') return v === 0n;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function joinPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}

// "msgraph_tenant_id" → "Msgraph tenant id". Crude but works for the
// labels the schema's descriptions don't already supply. Forms that
// want nicer labels pass them explicitly on the FormField (TODO: pull
// from schema.description when present).
function humanize(key: string): string {
  if (!key) return 'Value';
  const spaced = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

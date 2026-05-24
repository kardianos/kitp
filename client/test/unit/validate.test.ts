import { describe, it, expect } from 'vitest';
import { validateDraft } from '../../src/forms/validate';
import type { JSONSchema } from '../../src/reg/types';

describe('validateDraft', () => {
  it('returns empty errors for a draft that matches the schema', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    expect(validateDraft(schema, { name: 'ok' })).toEqual({});
  });

  it('flags missing required fields', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string' } },
      required: ['name', 'email'],
    };
    const errs = validateDraft(schema, { name: 'a' });
    expect(errs.email).toMatch(/required/i);
    expect(errs.name).toBeUndefined();
  });

  it('flags empty string as missing for required fields', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    expect(validateDraft(schema, { name: '' }).name).toMatch(/required/i);
  });

  it('honours enum constraints', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { status: { type: 'string', enum: ['enabled', 'disabled-admin'] } },
    };
    expect(validateDraft(schema, { status: 'wat' }).status).toMatch(/must be one of/);
    expect(validateDraft(schema, { status: 'enabled' })).toEqual({});
  });

  it('honours minLength / maxLength on strings', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { slug: { type: 'string', minLength: 3, maxLength: 8 } },
    };
    expect(validateDraft(schema, { slug: 'ab' }).slug).toMatch(/at least 3/);
    expect(validateDraft(schema, { slug: 'abcdefghi' }).slug).toMatch(/at most 8/);
    expect(validateDraft(schema, { slug: 'abcd' })).toEqual({});
  });

  it('honours pattern on strings', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { slug: { type: 'string', pattern: '^[a-z]+$' } },
    };
    expect(validateDraft(schema, { slug: 'AbC' }).slug).toMatch(/pattern/);
    expect(validateDraft(schema, { slug: 'abc' })).toEqual({});
  });

  it('honours minimum / maximum on numbers', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { port: { type: 'integer', minimum: 1, maximum: 65535 } },
    };
    expect(validateDraft(schema, { port: 0 }).port).toMatch(/at least 1/);
    expect(validateDraft(schema, { port: 70000 }).port).toMatch(/at most 65535/);
    expect(validateDraft(schema, { port: 443 })).toEqual({});
  });

  it('honours format=email', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
    };
    expect(validateDraft(schema, { email: 'not-an-email' }).email).toMatch(/email/);
    expect(validateDraft(schema, { email: 'a@b.co' })).toEqual({});
  });

  it('honours format=json', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { filter: { type: 'string', format: 'json' } },
    };
    expect(validateDraft(schema, { filter: '{nope' }).filter).toMatch(/JSON/);
    expect(validateDraft(schema, { filter: '{"op":"and"}' })).toEqual({});
  });

  it('rejects wrong types', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { port: { type: 'integer' } },
    };
    expect(validateDraft(schema, { port: 'not-a-number' }).port).toMatch(/whole number/);
  });

  it('returns no errors when schema is undefined', () => {
    expect(validateDraft(undefined, { anything: 'whatever' })).toEqual({});
  });

  it('treats 0n bigint as empty for required fields', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { attribute_def_id: { type: 'integer' } },
      required: ['attribute_def_id'],
    };
    // 0n is the seeded default for unset bigint IDs in the form kernel —
    // it must read as "missing" so the required check fires.
    expect(validateDraft(schema, { attribute_def_id: 0n }).attribute_def_id).toMatch(/required/i);
    expect(validateDraft(schema, { attribute_def_id: 42n })).toEqual({});
  });

  it('skips property checks when the value is empty AND not required', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
    };
    // Empty/missing optional field — no error.
    expect(validateDraft(schema, {})).toEqual({});
    expect(validateDraft(schema, { email: '' })).toEqual({});
  });
});

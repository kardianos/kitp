/**
 * Unit tests for `sameId` (FE-H3): id equality that is robust to a
 * number / bigint / string mix.
 *
 * The dispatcher revives id-shaped wire fields to bigint, but card_ref
 * *attribute* values only revive once the schema preload has primed
 * `CARD_REF_ATTR_KEYS`. Before that, a card_ref value arrives as a raw
 * JSON number — and `123 === 123n` is `false` in JS, so a picker would
 * silently render "unset". `sameId` closes that gap by canonicalising
 * both sides to a decimal string before comparing.
 */

import { describe, expect, it } from 'vitest';

import { sameId } from '../../src/reg/types';

describe('sameId', () => {
  it('matches a raw number against the equivalent bigint (the FE-H3 case)', () => {
    // The exact failure mode: card_ref attr value un-revived (number)
    // vs. its picker option (bigint).
    expect(sameId(2, 2n)).toBe(true);
    expect(sameId(2n, 2)).toBe(true);
  });

  it('matches a digits string against a number / bigint', () => {
    expect(sameId('42', 42n)).toBe(true);
    expect(sameId('42', 42)).toBe(true);
    expect(sameId(42n, '42')).toBe(true);
  });

  it('matches like-typed ids', () => {
    expect(sameId(7n, 7n)).toBe(true);
    expect(sameId(7, 7)).toBe(true);
    expect(sameId('7', '7')).toBe(true);
  });

  it('distinguishes different ids regardless of representation', () => {
    expect(sameId(2, 3n)).toBe(false);
    expect(sameId('2', 3)).toBe(false);
    expect(sameId(2n, 30n)).toBe(false);
  });

  it('handles negative ids', () => {
    expect(sameId(-5, -5n)).toBe(true);
    expect(sameId(-5, 5n)).toBe(false);
  });

  it('treats null / undefined as equal only to themselves', () => {
    expect(sameId(null, null)).toBe(true);
    expect(sameId(undefined, undefined)).toBe(true);
    expect(sameId(null, undefined)).toBe(false);
    expect(sameId(null, 0n)).toBe(false);
    expect(sameId(0, null)).toBe(false);
  });

  it('falls back to strict equality for non-id values', () => {
    // Non-integral / non-digit strings are not id-shaped; only an exact
    // `===` match counts.
    expect(sameId('foo', 'foo')).toBe(true);
    expect(sameId('foo', 'bar')).toBe(false);
    expect(sameId(1.5, 1.5)).toBe(true);
    // A float never equals an integer id of the "same" magnitude.
    expect(sameId(1.5, '1.5')).toBe(false);
    const obj = {};
    expect(sameId(obj, obj)).toBe(true);
    expect(sameId({}, {})).toBe(false);
  });

  it('does not confuse a digit string with a non-digit lookalike', () => {
    expect(sameId('007', 7)).toBe(false); // "007" canonicalises to "007", not "7"
    expect(sameId('07', 7n)).toBe(false);
  });
});

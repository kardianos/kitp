/**
 * LoadState — the tri-state lifecycle every async-loaded value moves
 * through. These tests pin the constructors, the predicates, and the
 * lifecycle transitions (Unset → Pending → Value, Pending → Error → Value).
 *
 * The structural promise the type enforces: a renderer reads the
 * LIFECYCLE (isPending / isResolved) instead of the raw value, so an
 * in-flight commit doesn't flicker controls between enabled / disabled
 * as the value swings through null / empty.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';

let M;

before(async () => {
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/core.js`);
});

/* -------------------------------------------------------------------------- */

test('LoadState.Unset is the frozen "no value" singleton', () => {
  const { Unset } = M;
  assert.equal(Unset.kind, 'unset');
  assert.throws(() => {
    Unset.kind = 'value'; // attempting to mutate
  });
});

test('LoadState constructors: pendingValue / loaded / errored', () => {
  const { pendingValue, loaded, errored } = M;
  assert.deepEqual(pendingValue(7), { kind: 'pending', value: 7 });
  assert.deepEqual(loaded('hi'), { kind: 'value', value: 'hi' });
  assert.deepEqual(errored('bad', 5), { kind: 'error', value: 5, message: 'bad' });
  // Error with no fallback (e.g. nothing to revert to).
  assert.deepEqual(errored('bad', undefined), { kind: 'error', value: undefined, message: 'bad' });
});

test('LoadState predicates: isUnset / isPending / isResolved / isMixed / isError / hasValue', () => {
  const { Unset, Mixed, pendingValue, loaded, errored, isUnset, isPending, isResolved, isMixed, isError, hasValue } = M;
  assert.equal(isUnset(Unset), true);
  assert.equal(isPending(pendingValue(1)), true);
  assert.equal(isResolved(loaded(1)), true);
  assert.equal(isMixed(Mixed), true);
  assert.equal(isError(errored('x', 1)), true);
  // hasValue: every state with a single displayable content
  assert.equal(hasValue(Unset), false);
  assert.equal(hasValue(pendingValue(1)), true);
  assert.equal(hasValue(loaded(1)), true);
  assert.equal(hasValue(errored('x', 1)), true);
  // Mixed has no single value — renderer should show '[mixed]', not a value.
  assert.equal(hasValue(Mixed), false);
  // Error WITHOUT a fallback has no displayable value
  assert.equal(hasValue(errored('x', undefined)), false);
});

test('LoadState.Mixed singleton is frozen + isMixed identifies it', () => {
  const { Mixed, isMixed, loaded } = M;
  assert.equal(Mixed.kind, 'mixed');
  assert.throws(() => { Mixed.kind = 'value'; });
  assert.equal(isMixed(Mixed), true);
  assert.equal(isMixed(loaded(1)), false);
});

test('valueOf / errorOf extract the right field for each kind', () => {
  const { Unset, pendingValue, loaded, errored, valueOf, errorOf } = M;
  assert.equal(valueOf(Unset), undefined);
  assert.equal(valueOf(pendingValue('a')), 'a');
  assert.equal(valueOf(loaded('b')), 'b');
  assert.equal(valueOf(errored('msg', 'c')), 'c');
  // errorOf — only the Error kind carries a message
  assert.equal(errorOf(loaded(1)), undefined);
  assert.equal(errorOf(pendingValue(1)), undefined);
  assert.equal(errorOf(errored('boom', 1)), 'boom');
});

test('confirmValue: Pending → Value, anything else passes through unchanged', () => {
  const { confirmValue, pendingValue, loaded, Unset, errored } = M;
  assert.deepEqual(confirmValue(pendingValue(9)), { kind: 'value', value: 9 });
  // Idempotent on Value.
  const v = loaded(7);
  assert.equal(confirmValue(v), v, 'Value forwards by identity');
  // Pass-through on Unset / Error.
  assert.equal(confirmValue(Unset), Unset);
  const e = errored('x', 1);
  assert.equal(confirmValue(e), e);
});

test('lifecycle smoke: Unset → Pending(v1) → Value(v1) → Pending(v2) → Error(prev=v1)', () => {
  const { Unset, pendingValue, confirmValue, errored, valueOf, isPending, isError } = M;

  let s = Unset;
  assert.equal(valueOf(s), undefined);

  // Begin first commit.
  s = pendingValue('first');
  assert.equal(isPending(s), true);
  assert.equal(valueOf(s), 'first');

  // Server confirms.
  s = confirmValue(s);
  assert.equal(s.kind, 'value');
  assert.equal(valueOf(s), 'first');

  // Begin second commit.
  s = pendingValue('second');
  assert.equal(isPending(s), true);

  // Server rejects — revert to the previously-committed value, surface the message.
  s = errored('Failed to save.', 'first');
  assert.equal(isError(s), true);
  assert.equal(valueOf(s), 'first', 'reverts to the prior committed value');
});

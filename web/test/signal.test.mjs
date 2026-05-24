import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';

let S;
before(async () => {
  const outdir = await buildTestBundles();
  S = await import(`${outdir}/core.js`);
});

test('signal: get/set with Object.is write-gate drops no-op writes', () => {
  const { signal, effect, flushSync } = S;
  const a = signal(1);
  let runs = 0;
  const dispose = effect(() => {
    a.get();
    runs += 1;
  });
  flushSync();
  assert.equal(runs, 1, 'effect runs once initially');

  a.set(1); // same value: Object.is gate drops it
  flushSync();
  assert.equal(runs, 1, 'no-op write does not re-run the effect');

  a.set(2);
  flushSync();
  assert.equal(runs, 2, 'real write re-runs the effect');
  dispose();
});

test('computed: lazy + glitch-free diamond recomputes once', () => {
  const { signal, computed, effect, flushSync } = S;
  const a = signal(1);
  let bRuns = 0;
  let cRuns = 0;
  let dRuns = 0;
  const b = computed(() => {
    bRuns += 1;
    return a.get() + 1;
  });
  const c = computed(() => {
    cRuns += 1;
    return a.get() * 2;
  });
  const d = computed(() => {
    dRuns += 1;
    return b.get() + c.get();
  });
  let observed;
  const dispose = effect(() => {
    observed = d.get();
  });
  flushSync();
  assert.equal(observed, 1 + 1 + 1 * 2); // 4
  const dRunsAfterInit = dRuns;

  a.set(5);
  flushSync();
  assert.equal(observed, 5 + 1 + 5 * 2); // 16
  // Diamond: D recomputes once per flush, not twice.
  assert.equal(dRuns - dRunsAfterInit, 1, 'D recomputes exactly once on the shared upstream change');
  dispose();
});

test('batch: a burst of writes flushes once', () => {
  const { signal, effect, batch } = S;
  const a = signal(0);
  const b = signal(0);
  let runs = 0;
  const dispose = effect(() => {
    a.get();
    b.get();
    runs += 1;
  });
  assert.equal(runs, 1);
  batch(() => {
    a.set(1);
    b.set(2);
    a.set(3);
  });
  assert.equal(runs, 2, 'three writes inside batch produce exactly one extra run');
  dispose();
});

test('CASCADE CAP: non-converging effects throw a NAMED SignalCycleError', () => {
  const { signal, effect, flushSync, SignalCycleError } = S;
  const a = signal(0, 'a');
  const b = signal(0, 'b');
  const d1 = effect(() => {
    a.get();
    b.set(b.peek() + 1);
  }, 'ping');
  const d2 = effect(() => {
    b.get();
    a.set(a.peek() + 1);
  }, 'pong');

  let caught = null;
  try {
    a.set(1);
    flushSync();
  } catch (e) {
    caught = e;
  } finally {
    d1();
    d2();
  }
  assert.ok(caught instanceof SignalCycleError, 'throws SignalCycleError, not a silent cap');
  // The error NAMES the live effects (the whole point vs Svelte's anonymous cap).
  assert.ok(
    caught.liveEffects.includes('ping') || caught.liveEffects.includes('pong'),
    `error should name the live effects; got: ${caught.liveEffects.join(', ')}`,
  );
  assert.match(caught.message, /did not converge/);
});

test('CASCADE CAP: a converging effect-writes-signal loop does NOT throw', () => {
  const { signal, effect, flushSync } = S;
  // This loop settles because the Object.is gate closes once the value
  // stabilizes — the common legitimate "effect writes a derived input" case.
  const a = signal(0, 'a');
  const clamp = signal(0, 'clamp');
  let runs = 0;
  const dispose = effect(() => {
    runs += 1;
    const v = a.get();
    // write a clamped copy; once clamp equals the clamped value, Object.is
    // drops the write and the loop ends.
    clamp.set(Math.min(v, 10));
  }, 'clamper');
  assert.doesNotThrow(() => {
    a.set(100);
    flushSync();
  });
  assert.equal(clamp.peek(), 10);
  assert.ok(runs >= 2 && runs < 100, `should converge quickly; runs=${runs}`);
  dispose();
});

test('effect cleanup runs on re-run and on dispose', () => {
  const { signal, effect, flushSync } = S;
  const a = signal(0);
  const log = [];
  const dispose = effect(() => {
    const v = a.get();
    return () => log.push(`cleanup ${v}`);
  });
  flushSync();
  a.set(1);
  flushSync();
  assert.deepEqual(log, ['cleanup 0'], 'cleanup of previous run fires before re-run');
  dispose();
  assert.deepEqual(log, ['cleanup 0', 'cleanup 1'], 'cleanup fires on dispose');
});

test('untrack reads without subscribing', () => {
  const { signal, effect, untrack, flushSync } = S;
  const a = signal(0);
  const b = signal(0);
  let runs = 0;
  const dispose = effect(() => {
    a.get();
    untrack(() => b.get());
    runs += 1;
  });
  flushSync();
  assert.equal(runs, 1);
  b.set(5);
  flushSync();
  assert.equal(runs, 1, 'change to an untracked read does not re-run the effect');
  dispose();
});

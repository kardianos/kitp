/**
 * Cascade-cap demonstration. Builds an intentionally non-converging pair of
 * effects (each writes a signal the other reads, never settling) and shows
 * that the signal core THROWS a named SignalCycleError listing the live
 * effects — instead of a silent depth cap. This is the explicit, observable
 * answer to Svelte's `effect_update_depth_exceeded`.
 *
 * Returns a human-readable string describing what happened. Self-contained so
 * it can be triggered from a button without polluting the app's signal graph.
 */

import { signal, effect, flushSync, SignalCycleError } from './core/signal.js';

export function demonstrateCascadeThrow(): string {
  const a = signal(0, 'cascadeA');
  const b = signal(0, 'cascadeB');

  // ping writes b from a; pong writes a from b — each write changes the
  // value (counter), so the Object.is gate never closes and the graph never
  // converges. The flush caps passes and throws a NAMED error.
  const disposePing = effect(() => {
    a.get();
    b.set(b.peek() + 1);
  }, 'cascadePing');
  const disposePong = effect(() => {
    b.get();
    a.set(a.peek() + 1);
  }, 'cascadePong');

  let message: string;
  try {
    // Kick the loop and force the flush synchronously so we observe the throw.
    a.set(1);
    flushSync();
    message = 'unexpected: flush converged (no cascade thrown)';
  } catch (e) {
    if (e instanceof SignalCycleError) {
      message = `caught named SignalCycleError → live effects: [${e.liveEffects.join(', ')}]`;
    } else {
      message = `caught ${String(e)}`;
    }
  } finally {
    disposePing();
    disposePong();
  }
  return message;
}

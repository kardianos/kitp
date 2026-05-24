/**
 * Signal core — glitch-free push-pull reactivity, zero dependencies.
 *
 * Cascade-safe BY CONSTRUCTION. This is the explicit answer to the Svelte
 * client's two shipped `effect_update_depth_exceeded` incidents (cc1cfd1,
 * a347f38):
 *
 *   (a) Object.is write-gate — `set()` drops no-op writes before ANY
 *       propagation, so the "write the converged value back, re-trigger
 *       everything" cascade dies on contact.
 *   (b) The flush caps *passes*, not depth, and on overflow THROWS a named
 *       error listing the still-live effects. Never a silent depth cap. You
 *       debug your own un-minified stack frames, not a compiler artifact.
 *
 * Model: writes mark dependents dirty (push) and schedule a flush; reads
 * pull (computeds recompute lazily when dirty). Effects run after the flush
 * in insertion order. A diamond (A->B, A->C, B&C->D) recomputes D once.
 */

/** Max effect passes per flush before we declare non-convergence. */
export const MAX_FLUSH_PASSES = 100;

/** Thrown when a flush does not converge. Carries the live effect names. */
export class SignalCycleError extends Error {
  readonly liveEffects: readonly string[];
  constructor(passes: number, liveEffects: readonly string[]) {
    super(
      `signal flush did not converge after ${passes} passes; live effects: ` +
        (liveEffects.length > 0 ? liveEffects.join(', ') : '(none named)'),
    );
    this.name = 'SignalCycleError';
    this.liveEffects = liveEffects;
    Object.setPrototypeOf(this, SignalCycleError.prototype);
  }
}

/** A reactive source other computations can subscribe to. */
interface Source {
  subs: Set<Computation>;
}

/** Anything that tracks dependencies while it runs. */
abstract class Computation {
  /** Sources this computation read on its last run. */
  deps = new Set<Source>();
  /** Reentrancy guard — re-entering throws a named cycle error. */
  running = false;
  abstract notify(): void;
}

let currentComputation: Computation | null = null;
let batchDepth = 0;
let flushing = false;
let globalVersion = 0;
const pendingEffects = new Set<Effect>();

/** Detach a computation from every source it currently depends on. */
function clearDeps(c: Computation): void {
  for (const s of c.deps) s.subs.delete(c);
  c.deps.clear();
}

/** Track a read of `source` against the running computation, if any. */
function track(source: Source): void {
  if (currentComputation) {
    source.subs.add(currentComputation);
    currentComputation.deps.add(source);
  }
}

export class Signal<T> implements Source {
  subs = new Set<Computation>();
  private value: T;
  /** Version bumped on every effective write; computeds compare against it. */
  version = 0;

  constructor(
    initial: T,
    readonly name = 'signal',
  ) {
    this.value = initial;
  }

  /** Reactive read. Registers a dependency on the running computation. */
  get(): T {
    track(this);
    return this.value;
  }

  /** Non-reactive read — does NOT subscribe. Use for snapshots/rollback. */
  peek(): T {
    return this.value;
  }

  /** Write. Object.is gate: equal writes never propagate. */
  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    this.version = ++globalVersion;
    this.pushAndSchedule();
  }

  /**
   * Force a notification without changing identity. For in-place structural
   * mutations of a held object/array where `set` of the same reference would
   * be a no-op. Use sparingly — prefer immutable replacement.
   */
  bump(): void {
    this.version = ++globalVersion;
    this.pushAndSchedule();
  }

  private pushAndSchedule(): void {
    // Copy: notify() of a computed can mutate sub sets transitively.
    for (const c of [...this.subs]) c.notify();
    scheduleFlush();
  }
}

export function signal<T>(initial: T, name?: string): Signal<T> {
  return new Signal(initial, name);
}

/**
 * A lazily-recomputed derived value. Both a Computation (it reads sources)
 * and a Source (other computations read it). Marks dirty on push;
 * recomputes only on pull.
 */
class Computed<T> extends Computation implements Source {
  subs = new Set<Computation>();
  private cached!: T;
  private dirty = true;
  version = 0;

  constructor(
    private readonly fn: () => T,
    readonly name = 'computed',
  ) {
    super();
  }

  /** Push: mark dirty and forward to our own subscribers (lazy chain). */
  notify(): void {
    if (this.dirty) return; // already dirty; subs already told once
    this.dirty = true;
    for (const c of [...this.subs]) c.notify();
  }

  get(): T {
    track(this);
    if (this.dirty) this.recompute();
    return this.cached;
  }

  peek(): T {
    if (this.dirty) this.recompute();
    return this.cached;
  }

  private recompute(): void {
    if (this.running) {
      throw new SignalCycleError(0, [`computed "${this.name}" re-entered while computing`]);
    }
    this.running = true;
    const prev = currentComputation;
    currentComputation = this;
    clearDeps(this);
    try {
      const next = this.fn();
      if (!Object.is(next, this.cached)) {
        this.cached = next;
        this.version = ++globalVersion;
      }
    } finally {
      currentComputation = prev;
      this.running = false;
      this.dirty = false;
    }
  }
}

export interface ReadonlySignal<T> {
  get(): T;
  peek(): T;
}

export function computed<T>(fn: () => T, name?: string): ReadonlySignal<T> {
  return new Computed(fn, name);
}

/** A reactive side effect. Runs once eagerly, then on each relevant flush. */
class Effect extends Computation {
  private disposed = false;
  private cleanup: (() => void) | undefined = undefined;

  constructor(
    private readonly fn: () => (() => void) | void,
    readonly name = 'effect',
  ) {
    super();
    this.run();
  }

  notify(): void {
    if (!this.disposed) {
      pendingEffects.add(this);
      scheduleFlush();
    }
  }

  run(): void {
    if (this.disposed) return;
    if (this.running) {
      throw new SignalCycleError(0, [`effect "${this.name}" re-entered while running`]);
    }
    if (typeof this.cleanup === 'function') {
      const c = this.cleanup;
      this.cleanup = undefined;
      c();
    }
    this.running = true;
    const prev = currentComputation;
    currentComputation = this;
    clearDeps(this);
    try {
      const c = this.fn();
      this.cleanup = typeof c === 'function' ? c : undefined;
    } finally {
      currentComputation = prev;
      this.running = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearDeps(this);
    pendingEffects.delete(this);
    if (typeof this.cleanup === 'function') {
      const c = this.cleanup;
      this.cleanup = undefined;
      c();
    }
  }
}

/** Register a reactive effect. Returns a disposer. */
export function effect(fn: () => (() => void) | void, name?: string): () => void {
  const e = new Effect(fn, name);
  return () => e.dispose();
}

/** Coalesce a burst of writes into one flush. Ref-counted; nestable. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    if (--batchDepth === 0) flush();
  }
}

/** Read without subscribing, even inside an effect/computed. */
export function untrack<T>(fn: () => T): T {
  const prev = currentComputation;
  currentComputation = null;
  try {
    return fn();
  } finally {
    currentComputation = prev;
  }
}

function scheduleFlush(): void {
  if (batchDepth > 0) return; // defer to batch end
  if (!flushing) {
    flushing = true;
    queueMicrotask(flush);
  }
}

/**
 * THE loop-safety mechanism. Effects re-run in insertion order. An effect
 * that writes a signal another pending effect reads re-adds that effect.
 * We cap PASSES, not depth; on overflow we throw a named SignalCycleError so
 * the cycle names itself in your own (un-minified) stack frames.
 */
function flush(): void {
  if (batchDepth > 0) return;
  let passes = 0;
  try {
    while (pendingEffects.size > 0) {
      if (++passes > MAX_FLUSH_PASSES) {
        const names = [...pendingEffects].map((e) => e.name);
        // Clear so the app can keep running after the throw is caught.
        pendingEffects.clear();
        throw new SignalCycleError(passes, names);
      }
      const batchOfEffects = [...pendingEffects];
      pendingEffects.clear();
      for (const e of batchOfEffects) e.run();
    }
  } finally {
    flushing = false;
  }
}

/** Test/host hook: run any pending flush synchronously right now. */
export function flushSync(): void {
  if (flushing || pendingEffects.size > 0) {
    flushing = true;
    flush();
  }
}

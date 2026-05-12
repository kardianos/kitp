/**
 * Per-component request bag.
 *
 * Each `bag.bind(spec, name, handler)` allocates a stable request id and
 * registers `handler` against it. Calling the returned function queues a
 * sub-request with that id; when the dispatcher receives a sub-response
 * (or a batch-level fault) it routes the result back to the bound
 * handler. The handler receives `{ ok: true, data }` on success or
 * `{ ok: false, error }` on failure — the same fault has already been
 * delivered to every `dispatcher.onFault()` listener registered at boot,
 * so per-handler error branches are only needed when the screen wants
 * to specialise its own UX.
 *
 * Lifecycle is tied to the component: `useBag(dispatcher)` registers an
 * `onDestroy` cleanup that unbinds every handler. Late responses for
 * unmounted bags are silently dropped — there is no stale-write path.
 *
 * The bag deliberately avoids returning Promises. Every call site is a
 * function with the shape `(input) => void`; data lands in the handler.
 * Screens express parallel loads by calling several bound functions in
 * the same tick — the dispatcher's existing rAF coalescing folds them
 * into ONE batched POST.
 */

import { onDestroy } from 'svelte';
import { v4 as uuid } from 'uuid';

import type { Dispatcher, HandlerSpec } from './dispatcher';

/**
 * Tagged-union surface of every failure mode a request can reach. The
 * kernel funnels every error path here so per-screen handlers (and
 * registered onFault listeners) see the same shape.
 */
export type ApiFault =
  | { kind: 'sub_error'; code: string; message: string }
  | { kind: 'aborted'; reason: string }
  | { kind: 'http'; status: number }
  | { kind: 'decode'; message: string }
  | { kind: 'network'; message: string };

export type FaultKind = ApiFault['kind'];

/** Result delivered to a bound handler. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiFault };

export interface BindOptions {
  /**
   * When true, a new call to this bound handler supersedes any earlier
   * in-flight call: older responses are dropped on arrival. Default
   * false — every response is delivered in arrival order. Use this for
   * search-style boxes where rapid typing would otherwise let a stale
   * response overwrite the latest.
   */
  replaceInflight?: boolean;
}

/** A bound call site — invoke with input to fire a request. */
export interface BoundCall<I> {
  (data: I): void;
}

/** Internal registration record consumed by the dispatcher. */
export interface BindingEntry {
  decode: (raw: unknown) => unknown;
  handler: (r: Result<unknown>) => void;
  replaceInflight: boolean;
  /** Latest sequence number issued by this binding (incremented per call). */
  latestSeq: number;
}

/**
 * A bag scopes a set of bindings to a component. Disposing the bag
 * unregisters every binding it owns. Bound calls fired before dispose
 * may still be in flight at dispose time; their responses arrive after
 * the binding has been removed and are silently dropped by the
 * dispatcher.
 */
export class Bag {
  private readonly bindIds = new Set<string>();
  private disposed = false;

  constructor(private readonly dispatcher: Dispatcher) {}

  /**
   * Register a handler for a call site. Returns a function that fires a
   * request using the bound spec; the matching sub-response is routed
   * to `handler`. `name` is a debugging label and does not affect
   * routing — every binding gets a fresh UUID under the hood.
   */
  bind<I, R>(
    spec: HandlerSpec<I, R>,
    name: string,
    handler: (r: Result<R>) => void,
    opts: BindOptions = {},
  ): BoundCall<I> {
    if (this.disposed) {
      throw new Error(`Bag: bind("${name}") after dispose()`);
    }
    const id = uuid();
    this.bindIds.add(id);
    this.dispatcher.bindRegister(id, {
      decode: spec.decode as (raw: unknown) => unknown,
      handler: handler as (r: Result<unknown>) => void,
      replaceInflight: opts.replaceInflight === true,
      latestSeq: 0,
    });
    return (data: I): void => {
      if (this.disposed) return;
      this.dispatcher.bindSubmit(id, spec, data);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.bindIds) this.dispatcher.bindUnregister(id);
    this.bindIds.clear();
  }
}

/**
 * Component-scoped bag factory. Wires `onDestroy` for automatic cleanup
 * so screens just write `const bag = useBag(dispatcher);` at the top of
 * their `<script>` and forget about lifecycle.
 */
export function useBag(dispatcher: Dispatcher): Bag {
  const bag = new Bag(dispatcher);
  onDestroy(() => bag.dispose());
  return bag;
}

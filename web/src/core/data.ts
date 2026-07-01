/**
 * Declarative, ZERO-PROMISE data layer — the centerpiece.
 *
 * The owner's directive: "When you register a control, it registers a list of
 * API calls it can make and when, and what the results should callback to —
 * all declared in a data table in the config interface. The control shape does
 * it, no promises anywhere, not even in the control; the framework takes care
 * of the async, and errors can go to the control to self-represent OR to the
 * top-level error message handler."
 *
 * A control declares two binding tables:
 *
 *   - queries  — reads. Each says WHICH spec, WHEN to fire (mount / a tree
 *     signal change / an intent), HOW to build the input (from tree, scope,
 *     config, or an intent payload), WHERE the result lands (a tree path or a
 *     named handler), and WHERE errors go (self / top / a named handler).
 *   - actions  — writes, fired by `intent(name, payload)`. Same shape plus an
 *     optional optimistic tree patch that auto-rolls-back on fault.
 *
 * Bindings come from two places, MERGED at mount:
 *   - class-level static tables (`static queries` / `static actions`) —
 *     "registering a control registers the API calls it can make";
 *   - per-instance config tables (`config.queries` / `config.actions`) — the
 *     server-screen JSON can extend a control's data table.
 *
 * The DataController wires every binding through `api.callByName(...)` — the
 * dispatcher's callback surface — so NO promise appears here, in the control,
 * or in any app code. The single internal promise lives in the dispatcher's
 * `flush()` (awaiting fetch) and never escapes.
 */

import { effect } from './signal.js';
import { tree as appTree, optimistic, type Path, type PathSeg, type TreeNode } from './tree.js';
import type { ApiFault } from './dispatch.js';

/* -------------------------------------------------------------------------- */
/* Binding vocabulary.                                                         */
/* -------------------------------------------------------------------------- */

/** WHEN a binding fires. */
export type Trigger =
  | 'mount'
  /** Re-fire whenever the value at this tree path changes (cascade-safe). */
  | { signal: string }
  /** Fire when `intent(name, payload)` is called on the control. */
  | { intent: string };

/** A single declared input field. */
export type InputValue =
  /** A constant. */
  | { lit: unknown }
  /** Read from the data tree (or control scope) at a dotted path. */
  | { from: string }
  /** Read from the control's config object at a dotted path. */
  | { config: string }
  /** Read from the intent/action payload at a dotted field. */
  | { payload: string };

/** The declared input object: field name -> source. */
export type InputSpec = Record<string, InputValue>;

/** WHERE a successful result goes. */
export type ResultSink =
  /** Replace the tree leaf at this path with the decoded result. */
  | { toPath: string }
  /** Structurally merge the decoded result into the tree at this path. */
  | { mergePath: string }
  /** Invoke a named handler the control registered via `handler(name, fn)`. */
  | { method: string };

/** WHERE an error goes. */
export type ErrorRoute =
  /** Deliver to the control's `setFault` so it self-represents inline. */
  | 'self'
  /** Let the central top-level handler show it (the fault funnel routes there). */
  | 'top'
  /** Invoke a named control handler with the fault. */
  | { method: string };

/** A declarative READ binding. */
export interface QueryBinding {
  /** Stable name (for dedupe / debugging). */
  name: string;
  /** The spec key, `endpoint.action`. */
  spec: string;
  /** Default 'mount'. */
  when?: Trigger;
  input?: InputSpec;
  result: ResultSink;
  /** Default 'self'. */
  onError?: ErrorRoute;
  /**
   * Suppress the fire when any of these resolved input fields is null or
   * undefined. Declarative guard for scope-dependent reads: a board keyed on
   * `{ from: 'scope.projectId' }` lists `['parentCardId']` here so it stays
   * idle (no cross-project flash) until the scope resolves, then the
   * `{ signal }` trigger refires it once the path is set. Empty / absent →
   * always fire (the existing behaviour).
   */
  skipWhenNull?: string[];
}

/** A declarative optimistic patch for an action. */
export interface OptimisticSpec {
  /** Tree path whose leaf is patched immediately and rolled back on fault. */
  path: string;
  /** Pure patch over the current leaf value; runs before the call fires. */
  patch: (current: unknown, payload: unknown) => unknown;
}

/** A declarative WRITE binding, fired via `intent(intent, payload)`. */
export interface ActionBinding {
  /** The intent name that fires this action. */
  intent: string;
  /** The spec key, `endpoint.action`. */
  spec: string;
  input?: InputSpec;
  /** Optional: where a successful result lands. */
  result?: ResultSink;
  /** Optional: optimistic tree patch with auto-rollback on fault. */
  optimistic?: OptimisticSpec;
  /** Default 'top'. */
  onError?: ErrorRoute;
}

/* -------------------------------------------------------------------------- */
/* The control surface DataController drives. Kept minimal + structural so it  */
/* does not import control.ts (avoids a cycle; control.ts imports this).       */
/* -------------------------------------------------------------------------- */

export interface DataHost {
  /** Boot services. */
  readonly ctx: {
    api: {
      callByName(
        specKey: string,
        data: unknown,
        onOk: (out: unknown) => void,
        opts?: { onErr?: (f: ApiFault) => void; alive?: () => boolean; dedup?: boolean },
      ): string;
    };
    tree: TreeNode;
  };
  /** The control's own config (read for `{config}` inputs). */
  readonly config: Record<string, unknown>;
  /** Per-instance scope object for `{from}`/`scope.*` resolution (optional). */
  readonly scope?: Record<string, unknown>;
  /** Merged query table (class static + instance config). */
  dataQueries(): readonly QueryBinding[];
  /** Merged action table (class static + instance config). */
  dataActions(): readonly ActionBinding[];
  /** Look up a named handler registered via `handler(name, fn)`. */
  findHandler(name: string): ((arg: unknown) => void) | undefined;
  /** Deliver a fault to the control's own inline representation. */
  setFault(fault: ApiFault): void;
  /** Gate delivery — false once destroyed. */
  isAlive(): boolean;
  /** Register cleanup run on destroy (effect disposers, intent unregs). */
  addDisposer(fn: () => void): void;
  /** Register an intent listener; returns nothing. */
  onIntent(name: string, fn: (payload: unknown) => void): void;
}

/* -------------------------------------------------------------------------- */
/* Path + resolver helpers.                                                    */
/* -------------------------------------------------------------------------- */

/** Split a dotted path into segments, coercing all-digit segments to numbers. */
export function splitPath(dotted: string): Path {
  if (dotted === '') return [];
  return dotted.split('.').map((seg): PathSeg => {
    return /^\d+$/.test(seg) ? Number(seg) : seg;
  });
}

/** Read a dotted path out of a plain object (no tree, no reactivity). */
function readObjPath(obj: unknown, dotted: string): unknown {
  if (dotted === '') return obj;
  let cur: unknown = obj;
  for (const seg of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Build the input object from an InputSpec. Pure given the four sources:
 *   - tree   — the application data tree (for `{from}` paths). A `{from}` path
 *              prefixed `scope.` reads the host scope instead of the tree.
 *   - config — the control's config object (for `{config}` paths).
 *   - payload— the intent/action payload (for `{payload}` fields).
 *
 * `{from}` reads are NON-reactive here (peek); the DataController sets up
 * reactivity at the trigger level (a `{signal}` trigger), keeping the resolver
 * a pure function that tests can exercise directly.
 */
export function resolveInput(
  spec: InputSpec | undefined,
  sources: {
    tree: TreeNode;
    config: Record<string, unknown>;
    scope?: Record<string, unknown>;
    payload?: unknown;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!spec) return out;
  for (const [field, src] of Object.entries(spec)) {
    out[field] = resolveValue(src, sources);
  }
  return out;
}

function resolveValue(
  src: InputValue,
  sources: {
    tree: TreeNode;
    config: Record<string, unknown>;
    scope?: Record<string, unknown>;
    payload?: unknown;
  },
): unknown {
  if ('lit' in src) return src.lit;
  if ('config' in src) return readObjPath(sources.config, src.config);
  if ('payload' in src) return readObjPath(sources.payload, src.payload);
  // `from`: tree path, or `scope.<path>` to read the host scope.
  const path = src.from;
  if (path.startsWith('scope.')) {
    return readObjPath(sources.scope ?? {}, path.slice('scope.'.length));
  }
  if (path === 'scope') return sources.scope;
  return sources.tree.at(splitPath(path)).peek();
}

/* -------------------------------------------------------------------------- */
/* DataController.                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Wires a control's MERGED binding tables on mount and disposes them on
 * destroy. One per control, owned by the control's lifecycle.
 */
export class DataController {
  private wired = false;

  constructor(
    private readonly host: DataHost,
    /** The data tree (defaults to the shared app tree; injectable for tests). */
    private readonly tree: TreeNode = appTree,
  ) {}

  /** Wire every merged binding. Idempotent. */
  wire(): void {
    if (this.wired) return;
    this.wired = true;
    for (const q of this.host.dataQueries()) this.wireQuery(q);
    for (const a of this.host.dataActions()) this.wireAction(a);
  }

  /* ---- queries ---- */

  private wireQuery(q: QueryBinding): void {
    const when = q.when ?? 'mount';
    const fire = (payload?: unknown): void => this.fireQuery(q, payload);

    if (when === 'mount') {
      fire();
      return;
    }
    if ('signal' in when) {
      // Cascade-safe: the effect READS the tree path (subscribes) and fires
      // the query on change. The query's result writes a DIFFERENT path (or a
      // method); writing the SAME path it watches would be a feedback loop,
      // which the signal core would surface as a named SignalCycleError.
      const watch = this.tree.at(splitPath(when.signal));
      const dispose = effect(() => {
        watch.get(); // subscribe
        fire();
      }, `data.query.${q.name}`);
      this.host.addDisposer(dispose);
      return;
    }
    // { intent }: fire on the named intent (payload available to inputs).
    this.host.onIntent(when.intent, (payload) => fire(payload));
  }

  private fireQuery(q: QueryBinding, payload?: unknown): void {
    if (!this.host.isAlive()) return;
    const input = resolveInput(q.input, {
      tree: this.tree,
      config: this.host.config,
      ...(this.host.scope ? { scope: this.host.scope } : {}),
      payload,
    });
    // Declarative scope guard: a query that depends on a not-yet-resolved
    // input (e.g. parentCardId from scope.projectId before projects load)
    // stays idle rather than firing an unscoped read. The `{ signal }`
    // trigger refires it the moment the watched path is written.
    if (q.skipWhenNull) {
      for (const field of q.skipWhenNull) {
        const v = input[field];
        if (v === null || v === undefined) return;
      }
    }
    this.host.ctx.api.callByName(
      q.spec,
      input,
      (out) => this.deliverResult(q.result, out),
      {
        alive: () => this.host.isAlive(),
        onErr: (f) => this.routeError(q.onError ?? 'self', f),
        // Queries are reads: identical ones firing in the same flush (the same
        // reference list requested by several bindings on a screen) coalesce
        // to one wire sub-request and share the response.
        dedup: true,
      },
    );
  }

  /* ---- actions ---- */

  private wireAction(a: ActionBinding): void {
    this.host.onIntent(a.intent, (payload) => this.fireAction(a, payload));
  }

  private fireAction(a: ActionBinding, payload: unknown): void {
    if (!this.host.isAlive()) return;

    // Optimistic patch first: apply immediately, hold the txn for rollback.
    let txn: { commit(): void; rollback(): void } | null = null;
    if (a.optimistic) {
      const node = this.tree.at(splitPath(a.optimistic.path));
      const patch = a.optimistic.patch;
      txn = optimistic(node, (cur) => patch(cur, payload));
    }

    const input = resolveInput(a.input, {
      tree: this.tree,
      config: this.host.config,
      ...(this.host.scope ? { scope: this.host.scope } : {}),
      payload,
    });

    this.host.ctx.api.callByName(
      a.spec,
      input,
      (out) => {
        txn?.commit();
        if (a.result) this.deliverResult(a.result, out);
      },
      {
        alive: () => this.host.isAlive(),
        onErr: (f) => {
          txn?.rollback();
          this.routeError(a.onError ?? 'top', f);
        },
      },
    );
  }

  /* ---- result + error routing ---- */

  private deliverResult(sink: ResultSink, out: unknown): void {
    if ('toPath' in sink) {
      this.tree.at(splitPath(sink.toPath)).set(out);
      return;
    }
    if ('mergePath' in sink) {
      this.tree.at(splitPath(sink.mergePath)).merge(out);
      return;
    }
    // method: invoke a named handler the control registered.
    const fn = this.host.findHandler(sink.method);
    if (fn) fn(out);
  }

  private routeError(route: ErrorRoute, fault: ApiFault): void {
    if (route === 'self') {
      this.host.setFault(fault);
      return;
    }
    if (route === 'top') {
      // The central funnel already showed it (the dispatcher emitted the
      // typed fault before per-call delivery). Nothing more to do here.
      return;
    }
    const fn = this.host.findHandler(route.method);
    if (fn) fn(fault);
  }
}

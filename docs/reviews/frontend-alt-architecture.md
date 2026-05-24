# Design Proposal: A Zero-Build, Signal-Driven, Control-Registry Web Client for kitp

> Status: design exploration (not a committed plan). Audience: the kitp owner.
> Scope: a from-scratch alternative to the current `client/` Svelte 5 + Vite +
> pnpm stack. The new client speaks the **same** `POST /api/v1/batch` wire
> protocol, preserves the current feature set, and runs in the browser with no
> bundler.

This document is a buildable proposal: every layer has a concrete code sketch,
the wire protocol is reused verbatim, and Section 7 gives a frank "should you
actually build this?" recommendation. Where it cites the current client it uses
`path:line` so the parity claims are checkable.

---

## 0. Why even consider this

The current client is a competent Svelte 5 app, but two recurring classes of
pain motivate the exploration. Both are documented in the repo's own history.

**(a) Reactive cascades that hit a hard depth ceiling.** Svelte 5's runes give
you implicit, compiler-managed reactivity — which is great until an effect
writes state that another derived/effect reads, and the graph folds back on
itself. The repo has at least two shipped incidents:

- `cc1cfd1` "collapse two reactive cascades that tripped Svelte's effect depth
  cap": `AdminFlowsScreen`'s effect read `selectedFlow.scope_card_id` where
  `selectedFlow = $derived(flows.find(...))` *and* wrote a cache keyed off the
  result; loading a flow re-derived `selectedFlow`, re-fired the effect, and
  hit `effect_update_depth_exceeded` on project switch. The fix was to read a
  primitive `$state` instead of the derived to "sever the derived dependency."
- `a347f38` "revert: keys/unregister guard (unmasked Svelte effect cascade)":
  a defensive guard in the shortcut registry's unregister path *removed* a
  throw that had been incidentally stopping a cascade in `AppShell`'s mount
  `$effect`; without the throw, the cascade ran unchecked and
  `effect_update_depth_exceeded` blocked the first paint. The commit message
  admits the root cycle is "left for a follow-up" because it could only be
  diagnosed with source-mapped production effect-stack traces that the
  minified bundle doesn't carry.

The shape repeats: an `$effect` that mutates `$state`, where the mutation feeds
a `$derived` that the effect (transitively) re-reads. Svelte's scheduler
re-runs until the graph quiesces or hits the cap. The cap is a symptom; the
disease is *implicit* dependency tracking plus *effects allowed to write the
same graph they read*. See also `KanbanLayout.svelte:171` — an `$effect` that
writes `columnAttr`/`laneAttr` from `activeFilter`, a pattern that is one careless
edit away from a loop.

**(b) Build-toolchain weight and opacity.** `client/package.json` carries Vite,
the Svelte compiler plugin, Tailwind+PostCSS+autoprefixer, eslint, prettier,
svelte-check, vitest, selenium/chromedriver, and more — a `node_modules` graph
of hundreds of packages to render what is, at runtime, a few hundred KB of DOM
manipulation against one batch endpoint. The `a347f38` incident is partly a
*tooling* problem: the bug was unreadable because the running code is a
compiler artifact, not the code you wrote.

The proposal below trades Svelte's ergonomics and ecosystem for: explicit
reactivity with a documented, loop-resistant scheduler; direct DOM you can read
in the debugger; and a near-empty `node_modules`. Section 7 weighs whether that
trade is worth it. (Spoiler: for a single maintainer who has already been
burned twice by invisible cascades, it is *defensible* — but it is a real
rebuild, not a refactor.)

---

## 1. Architecture overview

```
            ┌────────────────────────────────────────────────────────┐
            │  Go server (unchanged)  —  POST /api/v1/batch            │
            │  per-row {idx,ok,code,message,result}  (sqlfunc.go)      │
            └───────────────▲───────────────────────┬──────────────────┘
                            │ one POST per tick      │ subresponses
                  ┌─────────┴──────────┐             │
                  │  Dispatcher        │◄────────────┘   (ported ~verbatim
                  │  (batch coalescer, │                  from current client)
                  │   fault registry,  │
                  │   bigint revive)   │
                  └─────────┬──────────┘
                            │ resolve/reject + fault funnel
                  ┌─────────▼──────────┐
                  │  Data Tree         │   reactive, path-addressed,
                  │  (signal-backed    │   signal-backed nodes;
                  │   observable store)│   server data lands here;
                  └─────────┬──────────┘   optimistic patch + rollback
                            │ controls subscribe to subtrees
                  ┌─────────▼──────────┐
                  │  Control Registry  │   Control.register(type, ctor)
                  │  + Control.New     │   Control.New(type, config) → tree
                  └─────────┬──────────┘
                            │ render() → real DOM, patched by effects
                  ┌─────────▼──────────┐
                  │  Signal core       │   signal/computed/effect, batched,
                  │  (~120 lines, deps:│   glitch-free, NO effect-writes-graph
                  │   zero)            │   loop (Section 2)
                  └────────────────────┘
```

Five hand-written layers, four runtime dependencies (Section 1.4), no bundler.
Each layer is independently testable in a plain `<script type="module">` page.

### 1.1 Module / loading strategy — the honest no-build compromise

**The hard truth first.** Browsers do not execute `.ts`. "Zero build" in the
literal sense (serve `.ts`, browser runs it) is impossible today — there is no
ratified type-stripping in any shipping browser, and `tsc`'s job is partly to
*erase* types, which is a transform, which is a build. So "no build" has to mean
*"no bundler, no dependency-graph compilation, no framework compiler"* — not
"literally zero transform."

**The compromise I recommend: type-stripping-on-serve, not bundling.** Ship a
~60-line dev server (or a Go middleware in the existing kitp server — it already
serves the SPA via `spaHandler`, see `api.go`) that, on a request for
`/app/foo.ts`, runs **esbuild's `transform` API in `loader: 'ts'` mode** (or the
even lighter `@swc` / the upcoming `Node --experimental-strip-types` /
`tsc --isolatedModules` emit) over that *one file*, strips types, and serves the
result as `application/javascript`. Crucially:

- It is **per-file**, not a bundle. No dependency graph is walked, no
  tree-shaking, no chunking. Each `.ts` maps 1:1 to a served `.js`. The output
  preserves your `import './bar.js'` statements untouched.
- It is **stateless and cacheable**: ETag on file mtime; in production, run the
  same transform once at deploy to emit a `dist/` of plain `.js` next to the
  `.ts` (an `esbuild --loader:ts` over `src/**` with `--bundle=false`). The
  browser loads the emitted `.js` directly; no server transform in prod.
- It is **debuggable**: type-stripping is a 1:1 line-preserving transform, so
  the `.js` you debug is your `.ts` minus type annotations — no minification, no
  compiler-generated reactivity scaffolding. Inline source maps are a one-flag
  add if even that gap matters.

Why this is categorically lighter than the status quo: esbuild's `transform`
(not `build`) is a pure string→string function with no resolver, no plugin
pipeline, no Svelte compiler. It's the single dependency that touches your
source. Compare to Vite's dev server (module graph, HMR runtime, dep
pre-bundling) + the Svelte compiler (`.svelte` → reactive JS) + PostCSS/Tailwind.

> Rejected alternative — "ship pre-stripped `.js`, edit `.js` directly": loses
> all type safety, which is the whole point of the Control registry's typed
> factory (Section 4). Rejected.
>
> Rejected alternative — "write plain JS with JSDoc `@type`": viable and truly
> zero-transform, but JSDoc generics are too weak to express the discriminated-
> union typed registry in Section 4 cleanly. Keep TS source; strip on serve.

**Bare specifiers via import maps.** The four runtime deps (Section 1.4) are
declared in `index.html` so source can write `import { computePosition } from
'@floating-ui/dom'` with no bundler resolution:

```html
<!-- index.html -->
<script type="importmap">
{
  "imports": {
    "@floating-ui/dom": "/vendor/floating-ui-dom.js",
    "marked":           "/vendor/marked.esm.js",
    "dompurify":        "/vendor/purify.es.js",
    "uuid":             "/vendor/uuid.js",
    "@app/":            "/app/"
  }
}
</script>
<link rel="stylesheet" href="/app.css">
<div id="root"></div>
<script type="module" src="/app/main.js"></script>
```

Vendored ESM builds are committed under `/vendor/` (each ships an ESM
distribution already — `@floating-ui/dom`, `marked`, `dompurify`, `uuid` all do).
No `node_modules` at runtime; updating a dep means dropping in a new file and
bumping a comment. The `@app/` prefix maps the source tree so deep imports stay
absolute and refactor-stable.

### 1.2 CSS strategy — drop Tailwind, keep the tokens

Tailwind needs a build (it scans source for class names and generates CSS). The
current client already does the *right* thing underneath Tailwind: it defines a
**design-token layer of CSS custom properties** in `app.css:5-50`
(`--color-bg`, `--color-fg`, `--color-accent`, `--color-section`, …) and flips
them under `[data-theme='dark']`. Theme boot is already a plain
`public/theme-boot.js` loaded synchronously in `index.html` with no build
involvement — that survives as-is.

The proposal: **hand-author one `app.css`** built on the existing token set,
using modern native CSS (nesting, `color-mix()`, custom props — all of which the
current `Markdown.svelte:116` already relies on). Replace Tailwind utility
soup with a small **semantic class vocabulary** (`.btn`, `.btn-primary`,
`.card`, `.col`, `.chip`, `.stack`, `.row`, `.muted`) plus a handful of
utility escape hatches authored by hand (`.flex`, `.gap-2`, `.grow`). This is
maybe 600–900 lines of CSS — comparable to the inline `<style>` blocks the
Svelte components already carry (`Markdown.svelte` alone is ~90 lines of CSS)
plus the global `app.css` form-kernel section.

Controls set `className` strings from config; there is no runtime utility
engine. Dark mode keeps working because it's pure custom-property swapping on
`<html data-theme>`, exactly as today. This is *less* magic than Tailwind, not
more: the class list in the DOM is the class list you wrote.

### 1.3 Wire-protocol compatibility (reuse, don't redesign)

The Dispatcher is the one layer that should be **ported almost verbatim** from
`client/src/dispatch/dispatcher.ts` because it already encodes hard-won protocol
knowledge that the server depends on:

- One `POST /api/v1/batch` per tick via a microtask flush (`dispatcher.ts:227`).
  The current client moved off `requestAnimationFrame` to a microtask to dodge
  Chrome's hidden-tab rAF clamp — keep that decision.
- **BigInt id revival**: ids cross the wire as JSON strings (Go `json:",string"`)
  and must be revived to `bigint` on the way in / stringified on the way out
  (`dispatcher.ts:46-161`). The `card_ref` attribute registry
  (`registerCardRefAttr`, `dispatcher.ts:80`) must come along too — the data
  tree and controls compare option values as `bigint`.
- Per-sub-response `{id, ok, data, error:{code,message,detail}}` decode
  (`subrequest.ts:63`), matching the server's
  `RETURNS TABLE(idx,ok,code,message,result)` contract in `sqlfunc.go:88-127`.
- The **centralized fault registry** (`dispatcher.ts:302` `onFault`, wired in
  `main.ts:48-72`): `http`/`network`/`sub_error`/`decode`/`aborted` listeners
  registered once at boot; `401 → /login`, generic error toast, etc. This
  matches the owner's stated preference for a "callback + centralized error
  registry" over per-screen `try/catch` (MEMORY.md). **Keep it identically.**

The only change: the Dispatcher's `bind`/`Bag` lifecycle (`bag.svelte.ts`)
currently leans on Svelte's `onDestroy`. In the new world the Control base class
owns lifecycle (Section 4), so `Bag.dispose()` is called from
`Control.destroy()` instead of `onDestroy`. The dispatcher core is untouched.

### 1.4 Runtime dependency budget

Four, all vendored as ESM, all already in `client/package.json`:

| Dep | Why it stays | Could we drop it? |
|---|---|---|
| `dompurify` | XSS boundary for markdown (`util/markdown.ts` is explicitly a security boundary) | **No** — never hand-roll sanitization |
| `marked` | CommonMark+GFM → HTML | Maybe later; not worth the parity risk now |
| `@floating-ui/dom` | Popover/dropdown positioning (`Popover.svelte`, `TransitionBar.svelte`) | Could hand-roll, but it's small and correct; keep |
| `uuid` | sub-request correlation ids | **Yes** — replace with `crypto.randomUUID()` (universally available); drop the dep |

So realistically **three** runtime deps after dropping `uuid`. Compare to the
current `devDependencies` list of ~25 packages plus their transitive graph.

---

## 2. The signal primitive

Design goals, in priority order:

1. **No implicit effect-writes-graph loop.** This is the explicit answer to the
   `cc1cfd1`/`a347f38` incidents. We do *not* forbid effects from writing
   signals — that's too restrictive and screens legitimately need it
   (`KanbanLayout.svelte:171`). Instead we make the propagation **synchronous,
   topologically ordered, and cycle-detecting with a clear thrown error that
   names the offending signal** — not a silent depth counter that trips after
   the page half-renders.
2. **Glitch-free**: a computed never observes a half-updated graph (no diamond
   double-fire).
3. **Batched**: a burst of writes in one event handler produces one flush.
4. **Tiny + dependency-free.**

The model: **push-pull with versioned pull**. Writes mark dependents *dirty*
(push) and schedule a flush; reads *pull* (recompute lazily if dirty). Effects
run after the flush in dependency order. This is the
SolidJS/`@preact/signals`/`alien-signals` family, deliberately chosen because
its semantics are well-understood and its loop behavior is *explicit*.

```ts
// @app/core/signal.ts — ~120 lines, zero deps.

type Subscriber = Computation;
let currentComputation: Computation | null = null;   // dependency-tracking cursor
let batchDepth = 0;
const pendingEffects = new Set<Effect>();
let flushing = false;

// A monotonically increasing global version. Each write bumps it; each
// computed records the version it last computed at, so re-pull is O(1)
// when nothing it depends on changed (glitch-free + cheap).
let globalVersion = 0;

abstract class Computation {
  deps = new Set<Signal<unknown>>();
  // Cycle guard: depth of the *current* synchronous recompute stack this
  // computation sits on. If a recompute re-enters the same computation,
  // we throw with the node's debug name instead of looping to a cap.
  running = false;
  abstract notify(): void;
}

export class Signal<T> {
  private value: T;
  private version = 0;
  private subs = new Set<Subscriber>();
  constructor(initial: T, public readonly name = 'signal') { this.value = initial; }

  get(): T {
    if (currentComputation) {
      this.subs.add(currentComputation);
      currentComputation.deps.add(this as Signal<unknown>);
    }
    return this.value;
  }

  set(next: T): void {
    if (Object.is(next, this.value)) return;            // identity gate: no-op writes never propagate
    this.value = next;
    this.version = ++globalVersion;
    for (const s of this.subs) s.notify();              // push: mark dependents dirty
    scheduleFlush();
  }

  // For structural updates that keep identity (data-tree nodes mutate in place).
  bump(): void { this.version = ++globalVersion; for (const s of this.subs) s.notify(); scheduleFlush(); }
}

export function signal<T>(initial: T, name?: string): Signal<T> { return new Signal(initial, name); }

class Computed<T> extends Computation {
  private cached!: T;
  private computedAtVersion = -1;
  private dirty = true;
  constructor(private fn: () => T, public readonly name = 'computed') { super(); }

  notify(): void { this.dirty = true; }                  // lazy: don't recompute on push, only mark dirty

  get(): T {
    if (currentComputation) currentComputation.deps.add(this as unknown as Signal<unknown>);
    if (this.dirty) this.recompute();
    return this.cached;
  }

  private recompute(): void {
    if (this.running) {
      throw new Error(`signal cycle: computed "${this.name}" re-entered while computing`);
    }
    this.running = true;
    const prev = currentComputation;
    currentComputation = this;
    this.deps.clear();                                   // re-track deps every run (handles conditional reads)
    try { this.cached = this.fn(); }
    finally { currentComputation = prev; this.running = false; this.dirty = false; }
    this.computedAtVersion = globalVersion;
  }
}
// A Computed must also be observable: wrap it so its `.subs` get notified.
// (Elided for brevity: Computed registers as a subscriber of its deps AND
//  maintains its own subs; notify() marks dirty AND forwards notify() to subs.)

export function computed<T>(fn: () => T, name?: string): { get(): T } { return new Computed(fn, name); }

class Effect extends Computation {
  deps = new Set<Signal<unknown>>();
  private disposed = false;
  private cleanup: (() => void) | void;
  constructor(private fn: () => (() => void) | void, public readonly name = 'effect') {
    super();
    this.run();
  }
  notify(): void { if (!this.disposed) pendingEffects.add(this); }
  run(): void {
    if (this.disposed) return;
    if (this.running) {
      throw new Error(`signal cycle: effect "${this.name}" re-entered while running`);
    }
    if (typeof this.cleanup === 'function') this.cleanup();
    this.running = true;
    const prev = currentComputation;
    currentComputation = this;
    this.deps.clear();
    try { this.cleanup = this.fn(); }
    finally { currentComputation = prev; this.running = false; }
  }
  dispose(): void {
    this.disposed = true;
    if (typeof this.cleanup === 'function') this.cleanup();
    pendingEffects.delete(this);
  }
}

export function effect(fn: () => (() => void) | void, name?: string): () => void {
  const e = new Effect(fn, name);
  return () => e.dispose();
}

export function batch<T>(fn: () => T): T {
  batchDepth++;
  try { return fn(); }
  finally { if (--batchDepth === 0) flush(); }
}

function scheduleFlush(): void {
  if (batchDepth > 0) return;                            // inside batch(): defer to batch end
  if (!flushing) { flushing = true; queueMicrotask(flush); }
}

// THE loop-safety mechanism. Effects re-run in insertion order. An effect
// that writes a signal another pending effect reads will re-add that effect
// to the set — we cap *passes*, not depth, and on overflow we throw with the
// names of the effects still dirty, so the cycle is *named*, not silent.
function flush(): void {
  let passes = 0;
  while (pendingEffects.size > 0) {
    if (++passes > 100) {
      const names = [...pendingEffects].map((e) => (e as Effect).name).join(', ');
      throw new Error(`signal flush did not converge after ${passes} passes; live effects: ${names}`);
    }
    const batchOfEffects = [...pendingEffects];
    pendingEffects.clear();
    for (const e of batchOfEffects) (e as Effect).run();
  }
  flushing = false;
}
```

How this avoids the Svelte cascade traps:

- **`Object.is` write-gate (`Signal.set`).** The single most common Svelte
  cascade is "write the same value back, re-trigger everything." Here a no-op
  write is *physically dropped before any push*. The `cc1cfd1`
  `selectedFlow.scope_card_id` loop converged on a stable value; under this core
  the second write of the converged value is a no-op and the loop dies on its
  own.
- **Lazy computeds + version-tracking.** A `computed` only recomputes on *pull*,
  not on every upstream push, and a diamond (A→B, A→C, B&C→D) recomputes D once
  per flush. No glitches, no double-fire that masquerades as a cascade.
- **Named cycle errors instead of a silent depth cap.** The `a347f38` failure
  was unreadable because Svelte's `effect_update_depth_exceeded` fires against
  minified code with no node identity. Here, `flush()` throws
  `"signal flush did not converge … live effects: appShellChordSync,
  breadcrumbSync"` — the cycle *names itself* in the un-minified, line-preserved
  served `.js`. You debug a stack trace through your own code.
- **Explicit `batch()`.** The dispatcher already coalesces network into one
  POST per tick; `batch()` gives the same guarantee for DOM: a mutation that
  touches 12 data-tree nodes flushes once. The Kanban optimistic-patch path
  (`KanbanLayout.svelte:542-563`, which today rebuilds the whole `tasks` array)
  becomes a `batch(() => { ...patch nodes... })`.

> Design rule we will enforce by convention + lint (Section 7): **an `effect`
> may write signals, but if it writes a signal it also reads, it must do so
> through `batch()` or guard the write with an `Object.is`-equivalent check.**
> The core makes violations *loud and named* instead of *silent and capped*.

---

## 3. The data tree

A single reactive, path-addressed state tree. Think "one observable document"
where every node is signal-backed, server data lands by path, and controls
subscribe to subtrees. This replaces the current client's scattering of
per-store rune classes (`projectScreensStore`, `projectScope`, `schemaCache`,
each a `$state`-bearing class) with one addressable structure.

```ts
// @app/core/tree.ts
import { Signal, signal, computed, batch } from './signal.js';

type Path = readonly (string | number)[];

// Each node holds a signal of its value. Object/array nodes hold a signal of
// their *child map*; leaf nodes hold a signal of the primitive. Structural
// sharing: replacing a subtree only bumps the nodes that actually changed.
export class TreeNode {
  private readonly children = new Map<string, TreeNode>();
  private readonly leaf: Signal<unknown>;
  constructor(initial: unknown, readonly path: Path) {
    this.leaf = signal(initial, `tree:${path.join('.')}`);
  }

  child(key: string | number): TreeNode {
    const k = String(key);
    let c = this.children.get(k);
    if (!c) { c = new TreeNode(undefined, [...this.path, key]); this.children.set(k, c); }
    return c;
  }

  // Reactive read of a leaf. Controls call this inside an effect/computed to subscribe.
  get<T>(): T { return this.leaf.get() as T; }

  // Reactive read by relative path.
  at(path: Path): TreeNode { return path.reduce<TreeNode>((n, k) => n.child(k), this); }

  // Write a leaf. Object.is gate in Signal.set means equal writes don't propagate.
  set(value: unknown): void { this.leaf.set(value); }

  // Land a server object: merge into children, structurally, in one batch.
  merge(value: unknown): void {
    batch(() => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          this.child(k).merge(v);
        }
      } else {
        this.set(value);   // leaf or array replace
      }
    });
  }
}

export const tree = new TreeNode({}, []);
```

**How server data lands.** A read handler resolves, and its decoded rows are
merged at a well-known path. Controls bound to that path re-render
fine-grainedly:

```ts
// e.g. after card.select_with_attributes for the kanban screen:
const out = await dispatcher.request<CardSelectWithAttributesInput,
                                     CardSelectWithAttributesOutput>({ ... });
batch(() => {
  tree.at(['screens', slug, 'tasks']).set(out.rows);       // one signal write
  tree.at(['cache', 'persons']).set(personsOut.rows);
});
```

**How views subscribe.** A control reads `tree.at([...]).get()` inside its
render effect; that read registers a dependency. When the path's signal changes,
only that control's effect re-runs — and only the DOM it patches updates
(Section 5). No component re-render, no VDOM diff.

**Optimistic updates + rollback.** The current Kanban does this by snapshotting
`const original = tasks` and reassigning on failure (`KanbanLayout.svelte:544,
567`). The tree formalizes it as a transaction:

```ts
// @app/core/optimistic.ts
export function optimistic<T>(node: TreeNode, patch: (cur: T) => T): {
  commit(): void; rollback(): void;
} {
  const snapshot = node.get<T>();                 // structural snapshot (shallow clone at call site)
  batch(() => node.set(patch(snapshot)));         // apply optimistically, one flush
  return {
    commit() { /* nothing: server will overwrite via the next read/merge */ },
    rollback() { batch(() => node.set(snapshot)); },
  };
}
```

The Kanban drag handler becomes: `const txn = optimistic(tasksNode, applyMove)`,
fire `attribute.update`, `await`; on `SubRequestError`/`BatchAbortedError` call
`txn.rollback()` and `notify({type:'error', ...})`. Same UX as today, but the
snapshot/rollback is one helper instead of inlined per screen, and the rollback
is a single signal write (the `Object.is` gate means unaffected cards don't
churn).

**Why structural sharing matters here.** Today, `KanbanLayout`'s optimistic
patch does `tasks = tasks.map(...)` (`:545`) — a whole new array, which in
Svelte re-derives `cells`, `columnKeys`, etc. In the tree, only the moved card's
node and the sort-order nodes it touched bump; the column-keys computed only
re-runs if a key actually changed. Less wasted recompute, and no full-array
identity churn that could feed a cascade.

---

## 4. Control registry & instantiation — the centerpiece

### 4.1 The `Control` base class + lifecycle

```ts
// @app/control/control.ts
import { effect } from '../core/signal.js';

export interface ControlContext {
  dispatcher: Dispatcher;
  tree: TreeNode;
  // ...router, faultRegistry, theme — the boot-time services
}

export abstract class Control<Cfg = unknown> {
  readonly el: HTMLElement;                 // the control's root DOM node
  protected readonly children = new Set<Control>();
  private readonly disposers: Array<() => void> = [];
  private mounted = false;

  constructor(readonly type: string, readonly config: Cfg, protected readonly ctx: ControlContext) {
    this.el = this.createRoot();
  }

  /** Override to choose the root element/tag. Default: <div data-control=type>. */
  protected createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.dataset.control = this.type;
    return el;
  }

  /** One-time DOM construction + signal effects. Children instantiated here. */
  protected abstract render(): void;

  /** Public mount: attach to parent DOM, run render once, mark mounted. */
  mount(parent: HTMLElement | DocumentFragment): void {
    if (this.mounted) return;
    this.render();
    parent.appendChild(this.el);
    this.mounted = true;
  }

  /** Register a reactive effect owned by this control; auto-disposed on destroy. */
  protected effect(fn: () => (() => void) | void, name?: string): void {
    this.disposers.push(effect(fn, name ?? `${this.type}.effect`));
  }

  /** Register any disposer (event listener removal, Bag.dispose, floating-ui cleanup). */
  protected onDestroy(fn: () => void): void { this.disposers.push(fn); }

  /** Imperatively create + own a child control, mounted into `host`. */
  protected spawn<C extends Control>(type: string, config: unknown, host: HTMLElement): C {
    const c = Control.New(type, config, this.ctx) as C;
    this.children.add(c);
    c.mount(host);
    return c;
  }

  /** Tear down: children first (depth-first), then own effects/listeners, then DOM. */
  destroy(): void {
    for (const c of this.children) c.destroy();
    this.children.clear();
    for (const d of this.disposers.splice(0)) d();   // signal effects + Bag.dispose + listeners
    this.el.remove();
    this.mounted = false;
  }

  // ---- the registry (static) ----
  private static registry = new Map<string, ControlCtor<unknown>>();

  static register<Cfg>(type: string, ctor: ControlCtor<Cfg>): void {
    if (Control.registry.has(type)) throw new Error(`control "${type}" already registered`);
    Control.registry.set(type, ctor as ControlCtor<unknown>);
  }

  static New(type: string, config: unknown, ctx: ControlContext): Control {
    const ctor = Control.registry.get(type);
    if (!ctor) throw new Error(`control "${type}" not registered`);
    const control = new ctor(type, config, ctx);
    // Declarative nesting: if config carries `children`, instantiate them
    // recursively and let the parent place them (Section 4.3).
    return control;
  }
}

type ControlCtor<Cfg> = new (type: string, config: Cfg, ctx: ControlContext) => Control<Cfg>;
```

Lifecycle: **construct** (`new ctor`, builds `el`) → **mount** (`render()` once,
append to parent) → **update** (signal effects registered in `render()` patch
DOM as the tree changes; no re-render) → **destroy** (depth-first children, then
disposers — which include signal-effect disposers *and* `Bag.dispose()` — then
remove DOM). Parent owns children, so a single `root.destroy()` cleans the whole
tree: every signal subscription, every event listener, every floating-ui
`autoUpdate`. This is the structural cure for the leaked-subscription /
stale-effect class of bug.

### 4.2 Type-safe dynamic factory despite the string key

The tension: `Control.New("Kanban", config)` is dynamic, but we want
`config` to be type-checked against `Kanban`'s config type. Solution: a
**registry interface augmented per control via TS declaration merging**, giving
a typed `Control.New` overload set without giving up the runtime string map.

```ts
// @app/control/registry-types.ts
// Each control file augments this interface. The key is the type string;
// the value is that control's config type. This is the single source of
// truth that makes the dynamic factory statically typed.
export interface ControlConfigMap {}   // augmented below, per control

// Typed overload of the factory:
declare module './control.js' {
  namespace Control {
    function New<K extends keyof ControlConfigMap>(
      type: K, config: ControlConfigMap[K], ctx: ControlContext,
    ): Control<ControlConfigMap[K]>;
  }
}
```

```ts
// @app/control/controls/kanban.ts
export interface KanbanConfig {
  type: 'Kanban';
  tasksPath: Path;                    // where the rows live in the data tree
  columnAttr: string;
  laneAttr: string | null;
  children?: ControlConfig[];         // declarative nesting (Section 4.3)
}
// Declaration-merge it into the typed map:
declare module '../registry-types.js' {
  interface ControlConfigMap { Kanban: KanbanConfig }
}
```

Now `Control.New('Kanban', { type:'Kanban', columnAttr:'status', /* … */ })` is
fully checked — wrong/missing fields are compile errors — even though the
runtime path is a `Map.get(string)`. The **discriminated union** of all configs
(`type ControlConfig = ControlConfigMap[keyof ControlConfigMap]`) is what the
backend "screen card" deserializes into (Section 6), with a runtime validator
at the trust boundary (server JSON is untyped, exactly like
`predicateFromJson` validates the filter tree today — `predicate.ts:189`).

### 4.3 Declarative nesting in config

A config can describe a whole subtree. `Control.New` (or a small helper)
instantiates children recursively — equivalent to hand-writing nested
`Control.New` calls. The parent decides *where* each child mounts:

```ts
// A config tree:
const cfg: ControlConfig = {
  type: 'Kanban',
  tasksPath: ['screens', 'kanban', 'tasks'],
  columnAttr: 'status',
  laneAttr: null,
  children: [
    { type: 'FilterBar', target: 'header', attributesPath: ['cache','attrDefs'] },
    { type: 'QuickEntryButton', target: 'header', cardType: 'task' },
  ],
};

// Generic recursive instantiation helper (used by ScreenHost-equivalent):
export function instantiate(cfg: ControlConfig, ctx: ControlContext): Control {
  const control = Control.New(cfg.type, cfg, ctx);
  // children are instantiated lazily by the parent's render() via spawn(),
  // OR eagerly here if the parent declares named mount slots. Kanban reads
  // cfg.children in its render() and routes each to a slot by `target`.
  return control;
}
```

Two nesting modes, both supported:

- **Slot-routed** (declarative): parent reads `config.children`, groups by a
  `target` slot name, and `spawn()`s each into the matching DOM region during
  its own `render()`. Used for screen-level composition (header/body/footer).
- **Imperative**: a control calls `this.spawn('Column', colCfg, columnsHost)`
  in a loop driven by a data-tree signal (Kanban spawns one `Column` per key).
  `child.destroy()` removes a column when a key disappears. This is the keyed
  list reconciliation of Section 5.

### 4.4 Binding config to the data tree

A control's config references **paths** (and/or pre-built signals). The control
reads them inside effects so its DOM updates fine-grainedly. Example: a config
`{ bindText: ['screens','kanban','tasks','3','attributes','title'] }` →

```ts
this.effect(() => {
  const title = this.ctx.tree.at(this.config.bindText).get<string>();
  this.titleEl.textContent = title ?? '(untitled)';
}, 'kanbanCard.title');
```

Only the title text node is touched when that one attribute changes. No diff, no
re-render of the card, let alone the board.

---

## 5. Rendering: direct DOM, signal-driven, keyed reconciliation

No VDOM. Controls create real DOM in `render()` and register effects that patch
specific nodes. Three idioms cover everything the current client does:

**(a) Bound text/attr** — one effect per bound property (shown above).

**(b) Events** — plain `addEventListener`, disposer registered:

```ts
const onClick = (e: MouseEvent) => { if (!e.metaKey) this.openTask(); };
this.titleBtn.addEventListener('click', onClick);
this.onDestroy(() => this.titleBtn.removeEventListener('click', onClick));
```

**(c) Keyed list reconciliation** — the only non-trivial piece. A helper keeps a
`Map<key, Control>` and reconciles against a signal-derived key list, creating /
moving / destroying child controls. This is what Svelte's `{#each ... (key)}`
does (`KanbanLayout.svelte:1098 {#each stack as card, slot (card.id)}`) but
explicit:

```ts
// @app/control/keyed-list.ts
export function keyedList<Item>(opts: {
  host: HTMLElement;
  items: () => Item[];                       // reactive (reads tree signals)
  key: (item: Item) => string;
  create: (item: Item) => Control;           // usually parent.spawn(...)
}): () => void {                             // returns disposer
  const live = new Map<string, Control>();
  const dispose = effect(() => {
    const next = opts.items();
    const seen = new Set<string>();
    let anchor: ChildNode | null = null;
    for (const item of next) {
      const k = opts.key(item);
      seen.add(k);
      let c = live.get(k);
      if (!c) { c = opts.create(item); live.set(k, c); c.mount(opts.host); }
      // move into order if needed (keyed: cheap node reorder, no recreate)
      if (c.el.previousSibling !== anchor) opts.host.insertBefore(c.el, anchor ? anchor.nextSibling : opts.host.firstChild);
      anchor = c.el;
    }
    for (const [k, c] of live) if (!seen.has(k)) { c.destroy(); live.delete(k); }
  }, 'keyedList');
  return dispose;
}
```

Reordering moves DOM nodes (preserving focus/scroll/`animate` state); only
genuinely new keys construct, only removed keys destroy. The Kanban
drag-reorder, which today leans on Svelte's `animate:flip`
(`KanbanLayout.svelte:1106`), gets equivalent behavior because nodes are *moved*,
not recreated — and an explicit FLIP helper (measure → move → transform →
transition) is ~30 lines if the animation is wanted.

---

## 6. Parity mapping — backend "screen card" → control tree

The current client is *already* data-driven in exactly the shape this
architecture wants. `ScreenHost.svelte` fetches a `screen` card by
`(parent_card_id=projectId, slug)`, reads its `layout` attribute, and switches
to one of four body components (`ScreenHost.svelte:209-222`):
`list→Inbox`, `grid→Grid`, `kanban→Kanban`, `project→Project`. That `switch`
is *exactly* a `Control.New(layoutToType[layout], config)`.

### 6.1 The mapping table

| Current (Svelte) | New (Control) | Notes |
|---|---|---|
| `ScreenHost.svelte` switch on `layout` | `ScreenHost` control → `Control.New(type, screenConfig)` | layout string maps to control type |
| `KanbanLayout.svelte` | `Kanban` control + `Column` + `KanbanCard` children | keyed-list over column keys + cards |
| `InboxLayout.svelte` | `Inbox` control + `TaskRow` children | keyed-list over task ids |
| `GridLayout.svelte` | `Grid` control | virtualized rows via keyed-list |
| `ScreenFilterBar` + `FilterTreeEditor` | `FilterBar` control; `PredicateEditor` control | predicate AST reused **verbatim** (`predicate.ts`) |
| `Markdown.svelte` + `util/markdown.ts` | `Markdown` control; `util/markdown.ts` reused verbatim | security boundary unchanged |
| `Popover.svelte` (floating-ui) | `Popover` control | `autoUpdate`/`computePosition` in `render()`, cleanup in `onDestroy` |
| `TransitionBar.svelte` | `TransitionBar` control | flow buckets + V13 `flow_disallowed` detail banner |
| `QuickEntryOverlay` | `QuickEntry` control | |
| Svelte context (`getDispatcher`) | `ControlContext` passed to every ctor | no implicit context lookup |

### 6.2 Worked example: a backend `screen` card becomes a rendered control tree

A `screen` card with `layout='kanban'` and a few attributes arrives via
`card.select_with_attributes` (decoded by `decodeCardWithAttrs`,
`handlers.ts:383`) as a `CardWithAttrs`. The `ScreenHost` control translates it:

```ts
// @app/control/controls/screen-host.ts
const LAYOUT_TO_TYPE: Record<string, keyof ControlConfigMap> = {
  list: 'Inbox', grid: 'Grid', kanban: 'Kanban', project: 'Project',
};

export class ScreenHost extends Control<ScreenHostConfig> {
  private bag = new Bag(this.ctx.dispatcher);
  protected createRoot() { const e = document.createElement('div'); e.className = 'screen-host stack'; return e; }

  protected render(): void {
    this.onDestroy(() => this.bag.dispose());     // Bag lifecycle now owned by Control, not onDestroy

    this.effect(async () => {
      const { projectId, slug } = this.config;
      // ONE batched read — dispatcher coalesces into a single POST /api/v1/batch
      const out = await this.ctx.dispatcher.request<
        CardSelectWithAttributesInput, CardSelectWithAttributesOutput
      >({ endpoint: 'card', action: 'select_with_attributes',
          data: { cardTypeName: 'screen', parentCardId: projectId } });

      const screen = out.rows.find((r) => r.attributes['slug'] === slug);
      if (!screen) { this.renderEmpty(`No screen "${slug}"`); return; }

      const layout = String(screen.attributes['layout'] ?? '');
      const ctype = LAYOUT_TO_TYPE[layout];
      if (!ctype) { this.renderEmpty(`Unknown layout "${layout}"`); return; }

      // Build the child control's typed config from the screen card's attributes.
      const childCfg = buildBodyConfig(ctype, screen, projectId);   // validated, discriminated-union
      // Swap body: destroy the old, spawn the new.
      this.body?.destroy();
      this.body = this.spawn(ctype, childCfg, this.el);
    }, 'screenHost.load');
  }
  private body?: Control;
  private renderEmpty(msg: string) { /* spawn EmptyState control */ }
}
Control.register('ScreenHost', ScreenHost);
```

`buildBodyConfig('Kanban', screen, projectId)` reads `column_attr`,
`group_by_attr` from the screen card (the same attributes
`KanbanLayout.svelte:171-175` reads via `readColumnAttr`/`readGroupByAttr`) and
returns a typed `KanbanConfig`:

```ts
function buildBodyConfig(type: 'Kanban', s: CardWithAttrs, projectId: ID): KanbanConfig {
  return {
    type: 'Kanban',
    tasksPath: ['screens', String(s.id), 'tasks'],
    columnAttr: String(s.attributes['column_attr'] ?? 'milestone_ref'),
    laneAttr: typeof s.attributes['group_by_attr'] === 'string'
      ? s.attributes['group_by_attr'] as string : null,
    children: [
      { type: 'FilterBar', target: 'header', screenId: s.id },
      { type: 'QuickEntryButton', target: 'header', cardType: 'task' },
    ],
  };
}
```

### 6.3 The Kanban Column control, rendered against the data tree

```ts
// @app/control/controls/kanban-column.ts
export interface KanbanColumnConfig {
  type: 'KanbanColumn';
  columnKey: string;
  columnAttr: string;
  tasksPath: Path;                      // the board's task list
  label: () => string;                  // resolved column header label (from palette)
}
declare module '../registry-types.js' { interface ControlConfigMap { KanbanColumn: KanbanColumnConfig } }

export class KanbanColumn extends Control<KanbanColumnConfig> {
  private headerCount!: HTMLElement;
  private body!: HTMLElement;

  protected createRoot() {
    const el = document.createElement('section');
    el.className = 'col';
    el.dataset.column = this.config.columnKey;
    return el;
  }

  protected render(): void {
    // header: label + live count + add button
    const header = h('header', 'col-head');
    const title = h('span', 'col-title'); title.textContent = this.config.label();
    this.headerCount = h('span', 'col-count');
    const add = h('button', 'btn-icon'); add.textContent = '+';
    const onAdd = () => this.ctx.bus.emit('quickEntry.open', { columnKey: this.config.columnKey });
    add.addEventListener('click', onAdd); this.onDestroy(() => add.removeEventListener('click', onAdd));
    header.append(title, this.headerCount, add);

    this.body = h('div', 'col-body');
    this.el.append(header, this.body);

    // Reactive: the cards in THIS column, derived from the data tree + grouping.
    const cardsInColumn = (): CardWithAttrs[] => {
      const all = this.ctx.tree.at(this.config.tasksPath).get<CardWithAttrs[]>() ?? [];
      const ck = this.config.columnKey;
      return all
        .filter((t) => keyOf(t.attributes[this.config.columnAttr]) === ck)
        .sort((a, b) => sortOrder(a) - sortOrder(b));   // ports sortByOrder()
    };

    // Live count — only the count text node updates when the column changes.
    this.effect(() => { this.headerCount.textContent = String(cardsInColumn().length); },
                `col[${this.config.columnKey}].count`);

    // Keyed list of cards — moves nodes on reorder, destroys on remove.
    const disposeList = keyedList({
      host: this.body,
      items: cardsInColumn,
      key: (t) => t.id.toString(),
      create: (t) => this.spawn('KanbanCard', { type: 'KanbanCard', cardId: t.id,
        tasksPath: this.config.tasksPath } as KanbanCardConfig, this.body),
    });
    this.onDestroy(disposeList);

    // Drop zone — reuse the existing move math verbatim (kanban_helpers.ts).
    this.installDropZone(this.body, (payloadCard, slot) => {
      const dest = cardsInColumn().filter((c) => c.id !== payloadCard.id);
      const ops = computeMoveBatch(payloadCard, valueForKey(this.config.columnAttr, this.config.columnKey),
                                   null, planSortRewrite(dest, payloadCard, slot), this.config.columnAttr, null);
      const txn = optimistic<CardWithAttrs[]>(this.ctx.tree.at(this.config.tasksPath), applyOpsLocally(ops));
      this.ctx.dispatcher
        .request({ endpoint: 'attribute', action: 'update', data: ops[0] /* …fan-out per op… */ })
        .then(() => txn.commit())
        .catch((e) => { txn.rollback(); notify({ type: 'error', message: `Move failed: ${msgOf(e)}` }); });
    });
  }
}
Control.register('KanbanColumn', KanbanColumn);

function h(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag); if (className) e.className = className; return e;
}
```

Note the reused logic: `computeMoveBatch`, `planSortRewrite`, `sortByOrder`,
`valueForKey`, `keyOf` are all already pure helpers in
`screens/kanban_helpers.ts` and inline in `KanbanLayout.svelte` — they port over
unchanged. The drag-drop fan-out into one `attribute.update` batch
(`KanbanLayout.svelte:497-508`) is the same dispatcher call; the
optimistic-patch+rollback (`:542-578`) becomes the `optimistic()` transaction.

### 6.4 Markdown and predicate-filter controls

`Markdown` control is trivial — it reuses `util/markdown.ts` *verbatim* (the
security boundary stays intact) and writes `el.innerHTML = renderMarkdown(src)`
inside an effect bound to the source signal. The current `Markdown.svelte` uses
`{@html}` (`Markdown.svelte:34`); `innerHTML` on already-sanitized output is the
same trust posture.

`PredicateEditor` control reuses the entire `predicate.ts` AST module
(`Predicate`, `predicateToJson`/`predicateFromJson`, `opArity`, the constructor
helpers) verbatim — it's pure data, no Svelte in it. The editor renders a leaf
row as `[attr-combobox][op-combobox][value-input]` controls; on change it
rebuilds the AST and writes it to a tree node; the screen's data-load effect
reads that node and re-issues `card.select_with_attributes` with the `tree`
field (`KanbanLayout.svelte:364-374` `buildTree()`). Round-trip identical.

---

## 7. Migration, honest tradeoffs, and recommendation

### 7.1 Migration shape

This is a **parallel rewrite**, not an incremental refactor — Svelte components
and Control instances can't share a render tree, so a per-screen strangler is
awkward (you'd run two reactivity systems on one page). The realistic path:

1. **Port the protocol layer first, untouched**: `dispatch/*`, `reg/*`,
   `filter/predicate.ts`, `util/markdown.ts`, `kanban_helpers.ts`,
   `grid_helpers.ts`. These are framework-agnostic TS and represent a large
   fraction of the *correctness-critical* code. They drop in with `Bag`'s
   `onDestroy` swapped for `Control.onDestroy`.
2. Build the core (`signal.ts`, `tree.ts`, `control.ts`, `keyed-list.ts`) — a
   week of work, heavily unit-tested (the signal core is the riskiest 120 lines
   in the system; test glitch-freeness, batching, and the named-cycle throw).
3. Build the shell + one screen (Kanban) end-to-end against the real backend.
   This is the go/no-go gate: if Kanban (the most complex screen) is pleasant to
   build and debug, continue; if not, you've spent ~2 weeks and learned the
   answer cheaply.
4. Port remaining screens. The existing e2e screenshot suite
   (`docs/screenshots/svelte/*`) becomes the parity oracle — render the new
   client, diff against the committed Svelte screenshots.

### 7.2 What you gain

- **No bundler, near-empty `node_modules`** (3 runtime deps, vendored). No Vite
  dep-prebundle, no Svelte compiler, no Tailwind scan. `dev` is "serve the
  folder + strip types per file."
- **Debuggable**: the running code is your code minus type annotations. The
  `a347f38` "can't read minified effect stack" problem disappears — cascades
  throw *named* errors through *your* stack frames.
- **Explicit reactivity with a loop-resistant scheduler.** The two shipped
  cascade incidents are structurally prevented (Object.is write-gate) or made
  loud and named (non-convergence throw) rather than silently capped.
- **Full control + small surface.** ~5 hand-written core files you fully
  understand vs. Svelte 5's runes compiler internals.
- **Architecture matches the domain.** The app is *already* a data-driven
  control tree (screen cards → layouts → rows). The registry expresses that
  directly; the owner's stated "data-driven design throughout" and "unified
  kernel over special cases" preferences (MEMORY.md) fit it like a glove.

### 7.3 What you lose / what it costs

- **The ecosystem.** No Svelte devtools, no `@testing-library/svelte`, no
  community components, no Tailwind plugin universe. You own a11y, focus
  management, transitions, form binding — all of which Svelte gave you for free
  and the current client uses heavily.
- **Compiler optimizations.** Svelte 5 generates tight, fine-grained updates.
  Our signal core is good, but list reconciliation, batching heuristics, and
  the keyed-list move logic are hand-tuned code you now maintain and must keep
  fast. Realistically *fast enough* for this app's data sizes (limit 500
  tasks), but it's on you.
- **No SSR / hydration path.** The current client is SPA-only too
  (`spaHandler`), so this is not a regression — but it forecloses SSR as a
  future option without significant rework.
- **The rebuild itself.** `client/src` is ~178 files; the screens
  (`TaskDetailScreen` 2025 LOC, `InboxLayout` 1160, `KanbanLayout` 1183,
  `TransitionBar` 863, plus ~15 admin screens) are weeks of careful porting.
  This is the dominant cost and it is large. Much of the *logic* ports (it's
  already in pure-TS helpers), but every `.svelte` template — the DOM
  structure, the a11y attributes, the keyboard handlers
  (`KanbanLayout.svelte:693-745` alone wires ~12 shortcuts) — is rewritten as
  imperative DOM.
- **Reactivity foot-guns move, not vanish.** Implicit Svelte cascades become
  *explicit* effect-writes-effect loops. The named-throw makes them debuggable,
  but a junior contributor can still write one. You're trading "invisible and
  capped" for "visible and thrown" — better, but not free.
- **You become the framework maintainer.** Every browser quirk, every
  focus-trap edge case, every "why doesn't the list animate" is now your bug,
  not an upstream issue you can file.

### 7.4 Risks specific to the no-build choice

- **Type-strip-on-serve is a transform you must trust.** If esbuild's TS
  transform ever disagrees with `tsc`'s type-checking (rare, but
  `const enum`, decorators, and some `import type` elision edge cases exist),
  you get a runtime/typecheck split. Mitigation: forbid those features by lint;
  keep `tsc --noEmit` in CI as the type oracle, esbuild only for emit.
- **Import maps + deep relative imports** are verbose and refactor-fragile
  without a resolver. The `@app/` prefix mitigates but doesn't eliminate.
- **No tree-shaking** means the vendored deps ship whole. `marked`+`dompurify`
  are ~50KB gz combined — fine. But it removes the safety net that lets you
  import a big lib and only pay for what you use.

### 7.5 Frank recommendation

**Don't do a wholesale rewrite now. Do a time-boxed spike, then decide.**

The architecture is sound and genuinely well-matched to kitp's data-driven
domain — the screen-card → layout dispatch already *is* a control registry in
disguise (`ScreenHost.svelte`), and the protocol layer is already
framework-agnostic pure TS. The signal core's explicit, named-cycle scheduler is
a real, defensible answer to the two cascade incidents the repo actually shipped
(`cc1cfd1`, `a347f38`), not a hypothetical.

But the cost is dominated by one term: **rewriting ~6000+ lines of working
`.svelte` screens** into imperative DOM, re-earning a11y/focus/keyboard parity
that Svelte currently provides, and signing up to be your own framework
maintainer forever. For a single-maintainer project, that is a multi-month
commitment whose payoff is "fewer invisible cascades and a lighter toolchain" —
real benefits, but ones you could *also* get more cheaply by (a) adopting the
`Object.is` write-gate discipline and an effect-lint *within* Svelte, and (b)
auditing the handful of effect-writes-derived sites the cascade commits already
identified.

Concretely, I recommend:

1. **Build the spike** (Sections 2–5 core + the Kanban screen end-to-end,
   ~2 weeks). It's cheap, it de-risks the riskiest 120 lines (the signal core),
   and it produces a real apples-to-apples comparison on the hardest screen.
2. **Gate on the spike**: if building+debugging Kanban this way is *clearly*
   better than the Svelte version (especially: did a cascade-class bug become
   trivially diagnosable?), greenlight the full port and use the screenshot
   suite as the parity oracle. If it's merely "about the same," **stay on
   Svelte** and instead invest the saved months into the cheaper cascade
   mitigations above.

The honest meta-point: this design is worth *exploring* and the spike is worth
*building*. The full rewrite is only worth committing to if the spike proves the
cascade-debuggability and toolchain wins are decisive for you in practice — and
that's a question only the spike can answer, not this document.

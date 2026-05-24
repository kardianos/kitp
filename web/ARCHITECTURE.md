# kitp `web/` — Zero-Framework Signal/Control Architecture

> Status: scaffold + end-to-end proof (this pass). A from-scratch alternative
> to `client/` (Svelte 5 + Vite + Tailwind). Speaks the **same**
> `POST /api/v1/batch` wire protocol verbatim. No Svelte, no Vite, no
> Tailwind, no React — esbuild is the sole toolchain.
>
> This file is the "write it down before building" artifact required by the
> owner. It extends `docs/reviews/frontend-alt-architecture.md` (read that
> first for the long-form rationale, the parity-mapping table, and the
> honest tradeoff section). Here we lock the *concrete* decisions this
> codebase implements.

---

## 0. The two failures this design answers

The Svelte client shipped two cascade incidents (`cc1cfd1`, `a347f38`):
an `$effect` that wrote `$state` feeding a `$derived` the effect re-read,
folding the reactive graph back on itself until Svelte's
`effect_update_depth_exceeded` cap fired — against *minified* code with no
node identity, so it was undebuggable. The second incident was an
imperative shortcut register/unregister guard whose removal unmasked the
cascade in `AppShell`'s mount effect.

Two structural fixes, both load-bearing in this codebase:

1. **The signal core makes non-convergence loud and *named*.** A no-op
   write is dropped before any propagation (`Object.is` gate). A flush that
   does not converge throws a named error listing the live effects — never a
   silent depth cap. You debug your own un-minified stack frames.
2. **Hotkeys are *derived* from the live control tree, not imperatively
   registered/unregistered on mount/unmount.** The imperative pattern is
   exactly what caused the chord cascade; deriving the active binding set
   from the mounted tree removes the write-on-change entirely.

---

## 1. Layers (bottom-up)

```
  signal.ts   signal/computed/effect/batch — glitch-free push-pull,
              Object.is write-gate, named non-convergence throw
     │
  tree.ts     path-addressed reactive state tree; batch results land
              here by path; optimistic(txn) with rollback
     │
  dispatch.ts batch coalescer (one POST/microtask), bigint revival,
  api.ts      centralized fault registry, declarative pre-registered
              specs invoked as call(spec, data, onOk)
     │
  control.ts  Control base class + registry + Control.New factory;
  not-found.ts direct DOM, lifecycle, declarative + imperative nesting;
              unknown type → visible NotFound placeholder (never throws)
     │
  hotkeys.ts  hierarchical bindings DERIVED from the mounted control tree
```

Everything is hand-authored TypeScript. esbuild bundles it (one fast pass);
no framework compiler, no module-graph dev server magic.

---

## 2. Build & module strategy — esbuild only

- `web/package.json` lists **esbuild** as the sole build/dev dependency.
  (Runtime markdown deps `dompurify` + `marked` are *vendored* under
  `web/vendor/` as ESM — noted, not installed via the framework toolchain.
  They are the XSS/markdown boundary and are not yet wired in this pass; see
  §10 Stubbed.)
- `web/build.mjs` is the single build script. `node build.mjs` does a
  production bundle to `web/dist/`; `node build.mjs --serve` runs esbuild in
  watch mode behind esbuild's own static file server (the "tiny static
  serve"). No other server, no Vite, no proxy framework.
- `npm run build` → `node build.mjs`; `npm run dev` → `node build.mjs --serve`;
  `npm test` → `node --test` over `web/test/*.test.mjs` (built with esbuild
  on the fly — dependency-light, no vitest/jest).
- `tsconfig.json` is `--noEmit` strict, used as the type oracle. esbuild does
  the emit (it strips types; it does *not* type-check — that split is
  intentional and matches the design doc's §7.4 mitigation: `tsc --noEmit`
  is the type authority, esbuild is the bundler).

We bundle (one entry, `src/main.ts`, tree-shaken) rather than the design
doc's per-file type-strip-on-serve. Reason: esbuild's bundle is already
fast (<50ms here), produces one cacheable artifact, keeps source maps for
debuggability (the whole point), and avoids the import-map + deep-relative
fragility the doc itself flagged as a risk (§7.4). Source is still plain TS
you read in the debugger via sourcemap; there is no framework compiler
artifact between you and your code.

---

## 3. Signal core (`src/core/signal.ts`)

Push-pull, versioned, glitch-free. Cascade-safe **by construction**:

- **`Object.is` write-gate.** `Signal.set(next)` returns immediately if
  `Object.is(next, value)` — no version bump, no push, no flush. The single
  most common cascade ("write the converged value back, re-trigger
  everything") dies here.
- **Lazy computeds + version tracking.** A `computed` marks dirty on push
  and recomputes only on pull; a diamond (A→B, A→C, B&C→D) recomputes D once
  per flush. No glitches, no double-fire masquerading as a cascade. A
  computed re-entering itself throws `signal cycle: computed "<name>"
  re-entered while computing`.
- **Named non-convergence throw — the headline fix.** Effects run after the
  flush. An effect may write signals (screens legitimately need this). We
  cap **passes**, not depth: after `MAX_FLUSH_PASSES` (100) the flush throws

  ```
  signal flush did not converge after 100 passes; live effects: <names...>
  ```

  naming every still-dirty effect. This is the explicit answer to
  `effect_update_depth_exceeded`: visible + named in un-minified frames, not
  silent + capped + anonymous.
- **`batch(fn)`** coalesces a burst of writes into one flush; nesting is
  ref-counted.

Each `signal`/`computed`/`effect` carries an optional `name` used only in
those error messages. The DOM never re-renders wholesale: effects patch
specific nodes.

---

## 4. Data tree (`src/core/tree.ts`)

One reactive, path-addressed document. Every node is signal-backed.

- `tree.at(['screens', slug, 'tasks'])` navigates/creates a `TreeNode`.
- `node.get<T>()` is a *reactive* leaf read (registers a dependency).
- `node.set(v)` writes a leaf (Object.is gate applies).
- `node.merge(serverObject)` lands a batch result structurally in one
  `batch()`: object keys recurse into children; arrays/primitives replace
  the leaf. Only the nodes that actually changed bump — no full-tree churn.
- **Batch results land by path.** A read handler's `onOk` does
  `tree.at(path).merge(out)` (or `.set(out.rows)`); controls bound to that
  subtree re-run their fine-grained effects, nothing else.
- **`optimistic(node, patch)`** snapshots the leaf, applies `patch` in a
  `batch()`, and returns `{ commit(), rollback() }`. `rollback()` restores
  the snapshot in one write (Object.is means untouched siblings don't
  churn). Drag-reorder etc.: apply optimistically, fire the API, on failure
  `rollback()` + funnel the fault.

---

## 5. Control framework (`src/core/control.ts`, `src/core/not-found.ts`)

The centerpiece. **Direct DOM, no virtual DOM.**

### Lifecycle

`construct` (builds `el`) → `mount(parent)` (runs `render()` once, appends)
→ *update* (effects registered in `render()` patch specific DOM nodes as
signals change; no re-render) → `destroy()` (depth-first children, then
this control's disposers — signal-effect disposers, event-listener removers,
any `onDestroy` cleanup — then removes its DOM). **Parent owns children**, so
one `root.destroy()` tears down the entire subtree: every subscription,
every listener, every child.

`this.effect(fn, name)` registers a reactive effect auto-disposed on
destroy. `this.onDestroy(fn)` registers any cleanup. `this.listen(el, type,
handler)` adds an event listener and registers its removal.

### Registry & factory

- `Control.register("Type", ctor)` — throws on duplicate type.
- `Control.New("Type", config, ctx)` — looks up the ctor and instantiates.
  **Unknown type does NOT throw** — it returns a `NotFound` control
  (§6 below). This is wired into the factory itself, so *any* call site
  (declarative child, imperative spawn) degrades gracefully.

### Declarative nesting

A config may carry `children: ControlConfig[]`. The base class's `render()`
flow exposes `this.mountChildren(host, configs?)` which instantiates each
child via `Control.New` and mounts it into `host` — equivalent to
hand-writing nested `Control.New` calls. Children placed this way are owned
by the parent (in `this.children`) and cleaned up on destroy. Controls that
want slot-routing read `config.children`, group by a `target` field, and
mount each group into the matching region.

### Imperative nesting

`this.spawn("Type", config, host)` instantiates + mounts + owns a child;
`child.destroy()` (or the parent's destroy) cleans it up. Used for keyed
lists (one child per data key).

### Type safety despite the dynamic string key

`ControlConfigMap` (in `control.ts`) is an interface each control augments
via TS **declaration merging**:

```ts
declare module "../core/control.js" {
  interface ControlConfigMap { Kanban: KanbanConfig }
}
```

`Control.New<K extends keyof ControlConfigMap>(type: K, config:
ControlConfigMap[K], ctx)` is the typed overload: wrong/missing config
fields are *compile errors* even though the runtime path is `Map.get(string)`.
The discriminated union `ControlConfig = ControlConfigMap[keyof
ControlConfigMap]` is what server "screen card" JSON deserializes into,
validated at the trust boundary (untyped server JSON → validated config),
mirroring how the Svelte client validates its predicate AST.

---

## 6. NotFound control (`src/core/not-found.ts`) — core requirement

When `Control.New` is asked for an unregistered type it returns a
**visible** `NotFound` placeholder: a bordered box showing the unknown type
name and a compact JSON dump of the config (depth/length capped, never
`innerHTML` — all `textContent`, no injection). It never throws. This lets a
screen assembled from a declarative config render *today* even when some
child control types don't exist yet — we fill them in gradually, and the
gaps are visible on screen rather than crashing the page. Wired directly
into the factory so it covers declarative children and imperative spawns
alike.

---

## 7. Declarative, pre-registered API (`src/core/api.ts`)

API specs are declared and **registered up front** — `(endpoint, action)` +
`encode` + `decode` — exactly like the Svelte client's `HandlerRegistry`,
but the call surface is the team-preferred **`call(spec, data, onOk)`**:

```ts
call(CardSelectWithAttributes, { cardTypeName: "screen", parentCardId: id },
     (out) => tree.at(["screens", slug]).merge(out));
```

`call` routes through the batch dispatcher's **callback surface**
(`request(args, onOk, onFault)`); success invokes `onOk(decoded)`. **No
promise crosses this surface** — see §11 for the no-promise rule and where the
single internal promise lives. There is **no per-call try/catch**: every
failure (sub-error, abort, decode, network, http) flows through the
**centralized fault registry** — one funnel registered once at boot
(`dispatcher.onFault(kind, listener)`), matching the owner's stated preference
(MEMORY.md: callback + centralized error registry over `await` ladders). `call`
returns the sub-request id so a caller can correlate if it wants; an optional
`opts.onErr(fault)` specializes one call's failure UX without bypassing the
funnel, and `opts.alive` drops late responses for a destroyed control.

`callByName(specKey, data, onOk, opts)` resolves a spec from the registry by
its `endpoint.action` string key — the surface the declarative data layer
(§11) addresses specs through.

Specs are objects with literal `endpoint`/`action` and typed `encode`/`decode`,
so the union of registered specs is statically known.

---

## 8. Hierarchical hotkeys (`src/core/hotkeys.ts`) — derived, not imperative

Hotkeys are declared in control config (`hotkeys: HotkeyBinding[]`) and
scoped **hierarchically by the live control tree**: global → screen →
region → control. The active binding set is **derived** by walking the
mounted control tree from the focused/active control up to the root and
layering bindings, with child scopes shadowing parent bindings on the same
key. This is the explicit fix for the Svelte chord cascade: there is **no
imperative register/unregister on mount/unmount**. A single
`keydown` listener at the document root resolves the event against the
*currently derived* set (recomputed lazily from the tree on each key, or
memoized via a signal that depends on the active-control signal).

Each control exposes `hotkeys()` (from its config) and participates in the
scope chain via its parent pointer. The `HotkeyController` is constructed
once at boot with the root control + an `activeControl` signal; it derives
the binding map and dispatches. Chord support (`g p`) is a small state
machine over the derived map.

---

## 9. Batch dispatcher (`src/core/dispatch.ts`) — ported concepts, exact wire

Ported from `client/src/dispatch/` (the protocol knowledge is hard-won):

- **One `POST /api/v1/batch` per microtask flush.** Coalesces a burst of
  `call()`s in one task into a single HTTP request (matches the Svelte
  client's deliberate move off rAF to dodge Chrome's hidden-tab clamp).
- **Wire shape verbatim.** Request: `{ subrequests: [{ id, type, endpoint,
  action, ref?, key?, data? }] }`. Response: `{ subresponses: [{ id, ok,
  data?, error?: { code, message, detail? } }] }`. Per-row decode matches
  the server's `RETURNS TABLE(idx, ok, code, message, result)` contract
  (`server/internal/api/sqlfunc.go`) surfaced through `api.go`'s
  `SubResponse`.
- **BigInt id revival.** Server emits int64 ids as JSON strings
  (`json:",string"`); `reviveIds` walks the parsed response and converts
  id-shaped keys (and registered `card_ref` attribute keys) to `bigint`;
  `stringifyBigInt` emits outgoing bigints as strings. Ported verbatim — the
  data tree and controls compare ids as `bigint`.
- **Centralized fault funnel.** `aborted` → maps to a batch-abort;
  `sub_error` / `decode` / `network` / `http` each emit a typed `ApiFault`
  to every registered listener before any per-call delivery. `401` handling
  (refresh-or-redirect) is a boot-registered listener, not per-call code.
- **Mock transport.** The dispatcher takes a `transport: (body) => Promise<...>`
  so the proof can run with a canned in-memory backend when the real server
  isn't reachable; production passes a `fetch`-backed transport to the real
  `/api/v1/batch`.
- **Lifecycle.** The Svelte `Bag` leaned on `onDestroy`; here a control's
  `call`s are tracked and the dispatcher drops late responses for a
  destroyed control (the control's `destroy()` marks its scope dead). The
  dispatcher core (queue → flush → decode → route) is unchanged.

---

## 10. The end-to-end proof (`src/main.ts`)

`src/main.ts` assembles a minimal screen entirely from a **declarative
config** via `Control.New`, demonstrating every required capability:

1. A `Screen` control with declarative `children`: a `Toolbar`, a
   `TaskList` driven by a **declarative data table** (§11), and a
   `SparkleChart` child whose type is *not registered* → renders the visible
   `NotFound` placeholder (proving graceful degradation).
2. The `TaskList` declares its entire data behaviour as DATA (no imperative
   `call`): a **query** fires on mount and on the `reload` intent (writes rows
   to `screen.tasks` → the list renders reactively from the tree path); an
   **action** `add` applies an **optimistic** tree patch, fires the spec, and
   `mergePath`s the echo, routing errors to the **top-level** handler; an
   action `badAdd` always faults and routes the error to **self** (an inline
   banner) with the optimistic patch auto-rolled-back. The `Toolbar` and the
   hotkeys only fire `intent(name, payload)` — they say *when*; the table says
   *what*.
3. **Hierarchical hotkeys** derived from the live control tree fire intents
   (`r` = reload, `a` = add at screen scope; `Escape` = dismiss the inline
   fault at the list region) through the derived hotkey controller.
4. A console-triggerable demo of the **cascade-cap throw** (an intentional
   non-converging effect pair) so the named error is observable — guarded
   behind a button so it doesn't fire on load.

There are **no promises, no `.then`, no `await`** anywhere in `main.ts`, the
proof controls, or the framework surface — the framework drives the async
(§11). It `esbuild`-builds cleanly to `dist/` and loads by opening `index.html`
(after a build) or via `npm run dev`.

### What's stubbed / deferred to the next pass

- **Real backend transport.** The proof uses a mock transport with canned
  rows for `card.list_tasks` / `card.create_task` (success) and
  `card.create_task_broken` (forced fault). Flip `USE_REAL_BACKEND` in
  `main.ts` (or pass a fetch transport) to hit `/api/v1/batch`. The wire
  encode/decode is the real thing; only the network sink is mocked.
- **Server-side auth.** §12 documents the SSO contract the client assumes; the
  server side (the OIDC bounce, the authenticated app-shell route, 401/403
  semantics) is owned by another agent and is NOT implemented here.
- **Vendored `dompurify` + `marked`.** Noted as the markdown/XSS boundary;
  `web/vendor/` exists but the `Markdown` control is not built this pass.
  Reuse `client/src/util/markdown.ts` verbatim when it lands.
- **`@floating-ui/dom`** (popover positioning) — deferred; not needed for the
  proof.
- **Real screen controls** (Kanban/Column/Card, Inbox/TaskRow, Grid,
  FilterBar/PredicateEditor, TransitionBar) — the registry + NotFound mean
  these can be added incrementally; each is registered and the screen config
  starts resolving it instead of NotFound.
- **Design tokens.** `web/design/tokens.css` (designer-owned) does not exist
  yet; `src/styles.css` stubs a token layer with a clear TODO to reconcile.
  We do not touch `web/design/`.

### What the next pass needs

Build the real screen controls against the designer's `web/design/` mocks:
register each control type, replace the proof's placeholder config with the
real `ScreenHost` → layout-dispatch config (mirroring
`client/src/ui/.../ScreenHost.svelte`'s `switch(layout)`), reuse the
framework-agnostic helpers from `client/src/` (predicate AST,
kanban/grid helpers, markdown), and align `styles.css` to
`web/design/tokens.css` once it exists. The keyed-list reconciler
(`src/core/keyed-list.ts`) is the one non-trivial rendering primitive those
list screens need; it is included and unit-tested. Each real screen control
declares its `static queries` / `static actions` table (§11) instead of
hand-writing `call(...)` — that is the canonical pattern now.

---

## 11. Declarative, ZERO-PROMISE data model (`src/core/data.ts`)

> The owner's directive: *"Ideal to pre-register callback, avoid promises.
> When you register a control, it registers a list of API calls it can make and
> when, and what the results should callback to — all declared in a data table
> in the config interface. The control shape does it, no promises anywhere, not
> even in the control; the framework takes care of the async, and errors can go
> to the control to self-represent OR to the top-level error message handler."*

### The no-promise rule

`dispatch.request(args, onOk, onFault)` returns **just `{ id }`** — there is no
`done` promise. Success/failure are delivered to the registered callbacks. **No
`.then` / `await` / `Promise` appears in `api.ts`, `data.ts`, `control.ts`,
`main.ts`, or any control.** The **single** allowed promise is inside the
dispatcher's private `flush()`, which `await`s `transport.send` (fetch is
inherently promise-based). It never escapes that method. The `Transport`
interface (the network sink — `fetchTransport` / the proof's mock) is the only
other place a promise is *implemented*, by design; it is not part of the
framework/control/app surface. A test-only `flushNow(done?)` hook drives a
flush to completion under `node --test` (callback form, so the test surface
need not `await` either).

### Two binding tables per control

A control declares its data behaviour as DATA. Bindings come from two places,
**merged at mount** by the `DataController`:

- **class-static** tables — `static queries: QueryBinding[]` /
  `static actions: ActionBinding[]` ("registering a control registers the API
  calls it can make");
- **per-instance config** tables — `config.queries` / `config.actions` (server
  screen JSON can extend a control's table).

```ts
type Trigger = 'mount' | { signal: string /* tree path */ } | { intent: string };

type InputValue =
  | { lit: unknown }                 // a constant
  | { from: string }                 // tree path (or "scope.<path>")
  | { config: string }               // control config path
  | { payload: string };             // intent/action payload field
type InputSpec = Record<string, InputValue>;

type ResultSink =
  | { toPath: string }               // replace the tree leaf
  | { mergePath: string }            // structural merge into the tree
  | { method: string };              // invoke a named control handler

type ErrorRoute =
  | 'self'                           // control.setFault(fault) — self-represent
  | 'top'                            // the central fault funnel shows it
  | { method: string };             // a named control handler

interface QueryBinding {             // a READ
  name: string;
  spec: string;                      // "endpoint.action" key
  when?: Trigger;                    // default 'mount'
  input?: InputSpec;
  result: ResultSink;
  onError?: ErrorRoute;              // default 'self'
}

interface ActionBinding {            // a WRITE, fired by intent(name, payload)
  intent: string;
  spec: string;
  input?: InputSpec;
  result?: ResultSink;
  optimistic?: { path: string; patch: (cur, payload) => next };
  onError?: ErrorRoute;              // default 'top'
}
```

### Example

```ts
class TaskList extends Control<TaskListConfig> {
  static override queries: QueryBinding[] = [
    { name: 'load', spec: 'card.list_tasks', when: 'mount',
      input: { cardTypeName: { config: 'cardTypeName' } },
      result: { method: 'landTasks' }, onError: 'self' },
    { name: 'reload', spec: 'card.list_tasks', when: { intent: 'reload' },
      input: { cardTypeName: { config: 'cardTypeName' } },
      result: { method: 'landTasks' }, onError: 'self' },
  ];
  static override actions: ActionBinding[] = [
    { intent: 'add', spec: 'card.create_task',
      input: { title: { payload: 'title' } },
      optimistic: { path: 'screen.tasks',
        patch: (cur, p) => [...(cur ?? []), { id: -1n, title: p.title }] },
      result: { mergePath: 'screen.tasks' }, onError: 'top' },
  ];
  protected render() {
    this.handler('landTasks', (out) => this.ctx.tree.at(['screen','tasks']).set(out.rows));
    this.effect(() => { /* render from tree.at(['screen','tasks']).get() */ });
    this.effect(() => { /* render this.fault.get() inline (the 'self' route) */ });
  }
}
```

### How the DataController wires it

On mount each control owns a `DataController(host, tree)`. `wire()` walks the
merged tables:

- `when: 'mount'` → fire once.
- `when: { signal: path }` → a **cascade-safe** `effect` reads that tree path
  (subscribes) and refetches on change. Writing the *same* path the query
  watches would loop — and the signal core surfaces that as a *named*
  `SignalCycleError`, not a silent depth cap (§3). The `Object.is` write-gate
  also means a no-op write never refetches.
- `when: { intent: name }` → registers an intent listener; `control.intent(
  name, payload)` (a button, a hotkey, the bus) fires it.

Input is built by the pure `resolveInput(spec, { tree, config, scope, payload })`
resolver. Results route to the sink (`toPath`/`mergePath` write the tree;
`method` invokes a named handler the control registered via `handler(name,fn)`).
Errors route per `onError`: `'self'` → `control.setFault(fault)` (the control
shows it inline via its `fault` signal); `'top'` → nothing more (the central
funnel already showed it); `{ method }` → a named handler. **Optimistic** action
patches apply immediately via `tree.optimistic(...)` and **auto-roll-back** if
the action faults. Delivery is gated on `control.isAlive()`; every effect /
intent registration is disposed on `control.destroy()`.

---

## 12. SSO-only auth model + server contract

The SPA renders **no login screen**. Authentication is entirely the server's
job; the client only reacts to losing its session.

### Client behaviour

At boot, `main.ts` registers an `http` fault listener on the central funnel:

```ts
dispatcher.onFault('http', (f) => {
  if (f.status === 401 || f.status === 403) bounceToSso();
});

const SSO_START_PATH = '/auth/oidc/start';                 // single constant
function bounceToSso() {
  const redirect = encodeURIComponent(location.pathname + location.search);
  location.assign(`${SSO_START_PATH}?redirect=${redirect}`);
}
```

A `401` (expired/absent session) or an auth `403` triggers a **full-page
redirect** to the SSO start endpoint, preserving the deep link. This is the
only auth code in the client — no per-call branches, no login form, no token
plumbing. If the designer's inventory lists a "Login" screen, it **collapses to
this SSO bounce**: there is no Login control.

### Server contract this client assumes (NOT implemented here)

`server/` is owned by another agent; this client does **not** touch it. The
assumptions the client is built against:

1. The SPA (`index.html` + `dist/`) is served **only behind an authenticated
   route**. An unauthenticated request for the app shell is itself bounced to
   SSO by the server — the client never has to gate its own first paint.
2. The **sole public surface** is the SSO bounce flow: `GET
   /auth/oidc/start?redirect=<path>` begins the OIDC dance and, after the IdP
   round-trip, lands the user back on `<path>` with a session cookie set.
3. `POST /api/v1/batch` is cookie-authenticated (same-origin; `fetchTransport`
   sends no Authorization header). On an expired/absent session it returns
   **HTTP 401** (or `403` for an authenticated-but-forbidden auth failure) so
   the client's funnel can bounce. Per-row `sub_error`s (e.g. `flow_disallowed`)
   are *not* auth failures and do not bounce.

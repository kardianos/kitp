# web/ — Data & Auth Architecture (design intent)

> **Audience:** whoever (agent or human) next works on the `web/` frontend.
> **Status:** design intent / north star. The as-built lives in
> `web/ARCHITECTURE.md`; if the two drift, **this file is the intent** and
> ARCHITECTURE.md is what actually shipped — reconcile toward this unless a
> decision below was explicitly revised.
> **Owner directive captured:** the data layer is fully declarative,
> callback-registration based, with **no promises in the surface**, and auth is
> **SSO-only with no login UI**.

---

## 0. Context you need before touching this

- `web/` is a **ground-up rewrite** of the kitp client. It is **pure TypeScript,
  built only with esbuild**. NO Svelte, NO Vite, NO Tailwind, NO React, NO
  promises in the framework/control/app surface. The existing Svelte client in
  `client/` is being **superseded gradually** — it stays in production during
  migration; do not import from it (you may *read* it for parity + lift its
  framework-agnostic helpers: predicate AST, kanban/grid helpers, markdown
  sanitization).
- Core already scaffolded under `web/src/core/`: `signal.ts`, `tree.ts`,
  `dispatch.ts`, `api.ts`, `control.ts`, `hotkeys.ts`, `not-found.ts`. The
  declarative data layer (`data.ts`) + the refactors described here are being
  implemented now.
- Design inputs live in `web/design/` (screen inventory, ASCII mocks for
  Kanban / Task-detail / Inbox, `tokens.css`, a common-control + common-rule
  dedup inventory, and a hierarchical hotkey map). **Caveat:** those mocks were
  drawn from *stale* screenshots (`docs/screenshots/` is old and misses newer
  looks/features). A fresh-screenshot pass (run the e2e Chrome flow against the
  current client) is pending and must refresh the mocks/tokens **before** real
  screen controls are built.
- Review context that motivates the design choices here:
  `docs/reviews/frontend-design-review.md` (why the Svelte client's
  effect-cascade pattern must not be recreated) and
  `docs/reviews/frontend-alt-architecture.md` (the original framework proposal).
- Relevant project memory: the team prefers **callback + a centralized fault
  registry** over `await` ladders, and **data-driven design throughout**
  (screens/views/attributes are backend "cards"; defaults live one level up).

---

## 1. The no-promise principle

**Controls never see a Promise.** No `await`, no `.then`, not even a
`call(...)` invoked imperatively for declared data. A control declares *what it
reads* and *what it can do* as a **data table**; the framework owns the async
and the error routing.

The **only** place a `Promise` is allowed to exist is inside the dispatcher's
`flush()`, where `fetch` is inherently promise-based. It must never escape into
`api.ts`, `control.ts`, `data.ts`, `main.ts`, or any control. Everything above
the transport is callback registration.

Rationale: this is the team's stated preference, and — more importantly — it is
the structural fix for the class of bug that plagued the Svelte client.
Promise/await chains that write reactive state created the effect cascades
(`effect_update_depth_exceeded`, the white-screen-on-project-switch). A
declarative table fired by the framework, with results landing in the tree via
defined sinks, removes the ad-hoc state-writing-async that caused those loops.

---

## 2. The declarative data table (the centerpiece)

A control's **shape** declares its data needs. Bindings come from two places,
merged by the `DataController`:

1. **Class-level (static):** "registering a control registers the API calls it
   can make." A control class declares `static queries` / `static actions`.
2. **Per-instance (config):** `queries` / `actions` on the control's config
   (the "data table in the config interface"). Instance config augments/overrides
   the class table.

### Binding types

```ts
// A read. Fires on a declared trigger; result lands in the tree or a method.
interface QueryBinding {
  name: string;                 // local handle
  spec: string;                 // pre-registered spec key, "endpoint.action"
  when?: Trigger;               // default: 'mount'
  input?: InputSpec;            // declarative input assembly
  result: ResultSink;           // where decoded output goes
  onError?: ErrorRoute;         // default: 'self'  (reads self-represent)
}

// A mutation. Fired by an intent (this.intent(name, payload) / hotkey / event).
interface ActionBinding {
  intent: string;               // intent name that triggers it
  spec: string;
  input?: InputSpec;            // may reference the intent payload
  optimistic?: OptimisticSpec;  // apply now, auto-rollback on fault
  result?: ResultSink;          // optional (e.g. merge the updated row)
  onError?: ErrorRoute;         // default: 'top'  (writes funnel to top-level)
}

type Trigger =
  | 'mount'                     // fire once when the control mounts
  | { signal: string }          // tree/scope path; refetch when it changes
  | { intent: string };         // fire only when this intent is raised

// Declarative input assembly — NO code in config.
type InputSpec = Record<string, InputValue>;
type InputValue =
  | { lit: unknown }            // a literal
  | { from: string }            // a tree/scope path, e.g. 'scope.projectId'
  | { config: string }          // a field from this control's own config
  | { payload: string };        // a field from the intent payload (actions)

// Where a decoded result goes.
type ResultSink =
  | { toPath: string }          // write decoded output into the tree at path
  | { mergePath: string }       // merge into a collection at path (keyed)
  | { method: string };         // invoke a named handler the control registered

// Where a fault goes.
type ErrorRoute =
  | 'self'                      // deliver to the control's fault signal (inline)
  | 'top'                       // central top-level error handler shows it
  | { method: string };         // a named control handler

interface OptimisticSpec {
  path: string;                 // tree path to patch immediately
  patch: unknown;               // the optimistic value/patch
  // rollback is automatic on fault (tree.optimistic transaction)
}
```

### Example

```ts
class TaskList extends Control<TaskListConfig> {
  static queries: QueryBinding[] = [{
    name: 'tasks',
    spec: 'card.select_with_attributes',
    when: { signal: 'scope.projectId' },            // refetch on project switch
    input: {
      project_id: { from: 'scope.projectId' },
      card_type_name: { lit: 'task' },
    },
    result: { toPath: 'tasks' },                     // framework writes the tree
    onError: 'self',                                 // show inline in this control
  }];

  static actions: ActionBinding[] = [{
    intent: 'saveTitle',
    spec: 'attribute.update',
    input: { card_id: { payload: 'id' }, value: { payload: 'title' } },
    optimistic: { path: 'tasks', patch: '<patched row>' },
    result: { mergePath: 'tasks' },
    onError: 'top',                                  // central error handler
  }];
  // ...render reads ctx.tree.at('tasks'); fires this.intent('saveTitle', {...})
}
```

The control's `render()` reads the tree (`ctx.tree.at('tasks')`) reactively and
fires intents (`this.intent('saveTitle', {id, title})`). It contains **zero**
async, zero `call(...)`, zero promise handling.

---

## 3. DataController responsibilities

A sibling of `HotkeyController`, instantiated per control in `mount()`, disposed
in `destroy()`. For each merged binding it:

- Computes the **merged binding set** = class-static + instance-config.
- Wires the trigger:
  - `'mount'` → fire once now.
  - `{ signal: path }` → a **cascade-safe** `effect` that reads *only that tree
    path* and refetches when it changes. **Do not** write back into a signal the
    effect tracks; **do not** write into a foreign store another effect tracks.
    (These are the exact rules from the Svelte review — see §6.)
  - `{ intent: name }` → register so the matching intent fires it.
- Resolves `input` via the `InputSpec` resolver (tree/scope/config/payload).
- Fires through `api.callByName(specKey, input, onOk, { onErr, alive })`.
- Routes the result to the `ResultSink` (tree write/merge, or named method).
- Routes faults per `ErrorRoute` (see §5).
- Gates delivery on `control.isAlive()` so a destroyed control drops late
  responses.
- Disposes every effect/registration on control destroy.

For actions with `optimistic`, apply the tree patch immediately via
`tree.optimistic(...)`; on fault the transaction rolls back automatically before
the error route runs.

---

## 4. The layers (callback surface, no exposed promise)

- **`dispatch.ts`** — `request(args, onOk, onFault)` returns `{ id }` (no `done`
  promise). `Pending` holds `onOk`/`onFault` callbacks, not `resolve`/`reject`.
  `flush()` may stay `async` internally (it awaits `transport.send`) — that is
  the single sanctioned promise and it must never escape. Keep a **test-only**
  flush hook so `node --test` can drive flushes without a promise in product
  code. The centralized fault funnel (`onFault(kind, listener)`) stays.
  - Wire facts (don't re-derive): one `POST /api/v1/batch` per microtask flush;
    request `{ subrequests:[{id,type,endpoint,action,ref?,key?,data?}] }`;
    response `{ subresponses:[{id,ok,data?,error?:{code,message,detail?}}] }`;
    int64 ids arrive as JSON strings and are revived to `bigint` on the way in /
    stringified out; the tree compares ids as `bigint`.
  - **bigint revival of card_ref attrs:** runtime registry primed from the
    schema. The Svelte client had a silent bug here (un-primed → `number` vs
    `bigint` `===` fails). Prefer comparing ids by a canonical string form
    (`String(x)`) at comparison sites, OR have the server tag value types — do
    not let view correctness depend on boot ordering.
- **`api.ts`** — `call(spec, data, onOk, opts)` and `callByName(specKey, ...)`
  route through the dispatcher's callback surface. No `done.then`. `opts.onErr`
  (per-call specialization) and `opts.alive` stay. Specs are declared up front
  via `define(...)` and addressed by `endpoint.action` key from the data table.
- **`control.ts`** — adds: `queries`/`actions` config fields; class-static
  binding tables; a named-handler registry (`this.handler(name, fn)` consumed by
  `{method}` sinks/routes); `intent(name, payload?)`; a `fault` signal +
  `setFault`/`clearFault`; owns a `DataController` across mount→destroy. Also fix
  the `ControlCtor` registry typing so `Control.register('Type', SomeControl)`
  type-checks without `any` leaks at call sites.

---

## 5. Error routing semantics

Every fault still emits to the **central fault funnel** (for logging/observability).
What the user *sees* is decided by the binding's `ErrorRoute`:

- **`'self'`** (default for reads) → delivered to the control's `fault` signal;
  the control renders its own error state inline (empty/error placeholder per the
  common-rules inventory). Use when a failed load should degrade *that region*,
  not the whole app.
- **`'top'`** (default for writes) → the boot-registered top-level error handler
  shows it (toast/banner). Use for mutations where a global, dismissible message
  is the right UX.
- **`{ method }`** → a named control handler for bespoke handling.

A binding picks exactly one destination. The central funnel remains the single
place cross-cutting concerns (auth redirect, telemetry) attach — see §7.

---

## 6. Cascade-safety rules (do not recreate the Svelte bug)

The signal core throws a **named `SignalCycleError`** listing live effects when a
flush fails to converge — instead of a silent depth cap. To stay out of that:

1. **Derive, don't mirror.** Never use an effect whose job is to copy one signal
   into another. Use `computed`/derived reads.
2. **One-way loads.** A trigger effect tracks *only* primitive keys (ids/slugs/a
   version) and writes *only* into the tree the view derives from — never back
   into a tracked dep, never into a foreign store another effect tracks.
3. **Fine-grained writes.** Mutate tree nodes in place; don't reassign whole
   collections (that invalidates every reader and fans out cascades).

The declarative model enforces these by construction: triggers are explicit,
inputs are pure resolutions, results land in defined tree sinks.

---

## 7. Auth — SSO-only, no login UI

- The SPA renders **no login screen**. It assumes it is always served behind an
  **authenticated route** (BFF cookie session; the client never handles tokens).
- At boot (`main.ts`), register an `http` fault listener: on **401** (and
  auth-class 403 if applicable) do a **full-page redirect** to the SSO start
  endpoint, e.g.
  `location.assign('/api/v1/auth/oidc/start?redirect=' + encodeURIComponent(location.pathname + location.search))`.
  Keep the start path as a single constant.
- The sole **public** surface is that SSO bounce. If the designer's screen
  inventory lists a "Login" screen, it collapses to this redirect — there is no
  form to build.

### Server contract (NOT this frontend's job; separate `server/` task)

The client *assumes* the server:
1. Serves the SPA bundle only on an authenticated route.
2. Exposes a public route that is **just** the SSO redirect handler (bumps to the
   SSO host).
3. Returns **401** on the batch/API and SPA routes when the session is
   absent/expired, so the client's boot listener can bounce.

This server-side work was deliberately deferred to avoid colliding with the
in-flight backend fix agent. Track it as its own task.

---

## 8. Other things the next pass needs

- **NotFound is load-bearing.** `Control.New(type, config)` returns a visible
  `NotFound` placeholder (type name + config dump, text-only, no injection) for
  unregistered types — it never throws. This is what lets screens render with
  controls we haven't built yet; build screens incrementally and fill in control
  types over time.
- **Hierarchical hotkeys** are *derived from the live control tree*
  (global → screen → region → control → overlay, deepest-wins), not imperatively
  registered (imperative register/unregister was the chord-cascade cause).
  Hotkeys should raise **intents**, which actions consume — keep hotkeys → intents
  → action bindings as the one path. Align to `web/design/hotkeys.md`.
- **Common controls / common rules.** Dedup is structural, not stylistic — see
  `web/design/controls-and-rules.md`. Build the small reusable set (Field,
  Picker, Collection, Card, Toolbar, Popover, Markdown, TransitionBar, Toast…)
  and the framework-enforced rules (selection, inline-edit, validation, empty/
  loading/error placeholders, focus/keyboard, optimistic feedback) **once**; each
  screen is "these controls with this config."
- **Data-driven screens.** A screen is resolved from a backend "screen card" by
  `(project_id, slug)` and dispatched to a layout (kanban/list/grid). Mirror the
  Svelte `ScreenHost` switch-on-layout shape with `Control.New`.
- **Roadmap to next pass:** (1) finish this data layer + verify
  `npm run build` / `tsc --noEmit` (whole project) / `npm test` green; (2) capture
  fresh screenshots from the current client; (3) refresh `web/design/` mocks +
  `tokens.css`; (4) build the real screen controls against accurate visuals and
  the declarative data model, replacing the `proof` demo.
- **Scope discipline:** touch only `web/`. You may *read* `client/`, `server/`,
  `docs/`. Do not modify `web/design/` if a designer pass owns it. Do not commit
  unless asked.

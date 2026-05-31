# kitp `web/` — Zero-Framework Signal/Control Architecture

> This is the kitp web client: hand-authored TypeScript, **esbuild the sole
> toolchain** — no Svelte, no Vite, no Tailwind, no React. It speaks the
> `POST /api/v1/batch` wire protocol verbatim. It replaced an earlier Svelte 5
> client (since removed); a few sections below still contrast with that client
> where the contrast explains a design choice.
>
> **This is the single source of truth for the `web/` framework.** §0–§12 are
> the as-built framework. **§13** is the composition principle + control
> taxonomy every screen follows (the rule going forward). **§14** is the
> current screen inventory and known gaps.

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
  Runtime deps `dompurify` + `marked` (the XSS/markdown boundary) and
  `@floating-ui/dom` (popover positioning) are *vendored* under `web/vendor/`
  as ESM — not installed via the framework toolchain. They are wired through
  `src/util/markdown.ts` / `src/util/markdown-control.ts` and the popover
  control.
- `web/build.mjs` is the single build script. `node build.mjs` emits a
  **self-contained** `web/dist/` — `index.html` + `app.js` + `styles.css`
  (the `@import` of `web/design/tokens.css` is inlined by esbuild, so dist
  carries no runtime dependency on `web/design/`). The emitted
  `dist/index.html` rewrites the script ref to `./app.js`, so the dist root is
  directly servable by kitpd via `WEB_DIR=web/dist` (no `web/` source exposed).
  `node build.mjs --serve` runs esbuild in watch mode behind esbuild's own
  static file server (the "tiny static serve"), serving the source `index.html`
  from `web/`. No other server, no Vite, no proxy framework.
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

## 10. The first real screen vertical slice (`src/main.ts`)

> **Historical — the founding slice.** §10/§10b document the first two screens
> (Kanban, Project List) and the data-path proofs done with them. The technical
> specifics — wire shapes, bigint revival, the `scope.projectId` → board path,
> optimistic move + rollback, `skipWhenNull` — remain accurate and are the best
> worked example of the data layer. The "stubbed this slice" / "verified this
> pass" notes are point-in-time; the full screen set is now built — see §14 for
> the current inventory.

`src/main.ts` assembles the **AppShell → ScreenHost(kanban) → Kanban** tree
entirely from a **declarative config** via `Control.New`, replacing the earlier
`proof`/`TaskList` demo. It demonstrates every required capability against the
real wire shapes and the refreshed `web/design/` mocks:

1. **AppShell** (`src/shell/app-shell.ts`) — the persistent frame per
   `web/design/mock-kanban.md`: a topbar (rail-collapse `‹`, brand, project-scope
   `<select>` Picker, breadcrumb crumb, theme toggle `☾`/`☀`, panel `▥`, help
   `?`), a left rail (global links Projects/Activity with chord hints, a DEFAULT
   PROJECT scope section Inbox/Grid/Kanban/Project detail, an ADMIN section, a
   foot user chip), and an `outlet` region into which the ScreenHost mounts. The
   shell declares **global-tier hotkeys** (`g p`/`g a`/`g i`/`g g`/`g k`, `?`)
   as **intents** (`shellHotkeys`), derived hierarchically by the live-tree
   `HotkeyController`. The theme toggle writes `data-theme` on `<html>` (R8).
   The **project-scope Picker is data-driven**: a static `projects` **query**
   (`card.select_with_attributes`, `card_type_name='project'`) loads the real
   project cards on mount; the `landProjects` sink renders the `<select>` options
   from each project's `title` attribute, default-selects the project named by
   `defaultProjectLabel` (else the first), and writes `scope.projectId` into the
   tree — which refires the descendant Kanban's `{ signal: 'scope.projectId' }`
   queries. The `<select>` re-renders reactively from the `shell.projects` tree
   path. Picking another project in the dropdown sets `scope.projectId` the same
   way. This is the project → scope → board data path, proven live.
2. **ScreenHost** (`src/shell/screen-host.ts`) — mirrors
   `client/src/screens/ScreenHost.svelte`'s switch-on-`layout`: it maps the
   screen's `layout` to a body control TYPE (`kanban→Kanban`, `list→Inbox`,
   `grid→Grid`, `project→Project`) and dispatches via `Control.New`. Unbuilt
   layouts and unknown layouts resolve to the visible **NotFound** placeholder
   (never throws). Structured so a screen-card lookup `(project_id, slug)` drives
   it later; for this slice the screen is configured inline.
3. **ScreenFilterBar** (`src/shell/screen-filter-bar.ts`) — the v1 SUBSET: a
   GROUP-by Picker (default `milestone`), a search `Field`, and Clear, writing
   one-way to `screen.group` / `screen.search`. The full saved-view / named-
   filter / per-attribute-Picker row is a documented TODO rendered as a
   placeholder so it slots in later.
4. **Kanban + Column + TaskCard** (`src/kanban/kanban.ts`) — the board grouped
   by the axis (default `milestone_ref`). Its **declarative data table**: two
   static **queries** load tasks AND the axis value-cards (milestones), BOTH via
   `card.select_with_attributes`, project-scoped, refiring on `scope.projectId`.
   The milestones query uses `select_with_attributes` (NOT the lighter
   `card.select`, which the real handler returns with `title: null`) so the
   column header gets the milestone's real `title` attribute — matching the
   Svelte `KanbanLayout`. Both queries carry `skipWhenNull: ['parentCardId']`
   (§11) so they stay idle until a project scope resolves rather than firing an
   unscoped, cross-project read. One static **action** `moveTask`
   (`attribute.update` of the axis attribute) applies an **optimistic** tree
   patch that re-buckets the moved card and **auto-rolls-back on fault**, routing
   the fault to the top-level handler. The render reads `kanban.tasks` /
   `kanban.milestones` reactively and buckets via the lifted pure helpers
   (`src/kanban/kanban-helpers.ts`); drag-drop fires `this.intent('moveTask', …)`.
   Columns are keyed by the value-card id plus a trailing `(unset)` bucket. The
   move value crosses the wire as a bigint (`stringifyBigInt` → JSON string,
   which the card_ref handler accepts) or `null` for the `(unset)` column (the
   handler treats JSON null as "clear the attribute").
5. The kanban screen config declares an **unknown** `SparkleChart` child → the
   **NotFound** placeholder renders next to the board (graceful degradation
   demonstrably still working).

There are **no promises, no `.then`, no `await`** anywhere in `main.ts`, any
control, or the framework surface — the framework drives the async (§11). The
only promise is inside the dispatcher's `flush()` / the transport. It
`esbuild`-builds cleanly to `dist/` and loads by opening `index.html` (after a
build) or via `npm run dev`.

### Backend mode — `USE_REAL_BACKEND` flip

`main.ts` has a single `const USE_REAL_BACKEND = true` (the app default after
the live end-to-end verification). The API specs
(`card.select_with_attributes`, `card.select`, `attribute.update`) are
registered against the REAL `/api/v1/batch` wire either way — only the
**transport** differs:

- **`true` (app default):** `fetchTransport('')` POSTs to same-origin
  `/api/v1/batch` (cookie-auth; SSO bounce on 401/403 via the boot fault
  listener — §12). Verified end-to-end against live kitpd on seeded demo data:
  dev-login → load the SPA → the picker loads 3 real projects, the board renders
  project 31's M1/M2/M3 + `(unset)` columns with real task titles, a drag-move
  fires `attribute.update` and PERSISTS across reload, no fault banners.
- **`false`:** a `mockTransport()` (`src/kanban/mock-data.ts`) seeded with data
  shaped exactly like the Go handlers return (one project, 6 tasks across 3
  milestones + an unset bucket; **int64 ids as JSON strings**, an `attributes`
  object with the milestone `title` and a `milestone_ref` card_ref the
  dispatcher revives to `bigint`). A write to the sentinel `FAULT_CARD_ID`
  returns a per-row error so the optimistic-rollback path is exercisable. The
  unit tests inject their own `Dispatcher` + `mockTransport` directly, so the
  `true` app default does NOT affect `node --test`.

### What's done vs. stubbed in this slice

DONE:
- AppShell, ScreenHost, ScreenFilterBar (v1 subset), Kanban + Column + TaskCard
  registered controls; the three real API specs; the optimistic move +
  auto-rollback; the lifted pure kanban helpers; the `USE_REAL_BACKEND` switch;
  `styles.css` extended against `web/design/tokens.css` for all of the above.
- Verified: `tsgo --noEmit` clean, `node --test` green (50 tests incl. helper /
  query-bucketing / optimistic-move-and-rollback / ScreenHost-dispatch +
  NotFound), `npm run build` clean, AND a LIVE headless-Chrome drive against
  kitpd on seeded demo data (`AUTH_MODE=off`, same-origin `WEB_DIR`): dev-login,
  3 real projects in the picker (Default Project auto-selected), board scoped to
  project 31 (columns `32/33/34` labelled M1/M2/M3 + `(unset)`, real task
  titles, no cross-project leak), drag-move card 54 M1→M2 fires
  `attribute.update` and persists across reload, no fault banners.

STUBBED / deferred (documented in code TODOs):
- **ScreenFilterBar** is a v1 subset (GROUP + search + Clear). The saved-view /
  named-filter / per-attribute-Picker row + Show-closed-status are placeholders.
- **Within-column reorder** — the `sort_order` rewrite. The helpers
  (`planSortRewrite` / `computeMoveBatch`) are lifted and unit-tested and ready;
  the drag UI does cross-column moves only for v1.
- **Swim lanes** (the 2-D `group_by_attr` axis), the per-column `+`
  QuickEntryOverlay, and keyboard `hjkl` / Shift-move card nav.
- **Common controls** — `Picker`/`Field` are native `<select>`/`<input>` here;
  the real `Picker`/`Field`/`Collection`/`Toast` controls land with later screens.
- **Server-side auth.** §12's SSO contract is assumed; the server side is owned
  by another agent and not implemented here.
- **Vendored `dompurify` + `marked`** (`Markdown` control) and
  `@floating-ui/dom` (popover positioning) — not needed for the board.

## 10b. Project List screen + signal-driven outlet swap

The **all-projects landing** (`web/design/mock-secondary.md` "Projects") is the
second real screen. `src/main.ts` now LANDS the AppShell outlet on it (view
`'projects'`); selecting a project (or a `g k`/`g i`/`g g` chord) swaps the
outlet to the board.

1. **ProjectList** (`src/projects/project-list.ts`) — breadcrumb "All
   projects" + H1/`+ New project` + a search Field that filters by title +
   one row per project (title · "open tasks: —" v1 dash placeholder, intentional
   parity with the Svelte ProjectsScreen · a wired ✎ edit button) + the shared
   project-properties dialog (Title Field + a "+ More details" disclosure with a
   real **Description** textarea + Add & Another / Add & Close, with
   `Enter`/`Mod+Enter`/`Esc`).
   - **Template exclusion (list + picker together):** the AppShell `projects`
     query input ships the where-leaf `{ attr:'is_template', op:'!=',
     value:true }` (the shared `TEMPLATE_EXCLUSION_LEAF` in
     `src/projects/project-helpers.ts`, mirroring the Svelte client). The
     `card.select_with_attributes` spec encode forwards a `where` field, so the
     batch request ships `where:[leaf]`. Because the list and the scope
     `<select>` both read the ONE `shell.projects` path, the exclusion covers
     BOTH at once. `!=` compiles server-side to `NOT EXISTS`, so a project that
     never had `is_template` written still appears (correct — not filtered out
     client-side).
   - **Projects-data REUSE (no second fetch):** the AppShell `projects` query
     (`card.select_with_attributes`, `card_type_name='project'`) lands rows at
     the shared `shell.projects` tree path to drive its scope `<select>`.
     ProjectList declares NO projects query — it READS the same path
     reactively, so the list and the picker never diverge and there's one
     round-trip. (`toOption` accepts both the picker option shape and raw card
     rows so the path is robust to either landing there.) `landProjects` carries
     the project's `description` onto the option so the ✎ editor prefills from
     the same path with no refetch.
   - **Shared create/edit form (one common control):** `buildDialog()` builds
     ONE project-properties dialog (Title + Description) driven into either
     CREATE mode (Add & Another / Add & Close → `card.insert`) or EDIT mode
     (Save → `attribute.update`). `+ New project` calls `openCreate()`; the
     per-row ✎ calls `openEdit(id, title, description)` prefilled from the row.
   - **Create-project:** a static `createProject` `ActionBinding` →
     `card.insert` (`card_type_name='project'`, `title`, optional
     `attributes.description` when non-empty, NO parent — top-level) with an
     **optimistic** append of a temp-`-N`-id row to `shell.projects` that
     **auto-rolls-back on fault** (`onError:'top'`); the success sink
     (`landCreated`) swaps the temp id for the server-returned id. Because the
     picker reads the same path, the new project appears in both the list and
     the scope `<select>` with no extra wiring. The `card.insert` spec lives in
     `src/projects/specs.ts` — in `{ cardTypeName, parentCardId?, title,
     attributes?, phase? }` (camelCase → snake_case) / out `{ id }` (wire
     string → bigint), matching `server/internal/dom/card/insert.go`.
   - **Edit-project:** two static `ActionBinding`s — `editTitle` /
     `editDescription` — both REUSE the kanban `attribute.update` spec (one
     attribute per call). Save fires only the CHANGED field(s); each
     **optimistically** patches the matching `shell.projects` row in place and
     **auto-rolls-back on fault** (`onError:'top'`). The row and the scope
     `<select>` reflect the rename immediately.
   - Hierarchical hotkeys (the `projects` scope of `web/design/hotkeys.md`):
     `n` quick-create, `/` focus-search, `j`/`k` move selection, `Enter` open —
     all raised as INTENTS via an overridden `hotkeys()`, never imperative API
     calls.
2. **Navigation (signal-driven, NO router):** the AppShell holds a `shell.view`
   tree signal (`'projects' | 'board'`). A single cascade-safe effect reads ONLY
   `shell.view` and imperatively spawns/destroys the body control (ProjectList
   vs the board `ScreenHost`) — it never writes a signal it tracks. The rail
   "Projects" link + `g p` raise `goProjects` → `view='projects'`; selecting a
   project (ProjectList row click / `Enter`) writes `scope.projectId` (the path
   Kanban's `{ signal: 'scope.projectId' }` watches) AND `view='board'`; the
   per-project screen chords (`g k`/`g i`/`g g`/`g p` for project detail) flip
   `view='board'`. NotFound still resolves unknown layouts/types.
   `ScreenHost` now also mounts its declarative `children` into the body, so the
   board's unknown `SparkleChart` child renders the NotFound placeholder when
   the board view is active (graceful degradation preserved).
3. **New core affordance:** `Control.registerIntent(name, fn)` lets a control
   register its own UI-only intent handlers (open a dialog, move a selection)
   the same way the DataController registers action/query intents — so a hotkey
   or button raising `this.intent(name)` reaches a control method without an
   imperative API call on the key path.

Verified: `tsgo --noEmit` clean, `node --test` green (64 tests in this slice's
file incl. the new projects-data-reuse / render+search / select→scope+view /
create optimistic-commit + rollback / ScreenHost+NotFound regression / AppShell
view-swap tests, PLUS the polish tests: the projects query ships the
`is_template != true` leaf and a honoring transport excludes a seeded template
from list + picker; create-with-description sends `attributes.description` (and
a bare create sends no attributes); the shared form serves both create and edit;
edit fires `attribute.update` for only the changed field(s) and optimistically
patches + rolls back on a forced fault), `npm run build` clean. A LIVE smoke
against kitpd is optional and was not run this pass (relying on the unit suite).

### What the next screen (Inbox or Grid) reuses

- The **Project List → board navigation** (`shell.view` signal + the
  `scope.projectId` write) is the template for any landing→detail swap: add a
  new view value + a body control, raise an intent that writes `shell.view`.
- `Control.registerIntent` + the overridden `hotkeys()` pattern (intent-firing
  bindings) for any screen with `j`/`k`/`n`/`/`/`Enter` keyboard nav.
- The whole **AppShell + ScreenHost + ScreenFilterBar** frame: a new screen is
  a new `layout` entry in ScreenHost's `LAYOUT_TO_CONTROL` map + a registered
  body control. `list→Inbox` / `grid→Grid` already map; building those controls
  makes the existing ScreenHost resolve them instead of NotFound.
- The **specs** (`card.select_with_attributes` for both the task batch AND the
  axis value-cards — use it, not `card.select`, whenever a `title` is needed:
  the real `card.select` returns `title: null`) and the **declarative
  query/action pattern** (static `queries`/`actions`, `{ signal:
  'scope.projectId' }` reload, `skipWhenNull` scope guard, optimistic +
  rollback) — Inbox's drag-reorder is the same `optimistic` + `computeMoveBatch`
  shape (already lifted) with `with_personal_sort` on the read. NOTE for the
  next screen going live: card_ref attribute values arrive in the `attributes`
  object as JSON **numbers** and are only revived to `bigint` for card_ref attrs
  registered via `registerCardRefAttr` (the kanban registers `milestone_ref`);
  register each card_ref attr the screen keys on (e.g. `assignee`, `status`,
  `component_ref`) or compare ids by canonical string form. The
  `card.select_with_attributes` row also carries `created_at` /
  `last_activity_at` (and `personal_sort_order` when `with_personal_sort`) that
  Inbox/Grid will read.
- The **lifted kanban helpers** (`bucketByColumn` / `sortByOrder` /
  `planSortRewrite` / `computeMoveBatch`) for any grouped/ordered list.
- `src/core/keyed-list.ts` (the unit-tested reconciler) for the list-body
  controls. Each new screen control declares its `static queries`/`static
  actions` table (§11) rather than hand-writing `call(...)`.

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

const SSO_START_PATH = '/api/v1/auth/oidc/start';          // single constant
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
   /api/v1/auth/oidc/start?redirect=<path>` begins the OIDC dance and, after the
   IdP round-trip, lands the user back on `<path>` with a session cookie set.
3. `POST /api/v1/batch` is cookie-authenticated (same-origin; `fetchTransport`
   sends no Authorization header). On an expired/absent session it returns
   **HTTP 401** (or `403` for an authenticated-but-forbidden auth failure) so
   the client's funnel can bounce. Per-row `sub_error`s (e.g. `flow_disallowed`)
   are *not* auth failures and do not bounce.

---

## 13. Design principles & control taxonomy — the rule going forward

This section is the durable design contract for the control layer. Source
comments cite it as "ARCHITECTURE.md §13."

### Composition principle

**Lower-level primitives stay tiny and stable. New intent = new high-level
control. We do NOT grow knobs on primitives to cover new use cases — we name
the new use case in a new control and compose the same primitives behind it.**

The test of the principle: if a new use case needs a primitive to behave
differently, it's almost always a new *state* (model it as data), not a new
*config knob*. (Example: "the selection disagrees" became a `Mixed` kind on
`LoadState`, not a mode flag on `AttributeRow`.)

### L0 primitives — tiny, pure, screen-agnostic

| layer | primitive | duty |
| --- | --- | --- |
| type | `LoadState<T>` (`core/load-state.ts`) | the explicit async lifecycle: `Unset` / `Pending(v)` / `Value(v)` / `Error(prev,msg)` / `Mixed`. One shape every async value passes through. |
| stores | `PanelModel`, `BatchPanelModel` (`task-detail/`) | typed `Signal<LoadState<unknown>>` stores; each owns ONE semantic (single-task live edit vs. fan-out to a selection). Siblings, not modes. |
| control | `FieldEditor` (`ui/field-editor.ts`) | one editor per `attr.valueType`, routing to `RefPicker`/`DatePicker`/native input. Pure: config in, `onCommit` out. |
| control | `CardRefValue` (`ui/card-ref-value.ts`) | one ref id → resolved label render with pending/resolved states, driven by a `() => LoadState<string>` thunk. |
| control | `AttributeRow` (`ui/attribute-row.ts`) | label + summary + lazy-mounted `FieldEditor` + Unassign + inline error, all derived from ONE `() => LoadState<unknown>` thunk. |

Primitives are tested as primitives; they don't know about screens.

### High-level intent controls — each NAMED for its intent

| intent | control | commit semantic |
| --- | --- | --- |
| edit one task live | `TaskAttributePanel` | each row commits to `attribute.update` immediately |
| draft a new task with Save | `NewTaskForm` | each row seeds a draft store; Save dispatches one `card.insert` |
| edit N selected tasks | `BatchTaskEditor` | each row commits via fan-out across the selection |

A new need ("edit a project's metadata as a panel", "edit with diff preview") is
another high-level control composing the same primitives — not a knob on one.

### Cascade-safety rules (do not recreate the Svelte effect-cascade)

The signal core throws a **named `SignalCycleError`** listing live effects when a
flush fails to converge (§3) — never a silent depth cap. To stay out of it:

1. **Derive, don't mirror.** Never use an effect whose only job is to copy one
   signal into another; use `computed`/derived reads.
2. **One-way loads.** A trigger effect tracks *only* primitive keys (ids/slugs/a
   version) and writes *only* into the tree the view derives from — never back
   into a tracked dep, never into a foreign store another effect tracks.
3. **Fine-grained writes.** Mutate tree nodes in place; don't reassign whole
   collections (that invalidates every reader and fans out cascades).

The declarative data layer (§11) enforces these by construction: triggers are
explicit, inputs are pure resolutions, results land in defined tree sinks.

---

## 14. Current state & known gaps

The proof slice (§10) grew into the full client. All v1 screens are built and
wired against the real `/api/v1/batch` (`USE_REAL_BACKEND = true` is the app
default); `node --test` runs **61 test files**; `tsgo --noEmit` is the type
authority.

### Built & wired

- **Shell / nav** — History-API router (deep-links, back/forward,
  `/project/:id/screen/:slug`, `/task/:id`, `/admin/:key`, `requireAdmin`);
  AppShell frame; signal-driven outlet swap; hierarchical hotkeys; `?` help
  overlay (server-driven via `help.get_topic`); user menu + logout.
- **Screens** — Project list, Project detail, Inbox/List, **Kanban**
  (group-by axis, swim lanes, within-column reorder, cross-column move,
  per-column quick-add, virtualized columns, `hjkl` nav), **Grid**
  (data-driven column set, row grouping, sortable headers, inline cell edit,
  column show/hide/reorder/resize, bulk-action bar, virtualized rows),
  **Task detail** (two-column; inline markdown title/description;
  `TaskAttributePanel`; `TransitionBar`; comments + activity; chunked CAS
  attachments + gallery; tags editor; related/sub-tasks; comms/email threads).
- **Filter/view system** — structured predicate tree, data-driven quick chips,
  named/saved filters + preset selector, group-by axis, per-`(project,slug)`
  view persistence, default-filter-on-first-visit.
- **Admin** — 12 views on MasterDetail (flows, edges, screens, comm channels,
  activity sinks, agents/tokens, role mappings, people/roles, …) with
  create/delete/inline-edit/nested editors.
- **Primitives** — Combobox, DatePicker, RefPicker, Popover, Modal, Markdown
  render+sanitize, quick-entry overlay, import wizard, export menu.

### Known gaps / next structural work

- **(5) Data-layer enforcement** (highest-leverage remaining): lift the
  imperative `callByName` sites (notably TaskDetail's read path) into `static
  queries`/`static actions` so every read is cascade-safe + auto-resubscribed.
  ~38 files still call `callByName` directly.
- **(4) Keyed reconciliation** for the remaining `replaceChildren` paints
  (grid cells on scroll-into-view, kanban column rebuilds). `core/keyed-list.ts`
  exists; the deeper signal-driven lift waits on a reproducible flash test.
- **TaskDetail mirrors** — `this.task` + `refLabels: Map` are still mirrored
  alongside the `PanelModel`; a `PanelModel.refLabelPeek` would close the
  synchronous-lookup gap. Imperative title/description editors aren't on the
  panel store yet (tracked by a code TODO).
- **Roving tabindex** across grid rows / kanban cards (focus-trap shipped;
  per-row arrow-cursor is partial).
- **Verify-only** — `project.stamp`, `card.move` (reparent), `card.set_phase`,
  `card.undelete`, `help.get_screen` have no web caller yet.

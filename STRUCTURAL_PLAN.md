# web/ structural plan

A living doc capturing why the `web/` framework feels imperative-DOM-heavy,
what closes the gap, and the order we're tackling it.

## Audit (2026-05-30)

What's there is roughly: signals + a Control base + a declarative data layer.
What's missing is composition + binding + a shared field abstraction. The
quantitative picture:

- **Top screens are 6-21x more `createElement` than `spawn`.**
  - `task-detail/task-detail.ts` (1691 lines): 53 `createElement` vs 8 `spawn`
  - `grid/grid.ts` (1668 lines): 30 vs 4
  - `kanban/kanban.ts` (1327 lines): 21 vs 0
  - `inbox/inbox.ts` (1334 lines): 21 vs 0
- **Signals are imported in 15 files but `this.effect()` blocks are sparse**:
  grid 11, kanban 8, inbox 2, task-detail/task-detail.ts 0, tags-editor.ts 0,
  enum-manager.ts 0. Most controls mutate state imperatively then call a
  `paint*()` method that wholesale-rebuilds DOM with `replaceChildren()`.
- **102 `replaceChildren`/`innerHTML=` call sites.** The dominant reactive
  pattern is "signal changes → effect runs → blow away subtree → rebuild".
  No diffing for cells, rows, or panels.
- **Label-resolution is reimplemented per screen.** `grid.labelForGroupKey`,
  `inbox.labelForGroupKey`, `task-detail.labelFor`,
  `related-tasks-panel.labels.get(...)`, the kanban axis lookup —
  `map[id.toString()] ?? '#'+id.toString()` written five times. The recent
  `asAttrId()` centralisation covers the coercion half of this; the
  rendering half is still scattered.
- **`static queries` (the declarative data layer) is used by 8 controls.**
  37 files reach for imperative `this.ctx.api.callByName(...)` for at least
  one op. The cascade-safe loading story applies to maybe a ninth of the
  surface.

The "different attribute had different ID-vs-name bugs" complaint isn't a
flaky-test problem — it's the absence of a shared FieldEditor / CardRefValue
control. Every TaskDetail row, every grid cell, every kanban chip
re-derives label resolution on its own.

## The gap, plainly

We have the bones of a custom signal + control framework but pay the
verbosity tax without claiming the leverage:

- Controls don't compose into Controls — they emit DOM.
- Signals notify but don't drive the DOM directly.
- The declarative data layer is real but bypassed.

## Roadmap

Six items. Independent enough to tackle individually; (1) and (2) together
would eliminate the per-attribute drift class of bug.

1. **FieldEditor family.** One config-driven control taking
   `{ attrSchema, value, onCommit, onErr }`, routing internally by
   `value_type` to RefPicker / DatePicker / native input. Consumers
   (TaskDetail panel, BulkActionBar, grid inline edit, quick-entry,
   admin) stop hand-implementing per-type editors.
2. **CardRefValue.** Read-only render of `{ id, targetCardType }` →
   resolved label, with loading state + late-arrival fade-in. Replaces the
   ≥5 reimplementations.
3. **SectionPanel / AttributeRow primitive.** Shared chrome for the
   task-detail right rail (Attributes / Tags / Attachments / Related /
   Transitions) so each section isn't a bespoke `<section><h2><body>`.
4. **Replace `replaceChildren()` paint with keyed reconciliation.** Lift
   `core/keyed-list.ts` everywhere a list is rendered, or adopt a tiny
   `h(tag, attrs, children)` + diff so signal-driven updates patch
   instead of rebuild. This is what kills the visible flashes.
5. **Outlaw imperative `callByName` outside `static queries`.** Force
   loading through DataController so every read is cascade-safe + auto
   re-subscribed on scope change.
6. **Signal-binding helpers on the Control base.** `bindText`, `bindAttr`,
   `bindClass`, `bindShow`, `bindProp` — each registers an effect via
   the Control's existing `effect()` so teardown is automatic. Pushes the
   `this.effect(() => el.x = sig.get())` pattern into one line and makes
   signals first-class in the Control API.

## Sequence

1. **Now — item (6).** Smallest blast radius; lays the binding surface that
   (1) will lean on.
2. **Next — item (1) FieldEditor.** First real test of the helpers, and
   directly attacks the "different bugs per attribute" failure mode.
3. **Retrospective.** Append a section to this doc: what the helpers
   actually look like in practice, did FieldEditor reduce TaskDetail's
   `createElement` count materially, are we ready to push into (2)/(4).
4. **Then** — pick (2) CardRefValue or (4) keyed reconciliation based on
   what the retro tells us hurt the most.

## Constraints

- All changes land WITH passing tests + a clean `tsgo` check.
- No CSS-only fix for a structural problem — if a flash is caused by
  `replaceChildren`, the fix is structural, not animation.
- Keep the Control base under ~600 lines. The helpers should feel like
  one-liners, not a framework rewrite.

## Retrospective — items (6) + (1) (2026-05-30)

### What landed

- **(6) Signal-binding helpers** on the `Control` base:
  `bindText` / `bindAttr` / `bindClass` / `bindShow` / `bindProp` /
  `bindStyle`. Each accepts a `Signal<T>` OR a `() => T` thunk; both forms
  track signal reads via the underlying `this.effect()`. ~100 lines added to
  `core/control.ts`, plus a `readSource` resolver helper. 6 new unit tests in
  `test/control.test.mjs` cover the basics + the "teardown stops the effect"
  guarantee.
- **(1) FieldEditor** at `ui/field-editor.ts` (280 lines): one control routes
  to `RefPicker` / `DatePicker` / native input by `attr.valueType`. Pure —
  config in, `onCommit` out. `TaskDetail.mountEditor`'s 6-arm switch (~150
  lines) collapses to ~15 lines that spawn one FieldEditor and forward the
  commit through `commitAttribute`. 10 unit tests in
  `test/field-editor.test.mjs` pin the routing contract.

Total: 670 / 670 tests passing; `tsgo` clean.

### Numbers

| metric | before | after |
| --- | --- | --- |
| `task-detail.ts` lines | 1691 | 1566 |
| `task-detail.ts` `createElement` | 53 | 49 |
| `task-detail.ts` `spawn` | 8 | 7 |
| `field-editor.ts` lines | — | 280 |
| `field-editor.ts` `createElement` | — | 4 |
| `field-editor.ts` `bind*` helpers used | — | 3 |

The `createElement` count BARELY moved in `task-detail.ts` — only 4 fewer.
That's an honest signal: the 6-arm switch was ~150 lines but only 4 of them
were raw `createElement`. The win isn't line count; it's that those 4
elements + their event wiring now live in ONE place (FieldEditor) instead of
duplicated across TaskDetail + the BulkActionBar value editor + the grid's
inline cell edit. The "different bugs per attribute" failure mode is gone
by construction — there's nothing to drift against.

### What worked

- **The binding helpers are tiny and self-documenting.** A `bindText(el, sig)`
  call reads exactly as "this text follows that signal." The thunk form
  (`bindText(el, () => combine(a.get(), b.get()))`) handled the mixed-source
  case without requiring a `computed()`.
- **FieldEditor as a pure control was the right call.** It composes with the
  existing `RefPicker` / `DatePicker` (no rewrites). The parent still owns
  persistence; the editor only owns the gesture → value coercion. This is
  what makes it reusable across TaskDetail / BulkActionBar / grid inline edit
  without dragging a focal-task assumption into the inner control.
- **TypeScript stayed clean.** The discriminated `ControlConfigMap` augmentation
  pattern works fine for new controls: one `declare module` block at the top
  of `field-editor.ts` and call sites get typed configs.

### What didn't (or, what surprised us)

- **The bindings are underused in FieldEditor itself.** Only `bindProp` shows
  up — twice for `value`, once for `checked`. The ref / date arms just spawn
  a child control; the text / number arms could use `bindClass` for a
  "draft dirty" affordance but currently don't. (6) was the right
  groundwork, but (1) wasn't the right showcase — a future "live attribute
  panel" that re-renders cells as a task changes would exercise the helpers
  far more.
- **Auto-open across types needed a config knob.** Tests don't want the
  date picker popping its calendar; production code always does. Ended up
  with a `noAutoOpen` escape hatch. Acceptable, but it's the kind of leak
  that suggests "open immediately" is more a parent concern (TaskDetail
  decides), and FieldEditor should be open-on-mount silent. Worth revisiting.
- **jsdom event constructors** required care — bare `new KeyboardEvent`
  resolves to a different global than jsdom's `window.KeyboardEvent`. The
  existing `keydown` helper in `test/ui-dom-setup.mjs` covered it; for
  generic blur/change a small `fire(target, type)` helper lives next to
  the FieldEditor tests. Worth promoting both into the shared setup.
- **TaskDetail.mountEditor.spawn count didn't fall to 1.** It stayed at 1
  per row because each row mounts its OWN FieldEditor. To collapse the
  panel further we'd need item (3) (AttributeRow primitive) so the row
  itself is a control that internally spawns its FieldEditor.

### Calibration for next items

- **(3) AttributeRow primitive** rises in priority. With FieldEditor in
  hand, an `AttributeRow` could be `<details><summary>{label} {value}</summary><FieldEditor/></details>`
  with `bindText` for the summary and `bindShow` for the editor. That ALSO
  finally exercises the binding helpers in a real reactive setting.
- **(4) keyed reconciliation** still matters most for the visible flashes
  (grid cells, kanban columns, task-detail panel rebuild). FieldEditor
  didn't touch that.
- **(2) CardRefValue** is well-defined and small. Could be done in parallel
  with (3); the AttributeRow's summary text would consume CardRefValue.

### Proposed next move

(3) AttributeRow + (2) CardRefValue together — they reinforce each other and
let us measure the binding helpers in their natural habitat. Defer (4) until
we have a profiling case where a flash is reproducible in tests.

## Retrospective — items (2) + (3) (2026-05-30)

### What landed

- **(2) CardRefValue** at `ui/card-ref-value.ts` (110 lines).  A read-only
  span that resolves a single id via a `labelFor` thunk, with
  `data-card-ref-resolved` / `--pending` hooks for fade-in styling.  5
  `bind*` calls; one of them — `bindText(() => labelFor(id) ?? '#'+id)` —
  is the late-arrival pattern the audit said was reimplemented in 5
  places.  7 unit tests pin the contract (null → '—', late label
  repaints, resolved class flips, destroy stops the binding).
- **(3) AttributeRow** at `ui/attribute-row.ts` (246 lines).  `<details>`
  row with reactive summary, lazy-mounted `FieldEditor` on first expand,
  Unassign button toggled by `bindProp(disabled, ...)`, inline error
  driven by `bindText` + `bindShow`.  Pure `computeSummary` /
  `hasMeaningfulValue` helpers are unit-tested directly.  8 unit tests
  + the existing 25 TaskDetail tests cover it end-to-end.
- **TaskDetail panel re-wired.**  `renderRow` (54 lines), `mountEditor`
  (~30 lines), `buildUnassignButton` (~25 lines), `hasMeaningfulValue`
  (~7 lines), `summaryFor` (~20 lines), and `labelFor` (~3 lines) — all
  deleted from `task-detail.ts`.  `renderPanel` is now ~40 lines, and
  `commitAttribute` shed its `errEl` parameter.  Errors flow through a
  `attrErrors: Map<string, string>` read by `AttributeRow.errorText`
  via a `panelVersion` signal.
- **Per-attribute repaints, not panel-wide ones.**  Five call sites that
  used to do `this.renderPanel()` (tags edit, related-tasks edit,
  transition-bar edit, ref-label arrival, status transition) now call
  `this.bumpPanel()`.  Same outcome, no wholesale rebuild.

Total: 685 / 685 tests passing; `tsgo` clean.

### Numbers

| metric | before (after item 1) | after items 2+3 |
| --- | --- | --- |
| `task-detail.ts` lines | 1566 | 1453 |
| `task-detail.ts` `createElement` | 49 | 42 |
| `task-detail.ts` `spawn` | 7 | 7 |
| `task-detail.ts` `renderPanel()` calls | 6 | 2 (schema + initial load) |
| new control LOC (`card-ref-value` + `attribute-row`) | — | 356 |
| `bind*` calls across the new controls | — | 12 |

- `createElement` in `task-detail.ts` fell 7 (49 → 42). The bigger story:
  the 4 `renderRow()` per-row `createElement`s collapsed into ONE
  `spawn('AttributeRow', ...)` per row.
- The `spawn` count didn't move because we already replaced the
  per-editor spawn with `FieldEditor`. The row is the NEW spawn target
  — and AttributeRow internally spawns FieldEditor, so the depth is
  visible in `Control.childControls()` not in this number.
- `renderPanel()` calls in `task-detail.ts` fell from 6 to 2.  Every
  in-flight data mutation now bumps a signal; only schema load + a
  cold task swap rebuild rows.

### What worked

- **The binding helpers paid off in CardRefValue.**  `bindText(() =>
  labelFor(id) ?? fallback)` is exactly the API the audit was missing
  — one line replaces ~5 reimplementations.  Late-arrival fade-in
  becomes a CSS concern once the `--resolved` class is bound.
- **AttributeRow's lazy mount + reactive summary is the right split.**
  The summary stays cheap (bindText with a `panelVersion.get()`), the
  editor only spins up on the first expand.  Tests verify that a
  collapse+re-expand doesn't re-spawn the FieldEditor.
- **`panelVersion` signal as a bridge is a good intermediate step.**
  It lets us go reactive WITHOUT lifting `this.task` and
  `this.refLabels` into proper signals everywhere.  Five `renderPanel()`
  call sites became `bumpPanel()`; the rest of TaskDetail stays the
  imperative shape it had.  When item (4) tackles the broader signal
  lift, the `bumpPanel()` calls become dead.
- **Per-attribute error map (`attrErrors`) replaces the per-row `errEl`
  ref-passing.**  No more "did I remember to update both the value and
  the disabled state from inside the onErr callback?" — `bumpPanel()`
  picks up everything.

### What didn't (or, surprises)

- **`bindProp(btn, 'disabled', thunk)` had a subtle UX cost.**  Earlier,
  `btn.disabled = !this.hasMeaningfulValue(attr)` was set on mount AND
  again from inside the unassign click handler's `onDone`.  Now it's
  signal-driven, so during the in-flight commit the button briefly
  flickers enabled→disabled→enabled as `value()` swings null→prev→null.
  Not visible in tests, but worth watching in the browser.  A
  bindClass-only "is-pending" cover-up would mask it.
- **The `panelVersion` is still a manual bump.**  Every mutation
  has to call `this.bumpPanel()`.  Forgetting one would leave a row
  stale.  Item (4) (proper signal-driven task model) would fix this
  by construction.
- **AttributeRow took over Unassign, but only for non-bool types — and
  the rule lives in the new control.**  This was previously a
  per-screen carve-out in `buildUnassignButton(returns null)`.  The
  carve-out moved, didn't go away.  Acceptable but documents that
  AttributeRow has opinions about the bool valueType that other
  consumers (a future BulkActionBar use case) may want to override
  via a `noUnassign?: boolean` config flag.
- **errorText defaults to `() => undefined` would be cleaner than the
  optional `errorText?: () => string | undefined`.**  The current
  guard `if (errorText !== undefined)` is small but it's the kind of
  optional that future bugs (forgot to pass it, no errors render)
  hide in.  Consider promoting it to always-present.

### Calibration for next items

- **(5) Outlaw `callByName` outside `static queries`** is starting to
  look like the highest-leverage remaining structural item.  `38` files
  call `callByName` (we counted 37 before; +1 is FieldEditor / friends).
  Lifting even half of those would let the framework's cascade-safe
  loading story actually apply.  Risk: the migration is mechanical but
  touches a lot of surface.
- **(4) keyed reconciliation** still owns the visible flashes (grid
  cells repaint on every scroll-into-view, kanban columns rebuild
  wholesale).  But it's a deeper change than (5), and we don't yet
  have a reproducible flash test.  Defer until we do.

### Proposed next move

(5) Data-layer enforcement on TaskDetail.  Lift its 8 `callByName`
sites (`loadSchema`, `loadTask`, `redirectIfCommCard`,
`resolveRefLabels`, `pollOnce`, `commitAttribute`) into `static queries`
+ `static actions`.  That hits the real concern (cascade-safe reads,
auto resubscribe on scope change), validates the framework can model
the messier real-world cases, and clears the way for the broader (5)
migration across screens.

## Refinement (2026-05-30) — LoadState + PanelModel

Direct response to the "avoid flickering harder; centralise + declare the
model" critique after (2)/(3) landed.

### What landed

- **`core/load-state.ts`** — `LoadState<T>` discriminated union
  (`Unset` / `Pending(v)` / `Value(v)` / `Error(prev, msg)`) +
  constructors + predicates (`isUnset` / `isPending` / `isResolved`
  / `isError` / `hasValue`) + accessors (`valueOf` / `errorOf`).  ONE
  declared shape every async value passes through.  6 unit tests pin
  the lifecycle.
- **`task-detail/panel-model.ts`** — `PanelModel` typed store: per-
  attribute `Signal<LoadState<unknown>>`, per-(target,id) ref-label
  signal.  Methods: `seedAttr` / `seedFromAttributes` / `beginCommit`
  / `confirmCommit` / `rejectCommit` / `clearError` / `refLabel` /
  `setRefLabel`.  Plus `isMeaningful()` — the empty-value predicate
  that lives in exactly one place.  12 tests.
- **`ui/card-ref-value.ts` refactored.**  Contract changed from
  `labelFor: (id) => string | undefined` to `label: () => LoadState<string>`.
  The chip now reads the lifecycle: `Unset` shows `#id` + the
  pending tone; `Value` shows the resolved label + the resolved
  tone; `data-card-ref-state` carries the kind for CSS / tests.
- **`ui/attribute-row.ts` refactored.**  Contract changed from
  `(value, labelFor, errorText)` thunks (three sources of truth)
  to a SINGLE `state: () => LoadState<unknown>` thunk.  Every visible
  surface — summary, busy class, Unassign disabled, inline error —
  derives from one read.  Added `data-attr-state` + `--pending` /
  `--error` row modifiers.
- **`task-detail.ts` rewired.**  Deleted `panelVersion` signal,
  `attrErrors` map, `bumpPanel()` helper, the `commitAttribute(name,
  value, onDone)` arg pattern.  Replaced with one `panel: PanelModel`
  field.  `commitAttribute` is now a clean three-line lifecycle
  drive (`beginCommit` → API → `confirmCommit` / `rejectCommit`).
  Five formerly-imperative `bumpPanel()` / `renderPanel()` call sites
  at sibling-section change events (transitions / tags / related) now
  call `panel.seedAttr(name, value)` — the typed mutation API.

Total: 702 / 702 tests passing; `tsgo` clean.

### Numbers

| metric | before refinement | after |
| --- | --- | --- |
| ad-hoc state fields on TaskDetail | 3 (`panelVersion`, `attrErrors`, `refLabels`) | 1 (`panel: PanelModel`) + the kept `refLabels` mirror |
| `bumpPanel()` call sites | 6 | 0 (deleted) |
| `task-detail.ts` lines | 1453 | 1467 |
| new declared model LOC | — | 142 (load-state) + 168 (panel-model) |

The line count BUMPED 14 — the code is doing more work (drive
beginCommit / confirmCommit / rejectCommit + carry an extra `postRender`
hook for the imperative title/description editors).  The structural
win is downstream: a future control needing optimistic-commit state
just declares `panel.attr('x')` and reads the same Signal<LoadState>
— no per-control "bumpPanel + attrErrors Map" boilerplate.

### The flicker, killed

The `bindProp(disabled, () => !hasMeaningfulValue(value()))` flicker
the (2)/(3) retro flagged is GONE.  Pinned by the
"Unassign locks during Pending" test — the regression we wrote to
guard the refactor.  The Unassign button now reads the lifecycle
(`isResolved` AND meaningful) instead of the raw value, so an
in-flight commit holds it busy for the entire round trip.

### What worked

- **One discriminated union for the lifecycle, one store class.**
  After this refactor, "is this value loaded, in flight, confirmed,
  or failed?" has ONE answer.  Renderers stop computing
  intermediate states; they read `state.kind` and branch.
- **`isMeaningful` lives in PanelModel and AttributeRow both, with
  a doc-comment cross-reference.**  Acceptable duplication —
  AttributeRow stays a pure UI control with no upward import of
  the panel store, and a divergence in the predicate would be
  caught by either test suite.
- **The DOM shim got fixed.**  `setAttribute('data-foo-bar', v)`
  now correctly mirrors to `dataset.fooBar` so tests can probe
  binding-driven attributes the same way real-DOM tests do.
- **No new flash regressions.**  The 702 tests include all 25
  TaskDetail end-to-end tests; they all pass with the new contract.

### What didn't (or, what surprised us)

- **Imperative title / description editors still re-render off
  `this.task.attributes`.**  They're NOT on the panel store — they
  have their own `editingTitle` / `editingDescription` boolean
  state and their own re-paint methods.  I had to thread a
  `postRender()` hook through `commitAttribute` so a server-reject
  re-renders them with the rolled-back value.  This is a leak;
  the right fix is to subscribe the title input to
  `panel.attr('title')` and let bindProp do the work.  Logged as
  a follow-up TODO in the code.
- **`this.task` is still mirrored alongside `this.panel`.**  Two
  reasons: (a) downstream sections (`TagsEditor`, `RelatedTasksPanel`)
  seed from `this.task.attributes['tags']` synchronously at mount,
  (b) `this.task.parent_card_id` is a top-level field the panel
  store doesn't model.  Migrating (a) means each sibling section
  consumes the panel store; (b) probably means the panel model
  grows a `card()` signal too.  Both deferrable.
- **`refLabels: Map<string, string>` is also still mirrored.**
  Some legacy seed paths (RefPicker pre-population) want a
  synchronous string lookup.  The signal API is `Signal<LoadState>`
  which doesn't expose a sync peek shortcut for "give me the
  label or undefined".  A `model.refLabelPeek(target, id):
  string | undefined` would clean this up.

### Calibration for next items

- **(5) data-layer enforcement** stays the highest leverage.  With
  PanelModel established, the pattern for "wrap an API call in a
  typed lifecycle store" is clear — applying it to the 8 callByName
  sites on TaskDetail is the next concrete step.
- **(4) keyed reconciliation** is now better-positioned: a row
  re-paint with no flicker means the failure modes we'd be
  diffing against are documented and testable.

### Proposed next move

(5) on TaskDetail's read path.  Lift `loadSchema` / `loadTask` /
`resolveRefLabels` into `static queries` so the schema + task + ref
labels arrive into the panel store as a side-effect of the
declarative bindings, not via imperative `callByName` callbacks.
That'll let us delete the `refLabels` Map mirror and start to
quantify the (5) win.

## Composition principle (2026-05-30) — the project's rule going forward

**Lower-level primitives stay tiny and stable.  New intent = new
high-level control.  We do NOT grow knobs on primitives to cover new
use cases — we name the new use case in a new control and compose the
same primitives behind it.**

The lower-level set caps at a handful:

| layer | primitive | duty |
| --- | --- | --- |
| L0 type | `LoadState<T>` | the explicit lifecycle |
| L0 stores | `PanelModel`, `BatchPanelModel` | typed signal stores; each owns ONE semantic |
| L0 controls | `FieldEditor` | one editor per `attr.valueType`, pure (config in, onCommit out) |
| L0 controls | `CardRefValue` | one ref id → label render, pure |
| L0 controls | `AttributeRow` | label + summary + lazy FieldEditor + Unassign + error, driven by one state thunk |

That's it for primitives.  They're tested as primitives; they don't
know about screens.  Above them sit high-level controls — each one
NAMED FOR ITS INTENT — that compose the primitives:

| intent | control | commit semantic |
| --- | --- | --- |
| edit one task live | `TaskAttributePanel` | each row commits to `attribute.update` immediately |
| draft a new task with Save buttons | `NewTaskForm` | each row seeds a draft store; Save dispatches one `card.insert` |
| edit N selected tasks (fan-out) | `BatchTaskEditor` | each row commits via fan-out across the selection |

If a new screen needs "edit attributes of a deleted-and-recovered
task" or "edit a project's metadata as a panel" or "edit attributes
with diff preview before commit" — that's another high-level control,
not a knob.  The primitives stay still.

### What landed in this push

- **`Mixed` kind on `LoadState`.**  The "selection disagrees" lifecycle
  state.  Sister to `Unset` (no value), `Pending` (in flight),
  `Value` (resolved), `Error`.  Frozen singleton + `isMixed` predicate
  + `valueOf(mixed) === undefined`.  Tested.
- **`BatchPanelModel`.**  A SEPARATE class from `PanelModel`.  Same
  `Signal<LoadState<unknown>>` contract; different semantic.  Folds N
  rows into a single state (Unset / Value / Mixed).  Drives a fan-out
  lifecycle through `beginCommit` / `settleCommit` (with `FanOutResult`
  carrying ok + failed counts).  Tested.  Did NOT grow `PanelModel`
  with a mode discriminator.
- **`AttributeRow` learned about `Mixed`.**  Summary text renders
  `[mixed]`; the `data-attr-state="mixed"` hook + `task-detail__row--mixed`
  class drive styling; Unassign is ENABLED in Mixed (the user's
  explicit "flatten to empty" gesture).  ONE change to the primitive,
  not a knob — the new state is data, not policy.
- **`TaskAttributePanel`.**  High-level intent control.  Owns "render
  the schema's rows against a single-task PanelModel and live-commit."
  TaskDetail's inline `renderPanel()` loop is gone; it spawns
  `TaskAttributePanel` instead.  No regression — 25 TaskDetail tests
  still pass.
- **`NewTaskForm`.**  High-level intent control.  Owns "deferred
  draft + Save / Save & Another / Save & Open."  Renders the same
  AttributeRows but each row's commit seeds the draft store; the
  Save button snapshots the draft and dispatches one `onSubmit`.
  Includes the required-attr gate (`title` by default), the `busy`
  thunk for in-flight disable, and the multi-intent button row.
  Tested.  Not yet wired into QuickEntry — that migration is a
  follow-up (QuickEntry has tags/attachments/parent-task resolution
  the form doesn't model).
- **`BatchTaskEditor`.**  High-level intent control.  Owns "fan-out
  to selection."  Renders the same AttributeRows against a
  BatchPanelModel; each row's commit forwards to a parent-supplied
  `onApply(name, value)` that does the fan-out.  Includes the
  selection-size header line.  Tested.  Not yet wired into
  BulkActionBar — same follow-up shape as QuickEntry.

### Numbers

| metric | before | after |
| --- | --- | --- |
| primitives (L0) | 4 controls + 2 stores + LoadState | unchanged (4 + 2 + LoadState, with Mixed added to LoadState) |
| high-level intent controls | 0 | **3** (TaskAttributePanel, NewTaskForm, BatchTaskEditor) |
| `LoadState` kinds | 4 | **5** (Mixed added) |
| `task-detail.ts` `renderPanel()` LOC | ~40 | **~25** (delegates to TaskAttributePanel) |
| total tests | 702 | **737** (+35 from the new primitives + intent controls) |

### What worked

- **Three high-level controls instead of one `policy` enum.**  Each
  reads cleanly: the name tells you what it does.  `BatchTaskEditor`
  isn't "AttributePanel in batch mode"; it's its own control.  The
  primitives behind it are identical, but the screen says what it
  means.
- **`Mixed` was a data change, not a policy change.**  Adding a new
  `LoadState` kind was the right framing — the row renders the state
  it sees; it didn't need a new mode.  This is the test of the
  principle: if a new use case needs a primitive to behave
  differently, it's likely a new STATE, not a new CONFIG.
- **`BatchPanelModel` as a sibling class.**  PanelModel didn't grow.
  Each store owns one semantic.  Tests for each pin the contract.
- **Tests cleanly partitioned.**  6 tests for `TaskAttributePanel`,
  7 for `NewTaskForm`, 5 for `BatchTaskEditor`, 15 for
  `BatchPanelModel`.  Each control's intent is asserted at its own
  layer; failures localize.

### What didn't (or, follow-ups)

- **QuickEntry not migrated.**  QuickEntry's modal carries tags +
  attachments + parent-task resolution + project chooser + the Esc
  trap and route side-effects.  `NewTaskForm` is the right control to
  host the ATTRIBUTE form portion inside QuickEntry, but the
  migration also requires factoring QuickEntry's submission pipeline
  to consume the form's `onSubmit(attrs, intent)` shape.  Doable as a
  focused follow-up; not done this turn.
- **BulkActionBar not migrated.**  Same shape: `BatchTaskEditor`
  handles the value pickers, the bar still owns the docked chrome +
  selection set + per-row write fan-out.  Migration is
  straightforward but unscoped this turn.
- **`refLabels` on BatchPanelModel.**  The fan-out's `appliedValue`
  for a card_ref doesn't carry a label.  Today the row falls back to
  `#id`; once BulkActionBar is migrated, it should set the shared
  PanelModel's `refLabel` so all surfaces resolve consistently.
- **The single-task `PanelModel.refLabel` doesn't peek synchronously.**
  Still mirroring through `this.refLabels: Map<string, string>` in
  TaskDetail because some seed paths (`RefPicker` pre-pop) want a
  sync `string | undefined`.  A `PanelModel.refLabelPeek` helper
  would close this.

### Next moves, in order

1. **Wire QuickEntry to `NewTaskForm`** for its attribute form
   portion.  Keep the modal chrome + submission pipeline; replace
   the per-field bespoke handlers.
2. **Wire BulkActionBar to `BatchTaskEditor`** for its value pickers.
   The fan-out dispatch + the {ok, failed} accounting goes into the
   bar; `model.settleCommit` closes the loop.
3. **`PanelModel.refLabelPeek`** — close the synchronous lookup gap.
4. **(5) data-layer enforcement** — the higher-leverage structural
   item still on deck.

## Retrospective — QuickEntry per-type editor → FieldEditor (2026-05-30)

### What landed

- **QuickEntry's `renderAttrEditor` now composes `FieldEditor`.**  The
  "+ Add field" rows used to re-derive the full six-arm `valueType`
  switch (card_ref / card_ref[] → RefPicker, date → DatePicker, bool →
  checkbox, number/text → native input) — a verbatim duplicate of the
  switch FieldEditor owns.  That ~65-line method collapsed to a ~15-line
  `spawn('FieldEditor', …)` whose `onCommit` feeds the row's draft value.
  The drift class (a card_ref coercion bug fixed in TaskDetail but not in
  QuickEntry, etc.) is gone by construction — there is one editor now.
- **`noAutoOpen: true` preserves QuickEntry's add-on-demand UX.**  Picking
  a field from the row's `<select>` mounts the editor silent; the user
  clicks in to edit (no calendar/popover springing open the instant a
  field is chosen).  This is the escape hatch the items (1) retro flagged
  — and QuickEntry is exactly the "parent decides when to open" consumer
  it was meant for.
- **The unused `DatePicker` import dropped** (FieldEditor owns date
  routing now); `RefPicker` stays (assignee/tags pickers still spawn it
  directly — those are well-known slots, not palette attributes).
- **2 new tests** in `test/quick-entry.test.mjs`: one pins the routing
  (text → native input, re-pick card_ref → RefPicker), one drives a text
  commit end-to-end and asserts the value rides the `card.insert` as an
  additional attribute.

Total: 739 / 739 tests passing; `tsgo` clean.

### Numbers

| metric | before | after |
| --- | --- | --- |
| `quick-entry.ts` lines | 1300 | 1267 |
| `quick-entry.ts` `createElement` | 52 | 50 |
| `quick-entry.ts` `this.spawn(` call sites | 4 | 3 |

The two raw `createElement`s (the bool checkbox + the text/number input)
and the two separate ref/date `spawn`s collapsed into ONE `FieldEditor`
spawn.  As in the TaskDetail item (1) retro, the line count isn't the
story — the win is that QuickEntry no longer owns per-type editor code at
all; it consumes the primitive.

### Why NOT "wire to NewTaskForm" (the move (1) as originally phrased)

`NewTaskForm` renders the WHOLE schema as `AttributeRow`s with Save
buttons.  QuickEntry's body is the opposite shape: title + description
always visible, plus *add-on-demand* rows where the user first picks
WHICH attribute to add.  Dropping `NewTaskForm` in wholesale would fight
that UX (and QuickEntry already owns its own Save / Save & Another / Save
& Edit footer + the tags / attachments / status-resolution pipeline the
form doesn't model).  The composition-principle-correct reading is that
the per-field VALUE EDITOR is the reusable unit — and that unit is the
`FieldEditor` primitive, the same one `NewTaskForm` composes inside its
rows.  So QuickEntry composes the primitive directly rather than nesting
a whole-form control.  Primitives stay still; the screen keeps its intent.

### Still on deck

- **BulkActionBar → its value editor.**  `onAttrPicked` still hand-rolls
  a RefPicker single / multi + a (currently dead) scalar-choices Combobox
  arm.  It's a candidate for `FieldEditor`, but with two caveats that make
  it a separate, careful change: (a) FieldEditor has no scalar-choices
  arm (no live axis produces one today, so migrating would DROP that
  latent capability — a FieldEditor concern to add deliberately, not a
  per-screen reimplementation), and (b) the bar's "Apply" enable logic
  re-runs on every value change, whereas FieldEditor's text/number arms
  commit on Enter/blur.  Both are fine for today's all-ref axes but want
  an explicit decision.  The bar's staged-chips "+ Add / Apply" model
  also doesn't match `BatchTaskEditor`'s per-row immediate commit, so the
  originally-planned `BatchTaskEditor` wiring needs the bar's batch
  semantic reconciled first.
- **`PanelModel.refLabelPeek`** and **(5) data-layer enforcement** remain
  the next structural items, unchanged.


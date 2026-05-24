# kitp web client — hostile design review

Date: 2026-05-24
Reviewer posture: skeptical senior frontend architect. Default assumption:
the code has problems; this document finds them. Every claim cites
`file:line`. Findings are tagged Critical / High / Medium / Low and noted as
systemic vs local.

---

## Executive summary

The kitp client is a competently-built Svelte 5 SPA with several genuinely
good pieces — the markdown sanitization boundary, the optimistic-update path
in kanban, the predicate AST, and a clean batch-dispatcher with a centralized
fault registry. The TypeScript discipline is high and the test footprint
(39 unit files, ~11.7k LOC, plus e2e journeys) is real.

The architectural health problem is concentrated in **one place: the
reactivity layer.** The team has adopted a pattern of `$effect` blocks that
*write* reactive state, and then papers over the resulting feedback loops with
`untrack(...)` — used in **14 files**, load-bearing in the global stores and 9
screen components. The git history (`cc1cfd1`, `a347f38`) shows two effect
cascades that tripped Svelte's `effect_update_depth_exceeded` ceiling; one was
reverted with the explicit admission that "the underlying cycle ... is left for
a follow-up." That cycle is still live. The cascades are not isolated bugs;
they are the predictable symptom of a state-syncing-via-effects architecture
fighting Svelte 5's signal model. This is the dominant risk and the rest of
the report is largely downstream of it.

Secondary concerns: a lying/dead reactivity contract in the DnD store, store
writes that reassign whole collections (maximal fan-out), a runtime BigInt
revival registry that silently corrupts id comparisons when un-primed, and
positioning logic duplicated across 9 components despite a `Popover`
abstraction existing.

Verdict: **structurally sound surface, fragile reactive core.** Shippable, but
the effect-cascade pattern will keep generating intermittent, hard-to-reproduce
"page won't paint" bugs on navigation/project-switch until the state-sync model
is reworked. Treat the reactivity rework as the top engineering priority.

---

## Severity-ranked findings

### CRITICAL

#### C1. Effects that write state + `untrack` as load-bearing glue (systemic)
`client/src/filter/ScreenFilterBar.svelte:155-157, 167-169, 193-270`,
`client/src/shell/AppShell.svelte:115-141`,
`client/src/shell/projects_store.svelte.ts:106-117`,
`client/src/shell/project_screens_store.svelte.ts:118-130`

The codebase routinely uses `$effect` to *write* `$state`/`$bindable`, then
wraps the body in `untrack` to stop the write from re-triggering the effect.
Examples:

- `ScreenFilterBar.svelte:155` — an effect whose only job is
  `screenBinding = screenCard;` (copy `$state` into a `$bindable`).
- `ScreenFilterBar.svelte:167` — an effect whose only job is
  `activeFilter = resolvedActive;` (copy a `$derived` into a `$bindable`).
- `ScreenFilterBar.svelte:193-270` — a 78-line effect that loads data and
  writes five reactive fields (`predicate`, `activeId`, `screenCard`,
  `presets`, `filterReady`), all inside `untrack`.

Why it bites: this is the exact anti-pattern Svelte 5 was designed to retire.
`$derived` exists to compute values from other reactive values *without* an
effect. Pushing a derived into a `$bindable` through an effect (C1a/b above)
re-introduces the dependency edge `untrack` then has to sever, and any miss in
the `untrack` coverage produces a feedback loop. The depth-cap crashes in the
git log are this pattern failing. `untrack` appearing in 14 files
(`grep -rlF untrack` → registry, ScreenFilterBar×5, AdminScreens×4,
projects_store×3, InboxLayout×3, TaskDetail×3, KanbanLayout×2, GridLayout×2, …)
is the smell quantified: a feature, not an escape hatch.

Remedy:
- Replace effect-into-bindable copies with direct `$derived` bindings. The
  parent should bind to a getter or accept the derived directly; do not mirror
  state through an effect.
- For the data-loader effect (`:193`), split "what to load" (a `$derived` key
  of `projectId + screenSlug`) from "do the load" — trigger the async load from
  a single narrowly-scoped effect that reads ONLY primitive keys and writes
  ONLY into a store the view derives from, never back into its own tracked
  deps. The current `untrack`-everything approach hides which writes are safe.

#### C2. The unresolved AppShell ↔ project-scope chord cascade (systemic)
`client/src/shell/AppShell.svelte:115-141`,
`client/src/keys/registry.svelte.ts:59-82`,
`client/src/shell/projects_store.svelte.ts:70-73`

Per `git show a347f38`, a real cascade in the "chord-registration / project-
scope chain" still trips `effect_update_depth_exceeded` and was knowingly left
unfixed (the revert reinstated a `console`-only TypeError that happens to halt
the cascade early). The live mechanism:

1. AppShell's effect (`:115`) tracks `projectScreensStore.screens`,
   `.forProjectId`, and `projectScope.projectId`, and on every change
   unregisters the old chord batch and registers a new one via the shortcut
   registry.
2. `register`/`unregister` must be wrapped in `untrack`
   (`registry.svelte.ts:60, 76`) precisely because they mutate `entries`,
   which the effect would otherwise pick up.
3. `projectsStore.load()` can call `projectScope.setProject(null)` mid-load
   (`projects_store.svelte.ts:72`) when a persisted scope no longer resolves —
   writing `projectScope.projectId`, which the chord effect tracks. So a
   *data load* can re-fire the chord-registration effect, which on a marginal
   path re-enters the registry mutation cascade.

Why it bites: this is an intermittent, environment-sensitive white-screen on
project switch / cold deep-link. It was diagnosed as needing "source-mapped
production effect-stack traces" — i.e. nobody actually has it pinned. It will
recur whenever the dep set or registry fan-out shifts.

Remedy: chord registration should not live in an `$effect` that both reads and
indirectly writes scope. Make the screen→chord mapping a pure `$derived` list,
and drive the keyboard dispatcher off that derived list directly (the
dispatcher can read `shortcuts.visible` which is already a getter) instead of
imperatively register/unregister on every change. That removes the mutation
fan-out entirely. Separately, `projectsStore.load` must not write
`projectScope.projectId` as a side effect of loading — surface "stale scope"
as a derived/validated value the caller resets explicitly, outside the load.

---

### HIGH

#### H1. DnD store advertises reactivity it does not provide (local, but a trap)
`client/src/dnd/use_dnd.svelte.ts:88-115`

`DndStore.active` and `.zones` are **plain class fields, not `$state`**
(deliberately, so the file is importable from plain `.ts` tests). But the
doc comment at `:90-94` claims "Svelte components subscribe via `$effect` over
`dnd.active.hoverZoneId`." That is false — mutating a non-rune field triggers
no reactivity. It currently works only because every consumer
(`DropZone.svelte:25-27`) drives UI through the imperative `setHover` callback,
not a reactive read; `grep` confirms zero components read `dnd.active`/
`dnd.zones` reactively.

Why it bites: the comment is a landmine. The first engineer who follows the
documented contract (`$effect(() => highlight = dnd.active?.hoverZoneId)`) gets
a silently dead subscription — no error, just stale UI. The "import from `.ts`
tests" constraint is also stale: other `.svelte.ts` files (stores, registry)
use runes and are tested fine.

Remedy: either make the store rune-backed (`$state`) and keep the imperative
callbacks as the fast path, or delete the false comment and document that the
store is intentionally non-reactive and must be consumed via callbacks only.

#### H2. Whole-collection reassignment on every store write (systemic, perf + cascade fuel)
`client/src/screens/filter_state.svelte.ts:80, 112`,
`client/src/schema/store.svelte.ts:94` (Map rebuild),
`client/src/keys/registry.svelte.ts` (history: `entries = next`)

`setFilter` does `cache.byKey = { ...cache.byKey, [key]: predicate }` — a fresh
object on every write. `setActivePreset` does the same. The registry's
unregister *used* to do `this.entries = next` and `cc1cfd1` explicitly
identified that "every reassign of a class-field `$state` fires every effect
that read the field ... multiplying the cleanup into a long cascade," then
switched to in-place `splice`. The filter cache still uses the reassign form.

Why it bites: with Svelte 5 fine-grained reactivity, a per-key write should
invalidate only that key's readers; whole-object reassignment invalidates
*every* reader of `byKey`. Combined with the effect-into-state pattern (C1),
this is the fan-out that turns a one-key change into a broad re-run. It's the
same root cause the team already fixed once in the registry but left in the
filter cache.

Remedy: mutate the proxy in place (`cache.byKey[key] = predicate`) — Svelte 5's
`$state` proxy makes per-property writes fine-grained. Same for `presetByKey`.

#### H3. Runtime BigInt-revival registry silently corrupts id comparisons when un-primed (systemic data-integrity)
`client/src/dispatch/dispatcher.ts:61-97, 111-151`

All ids are `bigint` (`reg/types.ts:26 type ID = bigint`) and the dispatcher
revives wire strings to `bigint` keyed by name (`ID_KEY_RE`) plus a *runtime*
set `CARD_REF_ATTR_KEYS` populated from the schema fetch. The comment at
`:73-75` admits: "Components that bypass that preload (the rare test, the MCP
CLI) will see card_ref values as raw JSON numbers until they trigger a schema
load." A `number` value compared against a `bigint` picker option via `===`
(the pattern throughout, e.g. `presets.find(f => f.id === activeId)` in
`ScreenFilterBar.svelte:165`, and every `valueForKey`/option match in the
layouts) is `false` — silently. So a card_ref attribute renders as "unset" or
a picker shows no selection whenever the schema preload hasn't landed or a new
card_ref attribute was added after boot without a catalog refresh.

Why it bites: this is order-dependent, intermittent, and invisible (no
exception). It couples correctness of *every screen's reference rendering* to a
global mutable set primed at one specific point in boot. New admin-defined
card_ref attributes won't revive until the catalog is refetched.

Remedy: stop branching id-ness on attribute name at the transport layer. Either
(a) have the server tag values with their type on the wire so the client never
guesses, or (b) normalize comparison to a canonical string form
(`String(x)`) everywhere ids are matched against picker options, so a
number/bigint mix can't break equality. The current approach makes a
transport-layer cache responsible for view-layer equality.

#### H4. Oversized screen components concentrate too much logic (systemic maintainability)
`client/src/screens/TaskDetailScreen.svelte` (2025 LOC, 39 `$state`, 33
`$derived`, 2 `bind:this`),
`client/src/screens/GridLayout.svelte` (1748),
`client/src/screens/admin/AdminScreensScreen.svelte` (1593),
`client/src/screens/KanbanLayout.svelte` (1183),
`client/src/screens/InboxLayout.svelte` (1160)

TaskDetailScreen holds 39 independent `$state` cells and 33 deriveds in one
component, plus imperative `bind:this` refs to the title element and the
TransitionBar (`:1317, :1359`). A component with 39 reactive cells is where
effect cascades are hardest to reason about — any new effect has 70+ possible
dependencies to accidentally close over.

Why it bites: directly multiplies the C1/C2 risk (more reactive surface = more
ways to form a loop) and makes the files hard to test in isolation (the suite
mostly tests extracted `*_helpers.ts` because the components can't mount
cleanly).

Remedy: the helper-extraction pattern (`grid_helpers.ts`, `kanban_helpers.ts`)
is good — push it further. Carve TaskDetail into child components owning their
own state slices (comments, attachments, attribute panel, transition bar) with
narrow props, so each has a small, auditable reactive graph.

---

### MEDIUM

#### M1. Positioning logic duplicated across 9 components despite a `Popover` abstraction
`client/src/ui/Popover.svelte` exists, yet `@floating-ui/dom` is imported and
its `autoUpdate`/`computePosition`/`flip`/`offset` dance is hand-rolled in:
`Combobox.svelte`, `DatePicker.svelte`, `TextSearchBar.svelte`,
`TransitionBar.svelte`, `GridLayout.svelte:781-801`,
`ExportMenu.svelte`, `ScreenFilterBar.svelte`, `ProjectTitlePicker.svelte`
(9 total).

Each repeats the same "hide until first computePosition resolves to avoid the
(0,0) flash" workaround (`Combobox.svelte:253-267`, `GridLayout.svelte:792-799`)
and the same `cleanupFloat?.()` lifecycle. That flash workaround being
copy-pasted 9× is the tell that the abstraction isn't being used.

Why it bites: 9 independent cleanup paths = 9 chances to leak an `autoUpdate`
subscription on unmount; positioning bugs must be fixed 9 times.

Remedy: route every anchored popup through `Popover` (or a `useFloating`
action) so positioning, the reveal-after-first-frame trick, and teardown live
once.

#### M2. Loader effects don't track all the inputs the loader reads
`client/src/shell/projects_store.svelte.ts:106-117` (+ `load` reads
`projectScope.showTemplates` at `:56` and `projectScope.projectId` at `:70`)

`watchProjects` tracks only `projectScope.projectsVersion`, but `load()` reads
`showTemplates` and `projectId`. The code "works" only because
`setShowTemplates` manually bumps `projectsVersion` (`project_scope.svelte.ts:103`).
This is implicit, fragile coupling: any future write to `showTemplates` that
forgets to bump the version produces a stale list with no error.

Why it bites: invisible staleness; the dependency is enforced by convention,
not by the reactive graph.

Remedy: track the actual inputs (`showTemplates`) in the effect, or fold the
version into a `$derived` cache key so the dependency is structural.

#### M3. `routerState.match` recomputes on every read (local perf)
`client/src/routing/router.svelte.ts:53-55`

`get match()` calls `matchRoute(this.path)` every access with no memoization.
Any component reading `routerState.match` re-runs route matching per render.
Cheap today (small route table) but a foot-gun as routes grow, and it defeats
referential-equality checks downstream.

Remedy: `const match = $derived(matchRoute(this.path))` exposed as a field.

#### M4. `navigate` same-path early-return drops `previousPath` semantics
`client/src/routing/router.svelte.ts:79-83`

When `path === here`, `navigate` returns before updating `previousPath`. A
component relying on "navigating refreshes the back target" silently won't, and
the comment ("defensive — should be identity-equal already") under-documents a
real behavioral branch (query-string-only changes also fall through here since
the comparison includes `search`).

Remedy: decide explicitly whether same-URL navigations should record history;
document and test it.

#### M5. Optimistic-update rollback races a concurrent refresh
`client/src/screens/KanbanLayout.svelte:544-568`

`handleDrop` snapshots `const original = tasks` then `tasks = original` on
failure. If the gated refresh effect (`:927`) fires between the optimistic
patch and the await rejection (e.g. project scope flips, filter changes), the
rollback restores a stale snapshot, clobbering fresh data.

Why it bites: rare but produces visibly wrong board state with no error.

Remedy: roll back by re-issuing a refresh (server is source of truth) rather
than restoring a captured array, or guard the rollback on a generation counter.

---

### LOW

#### L1. Markdown img `data:`/scheme comment vs. config mismatch (verify-only)
`client/src/util/markdown.ts:77-89`. The pipeline is otherwise a model
security boundary (explicit tag/attr allowlist, link-safety hook installed once
at module scope, scheme allowlist). The `ALLOWED_URI_REGEXP`
(`/^(?:(?:https?|mailto|tel):|#|\/)/i`) correctly excludes `data:` and
`javascript:`. No action needed; flagged only so a future widening of
`ALLOWED_TAGS`/`ALLOWED_ATTR` (e.g. adding `style`) is reviewed against this
note. The single `{@html}` site (`Markdown.svelte:34`) is the only one in the
codebase — good containment.

#### L2. Combobox async-debounce timer not cleared on unmount
`client/src/ui/Combobox.svelte:222-232`. The debounce `$effect` sets a
`setTimeout` but returns no cleanup; on unmount mid-debounce the callback still
fires (guarded by `runLoad`, so harmless today). Return a clearing cleanup for
hygiene.

#### L3. Form registry duplicate-id "second wins" + console.warn
`client/src/forms/registry.svelte.ts:18-23`. A non-reactive `Map` keyed by
string id where a collision warns and overwrites. Fine for dialog-scoped forms;
becomes a silent-wrong-form hazard if two long-lived forms ever share an id.
Low risk given current usage.

#### L4. Magic fallback ids
`client/src/screens/GridLayout.svelte:264` returns `2n` as the "me" id when the
OIDC `sub` can't parse, matching an Inbox constant. A hardcoded user id as a
fallback is a latent correctness/security smell (renders another user's "mine"
view) even if benign in the demo seed.

---

## Effect-cascade root cause (deep dissection)

The two commits in the git log (`cc1cfd1`, `a347f38`) treat the cascades as two
unrelated bugs — an AdminFlows derived-chain loop and a registry reassign
fan-out. They are the same disease with two presentations.

**The shared mechanism.** Svelte 5 schedules an effect to re-run whenever any
signal it *read* changes. This codebase has many effects that, in their body,
*write* signals. There are three failure shapes:

1. **Self-loop.** The effect reads signal A and writes signal A (or a signal
   that A is derived from). AdminFlows was this: the effect read
   `selectedFlow.scope_card_id` where `selectedFlow = $derived(flows.find ...)`,
   and the load it triggered wrote `flows`, re-deriving `selectedFlow`,
   re-firing the effect (`cc1cfd1` flow diff). Fix applied: read the primitive
   `selectedProjectId` instead of the derived — i.e. manually prune the dep
   edge. Correct, but it treats the symptom.

2. **Fan-out amplification.** A write that replaces a whole collection
   (`this.entries = next`, `cache.byKey = {...}`) invalidates *every* reader of
   that collection at once. If several of those readers are themselves
   state-writing effects, one write becomes N effect runs, each potentially
   writing more. The registry unregister was this; `cc1cfd1` switched to
   in-place `splice` to localize the invalidation. The filter cache (H2) still
   has the un-fixed form.

3. **Cross-store relay.** Effect E1 (chord registration) tracks
   `projectScope.projectId`; store method `load()` writes `projectScope` as a
   side effect (`projects_store:72`). So a data load relays into an unrelated
   effect's dep set. This is the "underlying cycle ... left for a follow-up"
   the revert admits is still live (C2).

**Why `untrack` is the wrong fix.** Every `untrack` in the codebase is a manual
cut in the dependency graph that the framework can no longer see or verify. It
suppresses the *read* but not the *write* (by design — see
`registry.svelte.ts:53-58`). So the cascade is contained only as long as every
write's readers are also untracked or non-effects. That invariant is held by
hand across 14 files. The depth-cap crashes are what happens when the invariant
slips — and because it's hand-maintained, it *will* slip again as the dep sets
shift. The fix isn't more `untrack`; it's removing the state-writing effects so
there's no loop to cut.

**The structural fix.** Three rules collapse the whole class:

- **Derive, don't mirror.** Anything currently copied from `$state`/`$derived`
  into a `$bindable` via an effect (ScreenFilterBar `:155`, `:167`; Kanban
  `:171`) should be a plain `$derived` the parent reads directly. No effect, no
  loop.
- **One-way data flow for loads.** A loader effect should track *only* primitive
  keys (ids, slugs, a version int) and write *only* into a store the view
  derives from — never back into a signal it tracks, and never into a foreign
  store an unrelated effect tracks. Move `projectScope.setProject(null)` out of
  `load`.
- **Fine-grained writes.** Mutate `$state` proxies in place
  (`obj[key] = v`, `arr.splice`) instead of reassigning the container, so an
  invalidation hits one reader, not all of them.

Applying these removes most of the 14 `untrack` call sites; the few that remain
(e.g. genuinely reading a snapshot inside an event handler) become obvious and
documented rather than load-bearing.

---

## Biggest architectural risks (conclusion)

1. **The reactive core is held together by hand-maintained `untrack`
   invariants (C1, C2, H2).** This is the single largest risk. It already
   shipped a known-unfixed white-screen cascade. It will keep producing
   intermittent, environment-specific "page won't paint" failures that are
   expensive to diagnose (the team already noted needing production
   source-mapped effect-stack traces). Until the state-writing-effect pattern
   is removed, every new effect is a chance to re-form a loop.

2. **Transport-layer type guessing leaks into view-layer correctness (H3).**
   The bigint-revival registry couples whether a reference renders correctly to
   global boot ordering. It fails silently. As admins add card_ref attributes
   at runtime, this gets worse, not better.

3. **Component-size concentration (H4).** 2000-line screens with 39 reactive
   cells are both the place cascades hide and the reason the test suite can only
   exercise extracted helpers, not the live reactive wiring. The hard parts
   (the effects) are the least-tested parts.

4. **Abstraction-bypass duplication (M1, H1).** A `Popover` exists but 9
   components hand-roll floating-ui; a DnD store documents a reactive contract
   it doesn't honor. These are lower-stakes but indicate abstractions aren't
   being trusted/maintained, which compounds over time.

What's genuinely good and should be preserved: the batch dispatcher + bag +
centralized fault registry (clean, well-documented, the fault funnel is the
right call), the markdown sanitization boundary (textbook), the predicate AST
(round-trippable, validated, throws on drift), and the kanban optimistic-update
shape (snapshot + rollback + toast). The bones are good. The reactivity layer
needs to stop fighting Svelte 5.

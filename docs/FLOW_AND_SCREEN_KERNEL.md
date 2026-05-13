# Flow & Screen kernel — design

Status: draft, not yet implemented. Authored 2026-05-13; revised same day.

## Revisions

- **2026-05-13 (r2):** Status becomes a required attribute on `task`. The "unset" UI bucket goes away entirely; triage tasks are real-valued, just with `phase='triage'`. `phase` grows from `{open, terminal}` to `{triage, active, terminal}`. `flow_step.from_card_id` becomes `NOT NULL`. New `default_create_status` attribute on both `screen` and `flow` rows with an explicit resolution chain. Toggle composition is restructured into named `toggle_group`s with explicit operator; the screen's resolved predicate is an explicit tree at every layer.
- **2026-05-13 (r3):** Routing collapses to `/project/:id/screen/:slug`; `/inbox` / `/grid` / `/kanban` aliases removed. New `slug` attribute on the screen card (per-project unique, URL-safe). Hotkeys are per-project (DB partial unique index, runtime re-registration on scope change). New `view_requires_role` attribute hides a screen from a role; action-readonly is emergent from flow_step matching. Flows are always project-scoped — `flow.scope_card_id` is `NOT NULL`; no global flows. `screen.predicate` attribute dropped — predicates live exclusively on filter cards (a screen has zero or more filter cards as children, plus a `default_filter` pointer). Predicate aliases `is set` / `is unset` dropped; `exists` / `not exists` already serve. `attribute.update` rejection envelope includes structured `available` transitions so UI and MCP both render positive guidance from the same payload. Toggle group state is no longer persisted across reloads.
- **2026-05-13 (r4):** Project templates added. New `is_template` attribute on the `project` card_type. New `project.stamp` handler graph-copies project-shaping cards (value cards, screens, filters, flows, flow_steps) from a template into a fresh project with ID remapping; runtime data (tasks, comments, activity, per-user state) is *not* copied. Default project listing filters out templates; admin listing shows all with a Template badge. Init seeds one template project plus one stamped demo project. No provenance tracking (stamped projects don't remember their origin template); changes to a template never propagate to already-stamped projects.

## Summary

Two cooperating generalizations:

1. **Flow**: a per-attribute state machine. Defines which value-card transitions exist on a stateful attribute (e.g. `status`), what label the action button carries, and which role may fire it. Replaces today's hardcoded `card.is_terminal` flag and absorbs every per-state UX concern that today lives in screen-specific component code (Accept, Reject, Close, Reopen, custom workflow advances, future block lifecycle, etc.). Status is required on tasks; every task has a real value-card at every moment of its lifetime, including triage.
2. **Screen-as-data**: a screen is a `screen` card whose attributes define name, hotkey, layout, an optional flow binding, a phase scope, a default new-task status, a saved predicate, and explicit toggle groups. The `screen_type` closed enum collapses to a `layout` attribute (still a closed enum, but only because the *rendering code* is finite). New screens (Ideas, "My closed last week", "Bugs needing triage") are seeded rows — no new code.

The kernel is small and reusable: one `attribute.update` write path (gated by transitions when a flow is bound), one predicate compiler (extended with one new op, `has_phase`), one renderer dispatch (on `layout`), one button-rendering rule (driven by the `(from.phase, to.phase)` pair of available transitions), one explicit predicate-tree composition the client assembles from selected-filter + toggle_groups. Every product feature in this area becomes a data definition over that kernel.

This document specifies the data model, the simplification on each side, the screen-by-screen result, and a deliberate list of variants and edge cases.

## What is removed

### Removed from the database

- `card.is_terminal boolean NOT NULL DEFAULT false` — replaced by `card.phase text NOT NULL DEFAULT 'triage' CHECK in ('triage','active','terminal')`. The default is `triage` because new value-cards typically represent triage statuses; admins flip to `active` or `terminal` as appropriate.
- The hardcoded `screen_type` text attribute, in spirit. The column-name stays for one release as a rename to `layout`; we drop the closed-set documentation from declarative.toml so application code becomes the only source of truth on which renderer names are valid.
- The notion of an `unset` status for tasks. Tasks always carry a real status value-card. Triage statuses (e.g. "Inbox", "New idea") are real value-cards with `phase='triage'` rather than absent values.

### Removed from the server

- The `"not terminal"` predicate op stays as a name but its implementation collapses to `is_phase != 'terminal'`. The bespoke `target.is_terminal = TRUE` SQL branch in `server/internal/dom/card/where.go` goes; same shape with `target.phase = 'terminal'`.
- No special-cased "is the actor allowed to close this task" logic. The role_grant lookup for the `attribute.update` process becomes one branch of two: if the attribute has a bound flow, the gate becomes "is there a `flow_step` from current → new value that the actor's role satisfies?"; otherwise unchanged.

### Removed from the client

- `client/src/filter/screen_preset.svelte.ts::SCREEN_TYPES` constant (4-tuple of layout names). Replaced by a `LAYOUTS` constant whose only role is to pick the correct renderer component. Code paths that today branch on `screen_type === 'kanban'` etc. branch on `layout` instead; the *number of branches is the same* but `screen_type` stops being authoritative metadata.
- The Inbox's hardcoded `let viewMode = $state<'mine' | 'all'>('mine')` plus the two header buttons that toggle it (InboxScreen.svelte:236-253, 666-710). It becomes one item in a `toggle_group` on the seeded Inbox screen card (see §"Schema · Toggle groups"). A generic `<ScreenToggleGroups>` component reads the screen card's toggle groups and emits per-group predicate contributions.
- The Inbox's hardcoded "agent-routed-to-me" branch (InboxScreen.svelte:351-359). Becomes a separate seeded screen card (`Agent view`) with `flow_ref` set to the `status` flow and an extra predicate `routed_to_me=true`. The agent's session sees that screen because the seed registers it conditionally on `is_agent`. (Equivalent option: keep the conditional in code; the data-driven path is cleaner.)
- `ui/widgets/TerminalActionButton.svelte` as a standalone purpose-built widget. The "Close ▾" split becomes one cell in the generic `<TransitionBar>` component (see below). Same DOM affordance, same hotkey, no special prop named `terminalOptions`.
- The would-have-been `'ideas'` value on `ScreenType`, the would-have-been per-row Accept / Reject buttons in InboxScreen, and any planned `screen_type='ideas'` route. The Ideas surface is one seeded screen card pointing at the `status` flow, with a `phase_scope` toggle group whose `triage` item is default-on and `active` / `terminal` items are default-off.
- Any client-side handling of "task has no status." Tasks always carry a real status value-card; the renderer never branches on `status === null`.

### Removed from documentation conventions

- The phrase "every project ships with one screen card per screen_type" (screen_preset.svelte.ts:3-6, declarative.toml:1132). Replaced by "every project seeds with N screen cards; admins may add/remove freely."

## Schema

### Replace `is_terminal` with `phase` (3-valued)

```toml
[[tables.columns]]
name = 'phase'
type = 'text'
nullable = false
default = "'triage'"
# CHECK constraint enforces phase IN ('triage','active','terminal')
```

Semantics:

| value | applies to | meaning | queue default |
|---|---|---|---|
| `triage` | value-cards used as "needs categorization" statuses (`New idea`, `Inbox`, `Pending review`) | task is registered but not yet committed-to | hidden from active queues |
| `active` | value-cards used as in-flight statuses (`Todo`, `Doing`, `Review`) | task is being worked on | shown by default |
| `terminal` | value-cards used as final statuses (`Done`, `Cancelled`, `Rejected`) | task is finalised | hidden from active queues |

Value-cards that are not part of any flow (e.g. `person` cards, `tag` cards) carry `phase='triage'` by virtue of the column default but the value is never consulted; only flow-bound value cards have meaningful phase.

Migration of seed data: every row currently with `is_terminal=TRUE` gets `phase='terminal'`; every existing status row tagged "Todo"/"Doing"/"Review" gets `phase='active'`; a new `Triage` status is seeded with `phase='triage'` per project (see §"Seed example"). No production rows exist outside seeds (declarative-schema reset is the migration tool).

### New table: `flow`

```toml
[[tables]]
name = 'flow'
doc = """One state-machine definition, scoped to one project. Each row
binds a flow to one (attribute_def, project) pair — the attribute_def
names the attribute whose value cards are the flow's states, and the
project is the scope under which this flow applies. There are no
global / install-wide flows; templates live in declarative.toml and
are stamped into each new project at seed time.
default_create_status_id names the status this flow assigns to a new
task when a screen using this flow has no per-screen override."""
unique = [['attribute_def_id', 'scope_card_id']]

columns:
  id                          bigserial PRIMARY KEY
  name                        text NOT NULL                    -- "Standard task", "Idea triage"
  doc                         text
  attribute_def_id            bigint NOT NULL FK attribute_def(id)
  scope_card_id               bigint NOT NULL FK card(id)      -- project; required (no globals)
  default_create_status_id    bigint NULL    FK card(id)       -- value-card for new tasks; resolution chain below
  created_at                  timestamptz NOT NULL DEFAULT now()
```

### New table: `flow_step`

```toml
[[tables]]
name = 'flow_step'
doc = """One transition edge in a flow. from_card_id and to_card_id
both point at value cards on the same attribute_def as the flow.
Tasks always have a real status value-card (status is a required
attribute), so there is no 'from unset' case — every transition is
real → real. label is the button text; the UI category (Accept /
Reject / Close / Reopen / progress) is derived at render time from
(from_card.phase, to_card.phase) — see TransitionBar. requires_role_id
NULL means any authenticated user. sort_order orders entries within
the same UI bucket (e.g. multiple Close options) for deterministic
rendering."""
unique = [['flow_id', 'from_card_id', 'to_card_id', 'label']]

columns:
  id                bigserial PRIMARY KEY
  flow_id           bigint NOT NULL FK flow(id) ON DELETE CASCADE
  from_card_id      bigint NOT NULL FK card(id)
  to_card_id        bigint NOT NULL FK card(id)
  label             text NOT NULL
  requires_role_id  bigint NULL    FK role(id)   -- NULL = any authenticated
  sort_order        int NOT NULL DEFAULT 0
  created_at        timestamptz NOT NULL DEFAULT now()
```

### Default-create-status resolution chain

When the UI creates a new task on a screen, the status it stamps is resolved by walking, in order, the first non-null value:

```
screen.default_create_status              ← per-screen override (card_ref → status)
  → flow.default_create_status_id         ← per-flow default
  → first status with phase='triage' by sort_order  (in this flow's project scope)
  → first status with phase='active'  by sort_order  (fallback when no triage exists)
  → fail card.insert with code='flow_no_default'
```

This is the *only* place the kernel needs to know "what status to pick for a new task." The Ideas screen, the Inbox, an admin-defined custom screen — they all bottom out in this chain. Per-screen overrides let the Inbox seed default to "Todo" while Ideas defaults to "New idea" on the very same flow.

### Existing schema gains: new attributes on the `screen` card_type

The `screen` card_type stays. Its attribute list grows by six entries and one rename:

| attribute_def name | value_type | required | doc |
|---|---|---|---|
| `screen_type` → rename to `layout` | text | yes | "Renderer pick. Application validates against the LAYOUTS constant." |
| `slug` | text | yes | "URL token, unique within the parent project. Regex `^[a-z][a-z0-9-]*$`. Routes resolve via `/project/:id/screen/:slug`. Renaming breaks bookmarks but no data." |
| `hotkey` | text | no | "Single character; pressed after `g` while in the project's scope. Unique per project (partial unique index on `(parent_card_id, hotkey) WHERE deleted_at IS NULL`)." |
| `flow_ref` | card_ref → flow | no | "Optional flow whose transitions populate TransitionBar and whose `default_create_status_id` participates in the new-task resolution chain. No predicate effect on its own — phase scope lives in toggle_groups (see below)." |
| `default_create_status` | card_ref → status value-card | no | "Per-screen override for new-task status. Falls back through flow.default_create_status_id, then to first triage-phase status by sort_order. See §'Default-create-status resolution chain'." |
| `view_requires_role` | card_ref → role | no | "When set and the actor lacks the role, the screen is hidden entirely: not in sidebar, hotkey unregistered, URL access denied. Action-level gating is separate (and emergent from flow_step requires_role)." |
| `toggle_groups` | text (JSON) | no | "Array of named toggle_group objects. Each group is its own composition node. See §'Toggle groups' below." |

Existing attributes that stay: `title`, `sort_order`, `default_filter`, `column_attr`, `lane_attr`. Predicates live exclusively on filter cards. A screen with no filter cards relies entirely on its toggle groups for row selection; a screen with one filter card uses it via `default_filter`; a screen with many lets the user pick. The previously-proposed `screen.predicate` attribute is removed — anywhere a screen needs a static predicate, a filter card carries it.

#### Gate 8 implementation notes

The above table lists three card_ref attributes whose target is not a card_type in the current codebase (`flow`, `role` are tables, not card_type rows). The `attribute_def` schema requires `target_card_type_id` to name a real `card_type` row, so card_ref-with-no-target isn't expressible. Gate 8 records the values in the closest legal types:

- `flow_ref` is stored as `number` (the `flow.id` value). App code validates the referenced flow row exists and is scoped to the screen's project. (FK enforcement deferred — see "Optional follow-ups" below.)
- `view_requires_role` is stored as `text` (the `role.name` value). The `role.name` column has a UNIQUE constraint so the text round-trips to the role row.
- `default_create_status` stays as `card_ref → status` because status IS a card_type — the existing per-project scope rule applies.

Hotkey and slug uniqueness is enforced at the attribute.update layer (V2 below). The check runs inside the open write transaction so concurrent writes cannot race past it. Rejection codes:

- `slug_invalid` — slug doesn't match `^[a-z][a-z0-9-]*$`.
- `slug_in_use` — another screen under the same project already owns this slug.
- `hotkey_in_use` — another screen under the same project already owns this hotkey.

### Toggle groups

The `toggle_groups` screen attribute stores an array of typed group objects. The shape is a closed JSON schema that the application validates:

```jsonc
[
  {
    "name": "main",                       // group identifier, unique within the screen
    "operator": "and",                    // 'and' | 'or' | 'xor'  — composition of items
    "mode": "multi",                      // 'multi' (checkboxes) | 'radio' (one of)
    "items": [
      {
        "name": "mine_only",              // item identifier, unique within the group
        "label": "Mine",                  // UI text
        "predicate": { "attr": "assignee", "op": "=", "values": ["__actor__"] },
        "default_on": true                // initial state when no session state exists
      },
      {
        "name": "has_due_date",
        "label": "Has due date",
        "predicate": { "attr": "due_date", "op": "exists" },
        "default_on": false
      }
    ]
  }
]
```

Composition rules (see §"Predicate composition" for the full picture):

- A group with zero enabled items elides entirely (contributes nothing) — never silently filters everything out.
- A group with one or more enabled items contributes `{ operator: <group.operator>, children: [<enabled item.predicate>, …] }` to the screen's predicate tree.
- `mode='radio'` constrains the UI to at most one enabled item; the contribution then has at most one child.
- `default_on` on `radio` items: at most one item may have `default_on=true`; the application picks that as the initial selection. If none do, the radio group starts with no selection (and contributes nothing).
- The sentinel string `"__actor__"` in a predicate value resolves to the calling user's id at predicate-composition time. (Same convention applies to predicates carried on filter cards.)

The `layout` closed set the application enforces (initial release):

```
LAYOUTS = ['list', 'grid', 'kanban', 'pair']
```

Mapping from old to new:
- old `inbox` / new `list` (the renderer formerly known as InboxScreen)
- old `grid` / new `grid` (no change)
- old `kanban` / new `kanban` (no change)
- old `project_detail` / new `pair` (master/detail two-pane)

### Predicate composition

The client composes a screen's effective predicate by building an explicit tree at every layer. AND / OR are never inline operators between conditions — they are nodes that own a list of children. The screen renderer assembles the tree once per render pass and ships it to `card.select_with_attributes` as the `tree` field.

The composition node (always `and` at the outermost level):

```jsonc
{
  "operator": "and",                         // explicit: the only place top-level composition is implied
  "children": [
    <selected_filter.predicate>,             // elided if the screen has no filter card or the user picked "none"
    <toggle_group[0] contribution>,          // own operator from group.operator
    <toggle_group[1] contribution>,
    ...
  ]
}
```

Static predicates live exclusively on filter cards. A screen with no filter cards relies on its toggle groups alone for row selection. A screen with one filter card uses it as the default (via `default_filter`). A screen with many lets the user pick — the UI offers a filter selector in the header.

Each child is itself either a leaf or a group node. The renderer never returns a flat array — it always emits a group with a named operator.

**Phase scope is a toggle group, not a separate screen attribute.** A seed convention: include a toggle group named `phase_scope` with `operator: 'or'`, mode: 'multi' (or 'radio' for "pick exactly one phase"), and one item per phase the screen wants to expose. Items have predicates of shape `{attr:<flow.attribute_name>, op:'has_phase', values:[<phase>]}`. `default_on` per item declares the screen's default scope. The user can flip items to broaden / narrow. The renderer doesn't special-case `phase_scope` — it's a normal toggle group; the OR operator makes the composition behave naturally for "broadening" toggles like "Show closed". (See §Seed example and §Screens for concrete shapes.)

**Empty groups elide.** A group with no children — whether because all toggles are off, no filter is selected, or `flow_ref` is empty — is removed from `children` before send-off. The renderer never emits `{operator:'and', children:[]}` (which would be vacuously true) or `{operator:'or', children:[]}` (which would be vacuously false and silently filter everything). Either case becomes "this layer contributes nothing."

**Single-child groups stay groups.** Even when a toggle group has exactly one enabled item, the contribution is `{operator:<group.operator>, children:[<item.predicate>]}` rather than the bare item predicate. Costs one node; keeps the tree's shape uniform and the operator inspectable.

**Server side is unchanged.** The server's predicate compiler (`server/internal/dom/card/where.go`) already handles arbitrary AND/OR/NOT trees. It receives the composed tree and walks it; it has no notion of "this came from a toggle vs a filter vs a flow." Composition is purely a client concern, exposed as data so an admin (or test) can inspect the resolved tree.

### New predicate ops

One new op in `card/where.go`:

- `"has_phase"` — dereferences a card_ref attribute's value-card and checks `phase`. SQL shape:
  ```sql
  EXISTS (
    SELECT 1
    FROM attribute_value av
    JOIN attribute_def ad ON ad.id = av.attribute_def_id
    JOIN card target ON target.id = (av.value)::text::bigint
    WHERE av.card_id = c.id
      AND ad.name = $attr
      AND jsonb_typeof(av.value) = 'number'
      AND target.phase = ANY($values)
      AND target.deleted_at IS NULL
  )
  ```
  `values` is an array of phase strings so a single leaf can match e.g. `['active','terminal']`. This is the op every phase_scope toggle item emits.

The `"not terminal"` op becomes redundant — `{attr:'status', op:'has_phase', values:['triage','active']}` is the new way to say "show non-terminal work." Existing seed filter cards using `"not terminal"` keep working via an alias compiled to `has_phase ∈ {triage, active}`; new code uses `has_phase` directly.

`is set` / `is unset` aliases for `exists` / `not exists` were considered and dropped — the aliases would duplicate existing ops without adding any function. Authors use `exists` / `not exists` directly.

## Server simplification

The server gains two read-only handlers (`flow.list`, `flow_step.list`), two write handlers (`flow.set`, `flow_step.set` + their `.delete` siblings), and **one authorization branch** inside the existing `attribute.update.validate`. That's it.

### Generalization 1: `attribute.update` becomes the flow funnel

Today `attribute.update`'s authz funnels through `role_grant (role, card_type, process_name='attribute.update')`. The new branch:

```go
// After current edge / required / card_ref scope checks.
flow := lookupFlowForAttribute(ctx, pool, in.AttributeName, cardProjectID)
if flow != nil {
    prevValueCardID, err := readCurrentValue(ctx, pool, in.CardID, in.AttributeName)
    if err != nil { return err }                                              // status is required;
    if prevValueCardID == 0 {                                                 // missing implies seed bug
        return &reg.HandlerError{Code: "flow_invariant",
            Message: "flow-bound attribute has no current value (required attr invariant violated)"}
    }
    newValueCardID, err := parseRequiredValueCardID(in.Value)
    if err != nil { return err }                                              // null/missing rejected by
                                                                              // the existing required-edge check
    step := findStep(ctx, pool, flow.ID, prevValueCardID, newValueCardID)
    if step == nil {
        return &reg.HandlerError{Code: "flow_disallowed",
            Message: fmt.Sprintf("no transition: %d → %d", prevValueCardID, newValueCardID)}
    }
    if step.RequiresRoleID != nil && !actorHasRole(ctx, actorID, *step.RequiresRoleID, cardProjectID) {
        return &reg.HandlerError{Code: "flow_role_required",
            Message: "transition requires a role you do not hold"}
    }
    // Fall through; the row write itself is the same INSERT/UPSERT.
}
```

Because status is required, prev and new are *both* real value-card ids — no NULL handling, no "unset" sentinel, no creation-step special case. The existing required-edge check (which rejects `JSON null` writes when `edge.is_required=TRUE`) already prevents tasks from going back to unset; the flow code just confirms a transition exists.

### Generalization 1b: `card.insert` consults the resolution chain

A new task created on a screen with a flow-bound required status needs that status set in the same insert. Two paths:

1. **Client supplies the status explicitly.** QuickEntry pulls `screen.default_create_status` (resolving through the chain client-side) and includes it in the `card.insert` payload's `attributes` field. The server's existing required-attribute check accepts the value.
2. **Client omits the status; server fills it.** `card.insert` learns to resolve the chain when the inserted card_type has a required flow-bound attribute the payload doesn't set. Cheaper for callers, more behaviour in the server.

Recommendation: ship **(1)** in the MVP. The client already has the screen card in memory at creation time; resolving the chain there keeps the server's `card.insert` honest about "the caller provides every required attribute." If a future caller (MCP, email-ingest) can't resolve the chain — e.g. an email-to-task adapter that doesn't know which screen the task belongs to — extend with **(2)** at that point, gated on a new `auto_fill_required_from_flow` flag in the insert payload.

### Generalization 2: predicate funnel is unchanged

`card.select_with_attributes` already takes a `tree` predicate. The Ideas / Triage / "show closed" surfaces all live as predicate JSON. Predicate compilation stays the only path for "which rows belong to this screen."

The same predicate is used by:
- Inbox-style list rendering.
- Kanban column membership.
- Saved screen filters.
- The MCP query surface.

No new branching here. The deltas are: one new op (`has_phase`) and a column rename inside `not terminal`'s SQL.

### Generalization 3: flow_step.list is the read-side affordance API

One handler answers "what buttons should the UI show for this card?":

```
flow_step.list { card_id }
  → [
      { id, from_card_id, to_card_id, label, requires_role_id, sort_order,
        from_phase: 'triage'|'active'|'terminal',
        to_phase:   'triage'|'active'|'terminal',
        allowed: bool                            -- actor role satisfies requires_role_id
      },
      …
    ]
```

The server joins the flow row for the card's stateful attribute, picks every `flow_step` whose `from_card_id` matches the card's current value (or `IS NULL` when the card has no value), and stamps `from_phase`/`to_phase`/`allowed` so the client renders without re-querying. One round-trip per page load, batched with the rest.

Today the same surface is split between: the `notTerminal` predicate (Inbox / Grid / Kanban defaults), the bespoke `TerminalActionButton.terminalOptions` prop (TaskRow), and the planned per-row Accept/Reject buttons (Ideas). All collapse into `flow_step.list`.

### Generalization 4: same role/process grants apply unchanged

The flow-aware authz is *additive*: it tightens an already-permitted `attribute.update`. The existing `role_grant (role, card_type, process_name='attribute.update')` rows determine whether the actor may write to this attribute on this card type at all; the flow_step lookup determines whether *this particular value change* is allowed. Two gates, separate concerns; the funnel is the same handler.

## Client simplification

### The screen renderer becomes a small dispatch

Today each screen is a route entry pointing at a specific `*.svelte` component (`/inbox` → `InboxScreen`, `/grid` → `GridScreen`, etc.) which knows its `screenType` constant inline. The new shape: every screen URL is `/project/:id/screen/:slug`; the router resolves `(project_id, slug)` to a screen card and renders `<ScreenHost screenCardId=…>` which dispatches on `layout`.

```
ScreenHost.svelte
  props: screenCardId
  reads:  screen card + its child filter cards + (if flow_ref) flow + flow_steps batch
  renders one of:
    layout='list'   -> ListLayout (formerly InboxScreen body)
    layout='grid'   -> GridLayout (formerly GridScreen body)
    layout='kanban' -> KanbanLayout
    layout='pair'   -> PairLayout (formerly ProjectDetailScreen body)
  passes down: rows, schemaCache, predicate (after toggles), flow, transitions-by-card-id
```

Each layout becomes a body component — no longer a top-level page. They lose responsibility for their own data fetch (now centralised in ScreenHost), their own filter bar (now a generic `<ScreenHeader>` that renders title + hotkey hint + toggles), and their own viewMode toggle (now generic `<ScreenToggles>` driven by the card's `toggles` attribute).

This is **the main client win**: the four screens stop being four screens, they become four renderers behind one host. New "screens" are seeded rows.

### `<TransitionBar>` replaces TerminalActionButton (and the planned Idea buttons)

```
TransitionBar.svelte
  props: cardId, transitions: TransitionRow[]
  rule:  group transitions by (from_phase, to_phase) into UI buckets,
         render each bucket per the table below
```

UI bucket table — derived from `(from.phase, to.phase)`. Status is always a real value-card, so the from row always has a real phase; nine cells in principle, but a handful are rare.

| from.phase | to.phase | Bucket | Default renderer |
|---|---|---|---|
| triage | triage | `progress_triage` | Item in the row's `Status ▾` dropdown (under a "Triage" group) |
| triage | active | `accept` | Primary positive button per transition (inline on the row) |
| triage | terminal | `reject` | Secondary destructive button per transition (inline on the row) |
| active | triage | `defer` | Inline secondary button per transition; rare |
| active | active | `progress` | Single `Status ▾` dropdown listing all `to` options |
| active | terminal | `close` | "Close ▾" split (first = primary; chevron = list) |
| terminal | triage | `retriage` | Dropdown item under Reopen; rare |
| terminal | active | `reopen` | Primary positive button per transition |
| terminal | terminal | `recategorize` | Dropdown item under Reopen; rare |

The bucketing is **derived**, not stored. Adding new flow_step rows changes which buttons appear; never changes which buckets exist.

Where it renders:
- TaskRow: a `<TransitionBar>` cell on the right, replacing today's `TerminalActionButton`.
- TaskDetailScreen header: a wider variant.
- Ideas screen rows: the `accept` + `reject` buckets fire prominently because triage-phase rows naturally land in those buckets. No special "Ideas screen" code — same component, same data, same buckets, the rendering rule does the work.

### Generic `<ScreenToggleGroups>`

```
ScreenToggleGroups.svelte
  props: groups: ToggleGroup[]   (from the screen card's `toggle_groups` attribute)
         resolveActor: () => ID   (substitutes for "__actor__" sentinel)
  emits: predicateChildren: PredicateNode[]   (one entry per group with at least one enabled item)
  renders: one labeled chip-strip per group; checkboxes for mode='multi', radio for mode='radio'.
           Persists choices in session storage keyed by screen card id.
```

Each rendered group emits at most one predicate node into the screen's outer composition. The group's `operator` becomes the operator of the emitted node; its `mode` only affects the UI (how many items can be enabled at once).

The Inbox's old "Mine | All open" pair becomes a single multi-mode group with one item (`mine_only`, default_on=true). If an admin later wants "Mine | My team | All", that's a single radio-mode group with three items.

The Grid's phase scope is a single OR-mode group named `phase_scope` with three items: `active` (default_on=true), `triage` (default_on=false), `terminal` (default_on=false). Flipping `terminal` on broadens the result set naturally — the group's OR contribution gains a new child predicate. No special "show closed" attribute needed; the toggle group composition does it.

### Auto-registered hotkeys

App boot reads every screen card's `hotkey` attribute and registers a `g <hotkey>` chord that navigates to that screen's route. Currently AppShell hardcodes five chords (`g p` / `g i` / `g g` / `g k` / `g a`); they become a loop over the loaded screen cards. The keys module already supports this — `useShortcut('global', 'g i', ...)` is the existing call shape.

### Hooked-on simplifications (cheap once we're in there)

- `useQuickEntry`'s `prefill: { assigneeUserId: meId }` in InboxScreen becomes a screen card attribute: `quick_entry_prefill` (JSON). The Ideas screen leaves it blank so a new idea has no assignee.
- The `ProjectScope` panel and per-screen filter bar consolidate under `ScreenHeader`.

## Screens — final layout

Six seeded screens per fresh install, all data. The first four are the existing screens migrated; the fifth and sixth are net-new but cost zero code.

For brevity each screen's `toggle_groups` is shown as a compact JSON-like sketch; the canonical shape is the one in §"Toggle groups".

### 1. Inbox (`list`)

| attribute | value |
|---|---|
| `title` | "Inbox" |
| `slug` | `inbox` |
| `layout` | `list` |
| `hotkey` | `i` |
| `flow_ref` | → `status` flow |
| `default_create_status` | → "Todo" (active phase) — Inbox users want to start a task, not file an idea |
| `toggle_groups` | `[ phase_scope{or, multi, items:[active*]}, scope{and, multi, items:[mine_only*]} ]` |
| `default_filter` | (none required; can carry user-saved filter cards) |

`*` marks `default_on=true`. The Inbox shows active tasks assigned to the actor. Toggle `mine_only` off to broaden to all assignees; flip `triage`/`terminal` items into the phase_scope group to see triage/closed work without leaving the screen.

### 2. Grid (`grid`)

| attribute | value |
|---|---|
| `title` | "Grid" |
| `slug` | `grid` |
| `layout` | `grid` |
| `hotkey` | `g` |
| `flow_ref` | → `status` flow |
| `toggle_groups` | `[ phase_scope{or, multi, items:[triage, active*, terminal]} ]` |

Grid shows everything in the active scope by default. Phase items are independent checkboxes — turn any on/off without touching the others.

### 3. Kanban (`kanban`)

| attribute | value |
|---|---|
| `title` | "Kanban" |
| `slug` | `kanban` |
| `layout` | `kanban` |
| `hotkey` | `k` |
| `flow_ref` | → `status` flow |
| `column_attr` | `status` |
| `lane_attr` | (optional, e.g. `assignee`) |
| `toggle_groups` | `[ phase_scope{or, multi, items:[active*, terminal]} ]` |

Columns are status value-cards filtered to the enabled phases. Flip `terminal` on to see Done/Cancelled as columns; flip it off (the default) and they disappear from the board.

### 4. Project detail (`pair`)

| attribute | value |
|---|---|
| `title` | "Project" |
| `slug` | `project` |
| `layout` | `pair` |
| `hotkey` | (none — entered via project list) |
| `flow_ref` | → `status` flow |
| `toggle_groups` | `[ phase_scope{or, multi, items:[active*]} ]` |

### 5. Ideas (`list`) — NEW, data only

| attribute | value |
|---|---|
| `title` | "Ideas" |
| `slug` | `ideas` |
| `layout` | `list` |
| `hotkey` | `n` |
| `flow_ref` | → `status` flow |
| `default_create_status` | → "New idea" status (phase=triage) |
| `toggle_groups` | `[ phase_scope{or, multi, items:[triage*]} ]` |
| `quick_entry_prefill` | `{}` (no assignee — the whole point of an idea is that nobody's caught it yet) |

Rows = tasks in any triage-phase status. TransitionBar renders Accept (each `triage → active` step) and Reject (each `triage → terminal` step) inline. Drag-reorder remains.

### 6. Archive / Closed (`list`) — NEW, data only

| attribute | value |
|---|---|
| `title` | "Closed last 30d" |
| `slug` | `archive` |
| `layout` | `list` |
| `hotkey` | (none, sidebar entry) |
| `flow_ref` | → `status` flow |
| `default_filter` | → filter card "Last 30 days" with predicate `{attr:'closed_at', op:'>=', values:[<now-30d>]}` |
| `toggle_groups` | `[ phase_scope{or, multi, items:[terminal*]} ]` |

Rows = recently-closed tasks. TransitionBar renders Reopen. The time-window predicate lives on a child filter card because it's a static predicate, not a toggleable scope.

## Seed example: the `status` flow

To make the abstraction concrete, here is the data needed to recreate today's behaviour plus the new Ideas / Archive surfaces for one project:

```
# Value cards (status cards in declarative.toml; one new "New idea" triage row)
card #99  status "New idea"  phase=triage    sort_order=5
card #100 status "Todo"      phase=active    sort_order=10
card #101 status "Doing"     phase=active    sort_order=20
card #102 status "Review"    phase=active    sort_order=30
card #103 status "Done"      phase=terminal  sort_order=40
card #104 status "Cancelled" phase=terminal  sort_order=50

# Flow
flow #1 name="Standard task" attribute_def_id=<status> scope_card_id=<project>
                              default_create_status_id=#99 (New idea)

# Steps — note every from_card_id is a real value-card now; no NULL-from rows.
flow_step (flow=1, from=#99,   to=#100, label="Accept",          requires_role=worker)   # triage → active
flow_step (flow=1, from=#99,   to=#104, label="Reject",          requires_role=worker)   # triage → terminal
flow_step (flow=1, from=#100,  to=#101, label="Start",           requires_role=worker)   # active → active
flow_step (flow=1, from=#101,  to=#102, label="Send to review",  requires_role=worker)
flow_step (flow=1, from=#102,  to=#103, label="Approve",         requires_role=manager)
flow_step (flow=1, from=#101,  to=#103, label="Done",            requires_role=worker)   # bypass review
flow_step (flow=1, from=#100,  to=#103, label="Done",            requires_role=worker)
flow_step (flow=1, from=#100,  to=#104, label="Cancel",          requires_role=worker)   # active → terminal
flow_step (flow=1, from=#101,  to=#104, label="Cancel",          requires_role=worker)
flow_step (flow=1, from=#102,  to=#104, label="Cancel",          requires_role=manager)
flow_step (flow=1, from=#103,  to=#100, label="Reopen",          requires_role=manager)  # terminal → active
flow_step (flow=1, from=#104,  to=#100, label="Reopen",          requires_role=manager)
```

The Ideas screen renders the first two rows as inline Accept / Reject buttons on every task whose status is #99 ("New idea"). The Inbox renders the next nine via TransitionBar on rows with active-phase status. The Archive renders the last two on rows with terminal-phase status. Same data, three views, zero special-case code paths.

When the user creates a new task on the Ideas screen, the resolution chain stops at `screen.default_create_status` → "New idea" (#99). When the user creates a new task on the Inbox, the screen has no override; the chain falls through to `flow.default_create_status_id` → "New idea" (#99) — so even Inbox-created tasks start in triage by default. To make Inbox-created tasks land directly in "Todo" instead, the Inbox seed sets `default_create_status` → #100; the per-screen override wins over the flow default.

## Project templates

A template is a `project` card with the new `is_template=true` attribute. Its purpose is to be the source for stamping new projects — it carries the configured statuses, flows, screens, and filter presets that a fresh project should inherit. After stamping, the new project's cards are independent copies; subsequent edits on either side don't propagate.

### Schema

One new attribute on `project`:

| attribute_def name | value_type | required | doc |
|---|---|---|---|
| `is_template` | bool | no (default false) | "When true, this project is a template — included in stamping but excluded from default user-facing project lists." |

No new tables, no new card_types. A template is structurally a project.

### The `project.stamp` handler

```
project.stamp { template_project_id: ID, name: text } → { new_project_id: ID }
```

Single-transaction graph copy. The handler walks the template's children, remaps IDs, and inserts a new project graph. What's copied:

| Source rows | Copied to new project | ID remap |
|---|---|---|
| Value cards (status / milestone / component / tag, parented to template) | yes | new card IDs |
| Flow rows scoped to the template | yes | `scope_card_id` → new project id; `default_create_status_id` → new value-card id |
| Flow_step rows | yes | `from_card_id`, `to_card_id` → new value-card ids |
| Screen cards | yes | `flow_ref` → new flow id; `default_filter` → new filter id |
| Filter cards (children of screen cards) | yes | filter-card ids remapped; predicate JSON remapped where it references value-card ids |

What's deliberately *not* copied:

- `task` cards and their attribute_values
- `comment` rows and `activity` rows
- `user_card_sort`, `user_card_agent` (per-user state)
- `attribute_value` on the template project itself (other than the ones we copy along with the children — e.g., a value card's `title` and `phase`)

The handler runs as one CTE-heavy transaction or, more practically, a Go function that issues a small sequence of INSERT … SELECT statements with a temp ID-mapping table. Either way, atomic: if anything fails, the new project doesn't exist.

Predicate remapping: filter cards carry JSON predicates that may reference specific value-card IDs (e.g., `{attr:'status', op:'in', values:[<id>]}`). The handler walks each predicate tree, finds card-id references that map to remapped value cards, and substitutes the new IDs. Predicates referencing global cards (e.g., person cards) pass through unchanged. The walk uses the same predicate-JSON shape the predicate compiler consumes, so adding new ops doesn't require touching the remap code — only ops whose values are card IDs need remap, and the compiler already knows which ops those are.

### Init seed

`declarative.toml` seeds two projects:

1. **Template project** (`is_template=true`, title "Standard Project Template"). Carries the full default set: statuses (`New idea`/`Todo`/`Doing`/`Review`/`Done`/`Cancelled` with correct phases), the `status` flow with all its flow_steps, the six default screens (`Inbox`, `Grid`, `Kanban`, `Project`, `Ideas`, `Archive`) with hotkeys and toggle groups, the `Last 30 days` filter card for `Archive`.
2. **Demo project** (`is_template=false`, title "Default Project"). Stamped from the template via raw SQL (or a Go init hook that calls `project.stamp` post-schema-apply). Then populated with the existing demo tasks/comments/etc.

A fresh dev DB shows two projects in the admin list: the template (with a badge) and the demo. End users only see the demo. To create a new project, an admin (or any authorised user) calls `project.stamp { template_project_id: <template_id>, name: 'New project' }` and gets back a fresh fully-configured project.

If the install ever loses its template (admin deletes it), `project.stamp` can't be called with that id; new project creation falls back to `card.insert` for a bare project — and the result is an empty shell with no flows/screens. The admin needs to either restore the template or build one fresh. Documented; not engineered against.

### Listing convention

`card.select_with_attributes { cardTypeName: 'project' }` returns every project row regardless of `is_template`. The convention is **client-side filtering**:

- User-facing project lists (`ProjectsScreen.svelte`, project pickers in the header) ship predicate `{attr:'is_template', op:'!=', values:[true]}`. The exclusion is the default for every user-facing surface.
- Admin project list (`AdminProjectsScreen.svelte` or the existing admin Projects pane) ships no predicate, gets all rows, renders a "Template" badge column. Optionally adds a header toggle "Show templates" (default off) so admins start with the user view and opt in.

The server doesn't enforce — keeping the kernel uniform. If a client forgets the filter, templates leak into the list; it's a UI bug, not a security one. We could revisit by making `card.select_with_attributes` default to excluding `is_template=true` for the `project` card_type specifically, but that introduces a per-card-type special case in the read handler — exactly the kind of thing the kernel is built to avoid.

### Flipping a project's template bit

`is_template` is a regular attribute. `attribute.update` toggles it freely (subject to role_grant). Practical effects:

- Setting `is_template=true` on a normal project: the project disappears from user lists. Its tasks still exist, just nobody-with-non-admin role sees them. The project becomes available as a stamping source. Useful for "I built this project carefully; promote it to a template."
- Setting `is_template=false` on a template: the template appears in user lists alongside real projects. Anyone with view access sees its (typically empty) task list. Useful for "I want to actually run this template as a real project."

Both operations are reversible. No data is lost. The admin UI surfaces the current state; the toggle is a normal attribute edit.

### Variants on templates (deferred for v1)

- **Provenance tracking**: a `stamped_from_project_id` attribute on stamped projects, populated by `project.stamp`. Enables future "re-apply template improvements to existing projects" workflows. Not in v1.
- **Template tasks**: include `task` cards in the stamp ("starter pack" templates with example tasks). Add a `copy_tasks: bool` flag to `project.stamp`. Not in v1.
- **Template versioning**: snapshot of a template at a point in time, used for stamping, so subsequent template edits don't change what new projects look like. Not in v1; the live template *is* the snapshot, and edits affect only future stamps.
- **Cross-install template sharing**: export a template project to a file, import on another install. The existing project-export machinery handles this for free if it ever becomes a feature; the template is just a project.

## Implementation plan

### Gates (agent handoff contract)

Each numbered step below is a **gate**. An agent dispatched to advance this work is given **only one gate at a time**, with the explicit instruction to:

1. Implement exactly the named step (and its prerequisites only if not already done).
2. Run `cd server && go test -count=1 ./...` — every package must pass.
3. Run `cd client && npm run check && npm test` — type-check + unit tests pass.
4. Commit. Stop. Report back.

No agent gets multiple gates in one dispatch. The orchestrator (Claude or the user) verifies the gate's effects (build + tests + spot diff) before authorizing the next gate. This prevents the "half-applied state" failure mode where an agent rushes through 5 steps and leaves something broken three commits ago that's now hard to bisect.

Gate prerequisites are encoded as the dependency line at the bottom of this section.

### Gates

1. **`card.phase` rename + 3-value enum.** Add column, migrate (`is_terminal=TRUE → phase='terminal'`, existing in-flight statuses → `phase='active'`, drop is_terminal). Update `where.go` `not terminal` SQL to read `phase = 'terminal'`. Add `has_phase` predicate op. Update demo seed: add `New idea` / `Triage` status per project with `phase='triage'`. Update the `card` table's doc string in `schema.hcsv` (still references `is_terminal`). Update `test_demo.hcsv` to re-add the `phase` column on its status card row (was dropped pending this rename). Self-contained.
2. **Status becomes required on `task`.** Flip the `is_required` flag on the `edge` row for (task, status). Update seed/demo so every existing task has a status (the demo already does; verify test_demo). Add invariant test.
3. **`flow` + `flow_step` tables + handlers.** `flow.set / delete / list / preview_delete`, `flow_step.set / delete / list`. `flow.scope_card_id` is `NOT NULL`. Include `flow.default_create_status_id`. `flow_step.from_card_id` is `NOT NULL`. No write path through `attribute.update` yet — admins can author transitions without them taking effect.
4. **`flow_step.list_for_card` handler.** Server-side join that returns transitions + `from_phase`/`to_phase`/`allowed` for a given card id. The same query is reused by the rejection envelope in gate 5 — share the implementation, parameterise the call sites.
5. **`attribute.update` flow authz + positive-feedback rejection.** Add the validation branch; existing role_grant still applies as an outer gate. On reject, populate `available` in the error envelope via `flow_step.list_for_card` — **same function** the read-side handler uses. The MCP tag set at `server/internal/mcp/` consumes the identical envelope (different renderer; same payload).
6. **`card.insert` default-create-status resolution (client side).** QuickEntry resolves the chain (screen → flow → first triage by sort → first active by sort → error) and includes `status` in the payload's `attributes`. Server validates as a normal required attribute.
7. **`<TransitionBar>` component.** Replaces `TerminalActionButton`. TaskRow + TaskDetail switch over. Old widget deleted in the same commit.
8. **Screen attributes: `slug`, `hotkey`, `flow_ref`, `default_create_status`, `view_requires_role`, `toggle_groups`.** Add to `seed.hcsv` (the attribute_defs) and to existing seeded screens. Hotkey uniqueness is **app-level**, not DB-level: an in-transaction SELECT before INSERT/UPDATE on `attribute_value` for the `hotkey` attribute, scoped to `(parent_card_id, value)` (see V2 below). Backfill the 4 existing seeded screens with slugs (`inbox`, `grid`, `kanban`, `project`).
9. **Router restructure.** `/project/:id/screen/:slug` becomes the only screen URL. Old paths `/inbox`, `/grid`, `/kanban` deleted. Hotkey chords register per project on scope change; AppShell's hardcoded `NAV_CHORDS` becomes a runtime loop. The four existing screen components become body renderers behind `<ScreenHost>` and lose their bespoke data-fetch + filter-bar + viewMode logic. **Blast radius:** grep for `/inbox`, `/grid`, `/kanban`, `navigate(`, `useShortcut(.*'g ` — every match needs updating. Also: SPA fallback in `server/internal/api/api.go`, every E2E test, every project doc.
10. **`is_template` attribute + `project.stamp` handler.** Add the attribute. Implement the graph-copy handler with ID remapping including predicate-tree rewriting. Tests: round-trip stamp + verify new project has independent IDs but equivalent structure. **Implementation note**: the graph-copy logic can (and ideally should) be generated mechanically from the schema-as-data — given a root card and the FK / card_ref relationships in `schema.hcsv` + `seed.hcsv`, the copy walks all reachable descendants and remaps ids. Pre-compile-time codegen against the schema produces a stamping function specialised to the current schema; runtime stays cheap. If the agent finds this too ambitious for one gate, fall back to a hand-written copy; mark the codegen path as a follow-up.
11. **Refactor seed to template-stamping pattern.** Current seed/demo becomes "the template project." Add a stamping step (Go post-apply hook calling `project.stamp`) to produce the demo project. Seed the Ideas + Archive screen cards into the template.
12. **Client: template-aware project listing.** `ProjectsScreen` ships the `is_template != true` predicate. Admin project list adds the "Template" badge column + optional "Show templates" toggle.
13. **Drop dead code.** `SCREEN_TYPES` constant, `viewMode` state on Inbox, `TerminalActionButton`, `screen_type` enum docs, the `screen.predicate` attribute proposal. Same commit as gate 9 or a follow-up.

**Cross-cutting cleanup (do at gate 5 or earlier):** the hcsv seed loader's `isCardRefArrayAttr` currently has a hardcoded `tags` switch. Convert to schema-driven by reading `attribute_def.value_type` from the parsed schema model. Or expose a seed-side property declaration. Either way, no hardcoded value-type knowledge in the loader.

**Cross-cutting cleanup (do at gate 1):** `card_id`-resolution and any other place that hardcodes "this is the name column" should be removed; the meta block in schema.hcsv is the single source of truth.

### Dependency graph between gates

- Gate 2 needs 1 (triage value-cards must exist before flipping required).
- Gate 5 needs 3 and 4.
- Gate 6 needs 1, 2, 3 (the default-status chain must resolve to a real triage row).
- Gate 7 needs 4 (TransitionBar reads `flow_step.list_for_card`).
- Gate 9 needs 8 (screens carry slugs).
- Gate 10 is independent of 1–9 in principle, but the predicate-rewrite logic needs the schema model from earlier gates to be stable; do gate 10 only after gate 8.
- Gate 11 needs 10 (the stamp handler) and 8 (the screen attributes the template carries).
- Gate 12 needs 11 (the template / demo split must exist before the listing filters them apart).
- Gate 13 is a sweep — runs after every other gate.

## Variants and risks

This section is deliberately the longest. The previous discussion converged fast, which means edge cases got glossed.

### V1 — Routing (resolved)

One route pattern, slug-in-path: `/project/:id/screen/:slug`. The slug is a per-project unique URL-safe token on each screen card. There are no per-layout aliases — `/inbox`, `/grid`, `/kanban` are *removed*, not redirected, because keeping them would re-introduce the hardcoded-layout exception the design is trying to eliminate. The router resolves `/project/:id/screen/:slug` to a screen card by looking up `(parent_card_id, slug)`; the screen card's `layout` attribute picks the renderer. Non-screen routes (`/projects`, `/activity`, `/task/:id`, `/admin/*`) stay as today — they are not screens-over-task-data and have no slug.

Bookmark stability: changing a screen's slug breaks bookmarks pointing at the old slug. The admin UI warns on rename. We do not maintain a slug-history table for v1; if it becomes a real complaint, add `(parent_card_id, old_slug)` redirect rows later.

### V2 — Per-project hotkeys (resolved, app-level enforcement)

The DB-level partial-unique index originally proposed isn't buildable as stated: `attributes` is not a column on `card` — attribute values live in `attribute_value` rows keyed by `(card_id, attribute_def_id)`. Enforcement is therefore **app-level**, inside the existing `attribute.update` handler:

When the inbound update targets the `hotkey` attribute on a `screen` card:

```
BEGIN tx (the existing attribute.update tx)
  SELECT EXISTS (
    SELECT 1
    FROM attribute_value av
    JOIN attribute_def ad ON ad.id = av.attribute_def_id
    JOIN card c ON c.id = av.card_id
    WHERE ad.name = 'hotkey'
      AND av.value = $newValue
      AND c.parent_card_id = $screenParent
      AND c.id <> $screenId
      AND c.deleted_at IS NULL
  ) AS dup;
  if dup: reject with code 'hotkey_in_use' and the conflicting screen's title.
  proceed with the normal UPSERT.
END tx
```

The check is single-query and runs inside the same transaction, so concurrent writes don't race. The error envelope echoes the conflict so the admin UI can tell the user "the `i` hotkey is already used by Inbox in this project."

At runtime, AppShell registers the chord set on the *currently-scoped project*'s screen cards. When projectScope changes, the previous set unregisters and the new set registers — a single effect listening on project scope. Outside a project (on `/projects`, admin pages), no project-screen chords are live; only the global ones (`g p` for projects, etc.).

### V3 — Read-only vs hidden (resolved)

Two attributes, two mechanisms:

- `view_requires_role` on the screen card (card_ref → role, optional): when the actor lacks the role, the screen is hidden from sidebar, chord registry, and direct URL access (returns 404 via the router gate). No screen card with this attribute is ever rendered for an unauthorized actor.
- Action gating is *emergent*: TransitionBar renders only the `flow_step` rows whose `requires_role` the actor satisfies. A user with view rights but no transition rights sees a screen that shows rows but offers no action buttons. No explicit `read_only` flag needed.

The admin Flows UI warns when saving a flow whose entire step set is gated to roles no real users hold ("this flow locks all actors out of every transition"). This is a save-time lint, not a runtime constraint.

### V4 — Flow scope (resolved, simplified)

`flow.scope_card_id` is `NOT NULL`. Every flow is project-scoped; there are no install-wide / global flows. Templates for new-project seeding live in `declarative.toml`; project setup stamps copies into the DB. Resolution at write time is one indexed query: `SELECT * FROM flow WHERE attribute_def_id = $1 AND scope_card_id = $2` where `$2` is the task's project (walked from `parent_card_id` chain). If no row, no flow gate applies and `role_grant` alone governs `attribute.update`.

### V5 — Phase enum is load-bearing (kept)

The schema's `phase` column is `text NOT NULL CHECK in ('triage','active','terminal')`. Tasks always carry a real status value-card; the renderer's 3-way classification reads `value_card.phase` directly. No "unset" pseudo-phase, no client-side null check, no synthetic state.

We considered dropping phase entirely. Three things phase drives that would otherwise need other machinery:

1. **Predicate filtering without enumerating IDs.** "Show active work" becomes `{op:'has_phase', values:['active']}`, the same expression every screen in every project uses. Without phase, each screen's seed would have to enumerate its project's specific active-status card IDs — brittle, doesn't survive a status rename, and adds a per-project step every time the admin adds a new status.
2. **TransitionBar UI buckets.** The 3×3 `(from.phase, to.phase)` matrix yields five well-known UI buckets. Without phase, the kernel would need an enum on every `flow_step` row (back to the rejected `kind` enum) or per-screen button-rendering rules.
3. **Default-status resolution chain.** The last two fallbacks ("first triage-phase status by sort_order", then "first active-phase by sort_order") need phase as a structural marker on the value card.

Alternatives we considered and dropped:

- **Phase as lists on the flow** (`triage_states[]`, `active_states[]`, `terminal_states[]`): more flexible (a card can be active in one flow, terminal in another) but adds three card_ref array columns, a JOIN for every predicate, and admin overhead at flow-creation time. Pays for itself only if value-card reuse across flows becomes common — which we don't expect.
- **Phase as a tag on the value card**: reuses the tag mechanism but loosens the 3-way classification (a status could have no phase tag, or multiple). Not enforceable as a structural invariant.
- **Phase derived from flow structure** (e.g., "terminal = no outgoing flow_steps"): doesn't cleanly distinguish triage from active, since a triage status can have outgoing transitions to other triage statuses.

Phase as a 3-value enum is the smallest mechanism that makes screens portable across projects without manual ID enumeration. Keeping it.

### V6 — Required attributes (resolved)

`status` is `is_required=TRUE` on the `task` edge. Every new task carries a real status value-card from the moment of `card.insert`. Resolution of which status to pick happens client-side via the `default_create_status` chain at QuickEntry time, then the server's normal required-attribute check accepts the explicit value. The would-have-been "creation step" wrinkle dissolves entirely.

Risk to watch: if a deploy ever lands #2 (status required) without #1 (Triage value-card seeded), any project missing a triage status that never adopted the new flow will fail to create tasks. Mitigation: the migration in #1 seeds at least one triage status per project before #2 flips the edge to required.

### V7 — Multi-attribute flows interact independently

A task with both `status` and a separate stateful attribute (e.g. `review_state` with values `{pending, approved, rejected}` gated by an approver role; or `sla_state` `{green, yellow, red}` set by an external system) — each attribute carries its own flow. `attribute.update` for `status` checks the status flow; for `review_state` checks its flow. They are independent.

A natural design temptation is "if status moves to Done, also clear review_state." That's a cross-attribute side-effect, deliberately out of scope. Users who want that linkage wire it up at the call-site: a screen action that submits a batch with two `attribute.update` rows. The kernel doesn't compose flows transactionally across attributes; each flow gates exactly one column.

### V8 — Deleting a value card referenced by flow_step

Concrete example: admin creates statuses `Triage`, `Todo`, `Done` and adds `flow_step (from=Todo, to=Done, label='Complete')` plus `flow_step (from=Triage, to=Todo, label='Accept')`. Later, admin attempts to delete the `Todo` status card.

Kernel rejects:

```json
{
  "code": "value_referenced_by_flow",
  "message": "Cannot delete status \"Todo\": 2 flow_step rows reference it.",
  "blocked_by": [
    { "flow_step_id": 12, "role": "from", "to_label": "Done",  "flow_name": "Standard task" },
    { "flow_step_id": 14, "role": "to",   "from_label": "Triage", "flow_name": "Standard task" }
  ]
}
```

The admin sees what's blocking, can delete those flow_step rows individually, then retry the value-card delete. No silent cascade — losing flow_step rows the admin authored should be deliberate. The two cards live in two admin surfaces (AdminAttributes for value-cards, AdminFlows for flow_steps) and stay independent.

### V9 — Toggle semantics: explicit composition (resolved)

Toggles compose via named `toggle_group` nodes with explicit operators. Each group emits at most one predicate node into the screen's outer AND. The "Show closed" case — broadening a default-narrow scope — works naturally because the phase scope is itself an OR-mode toggle group: flipping the `terminal` item on adds an OR-child, which broadens. No `invert` flag, no per-toggle special case.

The interaction between operators across groups is fixed: groups always AND with each other at the screen level. If a future need requires OR-between-groups, model it as one bigger group with `operator='or'` and the relevant items.

### V10 — Predicate language gaps (resolved)

One new op: `has_phase` (step 1 of the plan). `is set` / `is unset` aliases were dropped — `exists` / `not exists` already serve. Future predicate ops (time windows, regex, attribute-of-attribute walks) remain out of scope for this kernel.

### V11 — Predicates live only on filter cards (resolved)

`screen.predicate` is removed. Filter cards are the only place a static predicate is stored. A screen has zero or more filter cards as children; `default_filter` (card_ref → filter, optional) points at the one the screen loads with. The user can pick a different filter card from the screen header at runtime; toggle groups apply on top of whichever filter is selected.

Three idioms emerge naturally:

- **No filter card.** The Inbox and Ideas seeds don't carry one — toggle groups (phase_scope + mine_only) determine the row set entirely.
- **One filter card, marked default.** The Archive seeds with a single "Last 30 days" filter card carrying the time-window predicate; users typically don't change it.
- **Many filter cards.** Power users save "P0 bugs," "Stale > 7d," etc., as filter cards under the Grid; one is the default, others are switchable at runtime.

Composition tree in all three cases is the same shape: `AND ( [selected_filter.predicate]?, toggle_group_contributions... )` with the filter child elided when there is no selection.

### V12 — Migration mechanics

`card.is_terminal` is currently set only by the demo seed (`server/internal/store/migrate_test.go:26` asserts the seed result). Rename in declarative.toml; drop the old column. Because kitp resets the DB from declarative.toml (no migration chain), there is nothing to migrate in production — just edit the schema and reseed dev DBs. Any in-flight branches with `is_terminal` references rebase after the rename lands.

### V13 — Positive-feedback rejection envelope (resolved)

A flow-disallowed `attribute.update` is a *warning with instructions*, not a bare error. The reject envelope carries everything the caller needs to recover, computed server-side from `flow_step.list_for_card` on the same code path the read API uses:

```jsonc
{
  "ok": false,
  "error": {
    "code": "flow_disallowed",
    "message": "Cannot move status from \"Doing\" to \"New idea\".",
    "from": { "id": "101", "label": "Doing", "phase": "active" },
    "attempted_to": { "id": "99", "label": "New idea", "phase": "triage" },
    "available": [
      { "step_id": "42", "to": {"id":"103","label":"Done","phase":"terminal"},
        "label": "Done",     "your_role_allows": true,  "requires_role": null },
      { "step_id": "43", "to": {"id":"104","label":"Cancelled","phase":"terminal"},
        "label": "Cancel",   "your_role_allows": true,  "requires_role": null },
      { "step_id": "44", "to": {"id":"103","label":"Done","phase":"terminal"},
        "label": "Approve",  "your_role_allows": false, "requires_role": "manager" }
    ]
  }
}
```

UI rendering: a sticky banner near the failed action — "Doing → New idea isn't a valid move. You can: [Done] [Cancel] or ask a manager to [Approve]." The allowed transitions render as live action buttons (one click fires the right `attribute.update`); the role-locked ones render disabled with the required role surfaced.

MCP rendering: the same JSON envelope. The LLM reads `available[]` and picks a different transition or surfaces the role requirement to the user. No special MCP-only handler logic — the structured payload is the same; only the renderer differs.

Server-side cost: one extra call to `flow_step.list_for_card` on the reject path. We already make this query on the read side; reusing the function on the write rejection costs one query in the unhappy path.

### V14 — TerminalActionButton is subsumed by TransitionBar

`ui/widgets/TerminalActionButton.svelte` exists today and is called from exactly two places: TaskRow (inline row affordance, hover-revealed) and TaskDetailScreen header. It implements one UI bucket — "Close ▾" — by fetching value-cards flagged `is_terminal=TRUE` and rendering them as a split button.

`<TransitionBar>` implements the full 9-cell matrix from one data source (`flow_step.list_for_card`). The Close split is one of its buckets; Reopen, Accept, Reject, Progress are others. Strictly more functionality, one input, no special-cased prop.

Consequence: TerminalActionButton.svelte gets deleted in the same commit that adds `<TransitionBar>` and switches both call sites over. No functionality is lost; the keyboard shortcut for close (`c`) attaches to the Close bucket of TransitionBar instead of the dedicated widget. Tests covering TerminalActionButton (`widgets.test.ts`) move to the TransitionBar test file with the same coverage shape.

### V15 — Filter chip UI in the toolbar

ScreenFilterBar shows quick chips for known attributes. With flows, "Status" chip values are still the value-cards (Triage/Todo/Done) and chips display the value-card's `title` — not the underlying card id. The chip system is independent of the flow; flows govern *transitions*, chips filter *current value*. No change to this surface beyond verifying titles render everywhere.

### V16 — Deleting a flow surfaces affected user data

Two-step admin pattern, same shape as V8:

1. `flow.preview_delete { flow_id }` — dry-run handler. Returns a structured preview:

   ```jsonc
   {
     "flow_id": "7",
     "flow_name": "Standard task",
     "step_count": 12,
     "tasks_currently_in_flow_states": 87,
     "tasks_by_phase": { "triage": 3, "active": 60, "terminal": 24 },
     "sample_step_labels": ["Accept", "Reject", "Start", "Send to review", "..."]
   }
   ```

2. The admin UI renders: "Deleting will remove 12 flow_step rows. 87 tasks currently sit in statuses governed by this flow — they keep their status values, but future `attribute.update` calls will no longer be gated by transitions (role_grant alone applies)." Admin confirms.

3. `flow.delete { flow_id }` — actual delete. Cascades wipe flow_step rows; the flow row goes. Value-cards remain (they're independent rows in `card`); tasks remain (their `attribute_value` rows point at value-cards, not flow_steps).

Same dialog shape applies to value-card delete (V8) and flow_step delete (which is simpler — only need to confirm the step is gone, no downstream task data is affected).

### V17 — Toggle state is not persisted

Toggles reset to their `default_on` on every screen load. No sessionStorage, no per-user state. The defaults are author-set on the screen card and are the source of truth every time the screen mounts. If a user wants a persistent variation, they save a filter card with the equivalent predicate and pick it as their default.

Cost: a user who flips a toggle, navigates to another screen, and comes back finds the toggle reset. Trade-off accepted in exchange for one less stateful surface to reason about — the screen's behavior is fully determined by its data + the actor's session-invariant facts (roles, project scope).

### V18 — Two flows on the same attribute, both global

Forbidden by the `unique (attribute_def_id, scope_card_id)` constraint. Two project-scoped flows on the same project are likewise forbidden. The admin UI enforces the same uniqueness with a friendly message.

### V19 — Per-project layout customization

A project admin might want their Inbox to use the `pair` layout. Currently the seeded Inbox is `list`. They edit the seeded screen card's `layout` attribute to `pair`. ScreenHost re-renders. Test that all four layouts handle the same row shape (they do today; the migration only formalises it).

### V20 — Tests

- Server unit: flow authz table-driven — `(actor_role, from, to, expected)` rows. Flow + flow_step CRUD tests. `attribute.update` integration test for "flow disallows transition" returning the new error code.
- Server unit: predicate `has_phase` table-driven against a fixture row set.
- Server unit: `not terminal` alias continues to pass.
- Client unit: TransitionBar bucket rule — one `describe.each` row per `(from.phase, to.phase)` pair (9 cells; assert correct bucket assignment).
- Client unit: predicate composition assembly — feed a screen card + active toggle states + flow + filter, assert the resulting tree shape (operator at every level, empty groups elided, single-child groups still groups).
- Client unit: default_create_status resolution chain — table per (screen.override, flow.default, sorted_statuses, expected_id).
- Client unit: ScreenHost layout dispatch.
- E2E: Ideas screen accepts an idea — the task moves from Ideas to Inbox (phase triage → active). Reject from Ideas — appears in Archive (terminal). Reopen from Archive returns the task to Inbox.

### V21 — Multiple flows on the same screen (not supported)

A screen can bind to at most one flow via `flow_ref`. If a card type has two stateful attributes (status + escalation_level), the screen can show transitions for only one of them at a time. The unselected attribute's transitions are not surfaced; users edit it from the TaskDetail screen which loops over all stateful attributes. Acceptable for the immediate scope; revisit if a real use case demands per-row dual TransitionBars.

### V22 — Empty composition tree edge case

If a screen has no `predicate`, no enabled toggles in any group, and no selected filter card, the composition produces `{operator:'and', children:[]}` (empty AND). The renderer drops the wrapper entirely and ships `tree: undefined` so the server returns the unfiltered row set for the card_type. This is the right behaviour — "no constraints" should mean "everything" — but it's worth confirming in tests that the unfiltered query is the intended outcome of an all-elided composition.

### V23 — Operator on a single-item group is observable but inert

A group with `operator='or'` and one enabled item produces `{operator:'or', children:[<item>]}` — an OR of one thing is just the thing. The operator is preserved for inspection / tree uniformity but doesn't change the query. Cost: zero (single-child OR is a degenerate case in SQL too). Benefit: the admin's intent is preserved in the predicate tree, so flipping `default_on` on a second item in the same group later doesn't change the operator semantics.

### V24 — Stamping an empty template

Edge case: admin creates a project, flips `is_template=true` on it before adding any flows/screens/statuses. Another admin calls `project.stamp` on it. Result: a bare project with no screens, no flows, no value cards — same as the fallback when no template exists at all. The handler succeeds (it copied zero rows correctly). The new project is unusable until someone adds at least one status and one screen. Acceptable; the admin UI warns when promoting an empty project to a template ("This template has no flows or screens — projects stamped from it will be empty").

### V25 — Predicate remap during stamping

A template's child cards include filter cards whose predicate JSON may reference specific card IDs. The stamp handler walks each predicate and substitutes IDs that map to copied rows. Three cases:

- The predicate references a card that's being copied (e.g., a value-card under the template). Remapped correctly to the new value-card id.
- The predicate references a card outside the template (e.g., a global person card, or a card in another project). Passed through unchanged.
- The predicate references the template's own card id directly (rare; e.g., a hand-authored `parent_card_id = <template>` leaf). The remapper substitutes the new project's id. Worth testing.

Rule of thumb: any card_id in the copied graph that maps to a remapped row gets the new id; anything else stays. The predicate compiler tells us which ops carry card-id values (the existing `card_ref` op set); the remapper consults the same metadata so adding new ops doesn't break stamping.

### V26 — Permission to stamp

`project.stamp` is a high-impact write (creates many rows). Authz: same as `card.insert` for `project` card_type — typically `manager` or `admin`. Workers can't stamp new projects. Configurable via `role_grant (role, card_type='project', process_name='project.stamp')`. If a worker tries, the existing role_grant rejection fires.

### V27 — Flipping `is_template` is unrestricted

Any user with `attribute.update` rights on the `project` card_type can flip `is_template`. Practical effect: the project disappears from / reappears in user lists. No data is lost. The admin UI surfaces the current state with a clear toggle; we don't gate the bit specifically because it composes correctly with the existing role_grant for the attribute. If we ever want admin-only `is_template` toggling, that's an attribute-level role_grant (per-attribute role gating) — a future feature we don't need now.

## What this costs vs. buys

Cost: 2 new tables (`flow`, `flow_step`), 1 column rename (`is_terminal` → `phase`, 3-valued), ~8 new handlers (flow CRUD, flow_step CRUD, flow_step.list_for_card, project.stamp, project.preview_delete, flow.preview_delete), 3 new client components (`<TransitionBar>`, `<ScreenHost>`, `<ScreenToggleGroups>`), 1 new predicate op (`has_phase`), 5 new screen attributes (`slug`, `hotkey`, `flow_ref`, `default_create_status`, `view_requires_role`, `toggle_groups`), 1 new project attribute (`is_template`). The four existing screens lose their bespoke top-level wrappers and gain a shared host.

Buy: Ideas / Archive / any future screen is a seeded row. Close button, Reopen button, Accept / Reject pair, custom workflow advance buttons, and (when relationship attributes get flows) Block / Unblock buttons all derive from the same data structure. Role gating on transitions is per-edge. The dual-purpose Inbox-as-agent-view branch becomes one more seeded card. New projects are stamped from data-driven templates instead of declarative.toml plumbing every install. The application is described by data; the kernel runs it.

Defer indefinitely: side-effects on transitions, multi-attribute composite flows, per-card flow_id overrides, guard predicates on transitions, `card_flow_position` substrate replacing attribute_value, template provenance, template versioning, template tasks.

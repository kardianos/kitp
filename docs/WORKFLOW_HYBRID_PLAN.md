# Workflow as classification + sub-card gates — hybrid

Status: draft, not yet implemented. Authored 2026-05-08 as the
synthesis of WORKFLOW_CLASSIFICATION_PLAN.md (Idea 2) and
WORKFLOW_SUBCARDS_PLAN.md (Idea 3). Read those first; this proposal
assumes their schema and walks the seams between them.

The premise: classification is the right *entry point* (Idea 2), and
sub-cards are the right *primitive* for gates that have ownership
(Idea 3). Neither alone covers the full ground — Idea 2 alone is too
thin on sign-offs (no per-gate activity stream); Idea 3 alone has no
story for how a card binds to a workflow in the first place. The
hybrid adopts both.

## Two artifact tiers

Workflow_defs in the hybrid declare *two* tiers of effects:

1. **Edge additions** — `attribute_def`s that become effective on the
   parent when bound. Light, embedded fields: `severity`,
   `target_release`, `customer_impact`. No assignee, no thread.
   Inline on the parent's side panel.

2. **Gate sub-cards** — separately-owned tracked items: `signoff`,
   `test_plan`, `review`. Have an assignee, a status, a comment thread.
   Render as a checklist strip on the parent.

The cut between the tiers is a judgment call but the heuristic is firm:
*does this artifact have an owner who can comment on it independently
of the parent?* If yes, sub-card. If no, attribute.

A workflow_def card carries both:
- an `attributes` field listing attribute_def ids to bind,
- gate_template sub-cards listing gates to spawn.

## Classification flow

Same shape as Idea 2, with one extra sub-step:

1. Card created under intake card_type. Its effective edges union only
   the global `(card_type, *)` edges; status enum has the single value
   `unclassified`.

2. Classifier-role user invokes `card.classify` with the chosen
   workflow_def_ref. In one transaction the dispatcher:
   - sets `workflow_def_ref` on the card,
   - sets `status` to the workflow's `initial_state`,
   - **(new in hybrid)** spawns gate_template sub-cards as runtime
     gate cards under the parent (Idea 3's mechanism),
   - emits one `classified` activity row carrying the chosen
     workflow_def_ref.

3. Effective edges expand:
   - global `(card_type, *)`,
   - workflow-scoped `(card_type, workflow_def_id=X)`.

4. Status enum expands to the workflow's option list.

The classify process is a real `process` row whose steps are, in
order: `attribute.update` (workflow_def_ref + status), `gate.spawn`,
optional `entry_process` for the initial state. Step ordering matters
— gates must exist before any entry-process can consult them.

## Transitions and guards

A transition guard consults *both* sources:

- **State graph** (`workflow_transition` rows from Idea 2): is the
  target reachable from the current state?
- **Gate sub-cards** (Idea 3): are all gates whose
  `required_in_states` includes the target state in `approved` or
  `n/a`?

Both checks run before the status write commits. A failed guard
produces a structured error naming the offending state edge or the
unresolved gate. The client surfaces this as a toast on kanban
drag-drop and an inline error on the side panel.

A transition row may also fire a process (Idea 2's
`transitions[].process_id`) — useful for "promote to in-review"
running an existing `task.update_with_comment`-style composition.

## Schema changes

Union of Idea 2 and Idea 3, with no new tables beyond what each
proposal already introduces.

From Idea 2:

- `workflow_def` card type.
- `workflow_def_ref` attribute_def (`card_ref`).
- `edge.workflow_def_id` (nullable; null is global).
- `attribute_def_option.workflow_def_id` (nullable).
- `workflow_transition` table.
- `card.classify` process.

From Idea 3:

- `gate_template` and `gate` card types (plus optional specializations
  `signoff`, `test_plan`, `review`).
- `gate_kind`, `required_in_states`, `default_assignee`,
  `gate_template_ref` attribute_defs.

Shared:

- The classify process expands to also run the gate-spawn step. A
  `process_step` addition, not new schema.

If PROJECT_SCOPED_SCHEMA_PLAN ships before this, edges' uniqueness
expands to a four-tuple: `(card_type_id, attribute_def_id,
project_type_id, workflow_def_id)` with null-as-wildcard semantics on
both scope columns.

## Effective-edge resolver

The resolver's output is the union over all matching scopes:

```
effective_edges(card) =
    let project_type = enclosing_project(card).project_type_id
    let workflow     = card.workflow_def_ref
    SELECT * FROM edge
    WHERE card_type_id = card.card_type_id
      AND (project_type_id IS NULL OR project_type_id = project_type)
      AND (workflow_def_id IS NULL OR workflow_def_id  = workflow)
```

Three null-as-wildcard axes; cardinality stays bounded because
real-world configurations don't combine all three at once.
`card.select_with_attributes` runs this once per card group via a
LATERAL join.

## Migration order

Forward-only, ordered to keep partial rollouts coherent. Adopts both
proposals' migrations with the dependencies merged. Numbers are
placeholders.

1. **NN — workflow_def card type + workflow_def_ref attribute_def +
   workflow_transition table.** Idea 2's foundation. Cards can bind to
   workflows even without gates.

2. **NN+1 — `edge.workflow_def_id`** + `attribute_def_option.workflow_def_id`.
   Effective-edge resolver gains the workflow axis.

3. **NN+2 — gate-related card types** (gate_template, gate, optional
   specializations) + their attribute_defs (`gate_kind`,
   `required_in_states`, `default_assignee`, `gate_template_ref`).
   Idea 3's primitive.

4. **NN+3 — server changes.** Combined: classify spawns gates,
   transition guard checks both `workflow_transition` *and* gate
   sub-card states, classify-process step ordering pinned.

5. **NN+4 — client follow-ups.** Workflow_def admin (with gate
   template children rendered as a child grid), classify dialog, gate
   checklist strip on the parent, transition error rendering.

A repo can sit at NN+1 (workflows + attributes, no gates) and still
work as a pure Idea 2 deployment. Workflows whose workflow_def cards
have no gate_template children spawn no sub-cards. The hybrid
gracefully degrades to either pure proposal.

## Walked example: bug lifecycle

```
workflow_def "Bug Lifecycle"
  attributes:
    severity            (enum: critical/high/normal/low,
                         option list scoped to this workflow)
    customer_impact     (text)
  initial_state: triaged
  states: triaged, in_review, ready_qa, done, wontfix
  transitions:
    triaged    -> in_review   (process: bug.start_review)
    in_review  -> ready_qa
    ready_qa   -> done
    *          -> wontfix
  gate_template "Repro confirmed"  required_in_states=[in_review,ready_qa,done]
  gate_template "QA sign-off"      required_in_states=[done]
  gate_template "Release notes"    required_in_states=[done]
                                   default_assignee=role:tech_writer
```

A user creates a card. They hit "Classify" and pick "Bug Lifecycle".
On classify:

- `workflow_def_ref` set to the bug workflow's card id.
- `status` set to `triaged`.
- `severity`, `customer_impact` attributes become editable on the
  side panel (effective via the new edge axis).
- Three gate sub-cards spawn under the card: "Repro confirmed",
  "QA sign-off", "Release notes" (the last assigned to whoever holds
  the `tech_writer` role).
- One `classified` activity row appears, naming the workflow_def.

Engineer fills in severity, comments, fixes the code. They drag the
card to `in_review`. The transition guard:

- Checks `workflow_transition`: triaged → in_review is allowed. ✓
- Checks gates required in `in_review`: "Repro confirmed". Gate
  status is `pending`. ✗

Drag fails. A toast says "Repro confirmed not approved." The engineer
opens the gate sub-card, the QA assignee marks it approved, the drag
succeeds. (As a side effect the `bug.start_review` process fires in
the same transaction — perhaps it posts a comment with reviewer
assignment.)

When the engineer eventually drags to `done`, the same loop runs for
"QA sign-off" and "Release notes."

## UI implications

The hybrid combines both proposals:

- **Workflow_def admin** — a card detail page with `attributes[]`
  shown inline and gate_template sub-cards listed below as a child
  grid. Two distinct shapes for editing, surfaced as two distinct UI
  affordances.
- **Side panel on a bound card** — `workflow_def_ref` plus
  workflow-scoped attributes inline; gate checklist strip below them.
- **Inbox** — gates assigned to me appear naturally (Idea 3);
  transitions the user is responsible for can be surfaced by joining
  `workflow_transition` with role.
- **Kanban** — drag-drop runs both guards in one batch; failure
  messages distinguish "not a legal transition" from "gate X
  unresolved."

## Risk + open questions

Inherits both proposals' risks. Specific to the hybrid:

- **Two definitions in one workflow_def card.** A workflow_def card
  declares attributes (a flat list field) and gate_templates
  (sub-cards). Two shapes for editing — the first is an inline
  multi-select, the second is a child grid. The admin UI has to expose
  both clearly so authors don't confuse them.

- **Spawn ordering.** Classification fires several writes in one
  transaction: set workflow_def_ref, set status, spawn gates,
  optionally fire an entry process. Order matters: spawn gates before
  any process that might consult them, or the process sees an empty
  gate set. The classify process_step ordering pins this:
  `attribute.update` (workflow_def_ref + status, ordinal=1),
  `gate.spawn` (ordinal=2), entry-process steps (ordinal=3+).

- **Gate naming key.** Idea 3 noted v1 should add `gate_template_ref`
  to runtime gates so renaming a template doesn't break the join. The
  hybrid bakes that in. Runtime gates carry a card_ref to a structural
  template card, which is a small precedent (most card_refs point at
  peer values, not templates) but a clean one.

- **Authz on classify.** `card.classify` is the highest-trust action in
  the hybrid — it sets the schema lens *and* spawns gate cards in one
  shot. The classifier role should be narrow and auditable. The
  activity row for `classified` includes the chosen workflow_def_ref
  so the audit trail is intact.

- **Workflow swap mid-life.** Re-classifying changes the workflow.
  Existing gate sub-cards aren't deleted (Idea 3's stance) and
  existing attribute values aren't deleted (Idea 2's stance). Both
  surface as "stale" until the user clears them. The hybrid inherits
  this trade-off — pragmatic but visually noisy. Worth a "garbage
  collect stale items" admin action.

- **Discoverability of the cut.** A workflow author has to decide for
  each effect: is this an attribute or a gate? Documenting the
  heuristic ("does it have an owner / a thread?") in the admin UI is
  cheap; living with author drift is the actual cost.

## What this proposal does *not* try to be

- A general business-process modeler. No BPMN, no fork/join, no
  parallel branches. The state machine is finite (with optional
  `* -> wontfix`-style escapes); the gate set is flat per state.
- A replacement for the existing `process` table. Classifications
  *are* processes (composed of steps); transitions can fire processes;
  the existing concept is unchanged.
- An attempt to make every workflow concept first-class in SQL. JSON
  on workflow_def attributes is fine for things like
  `required_in_states`; we move to dedicated tables only when a read
  path becomes hot (`workflow_transition` earned its place).

## Out of scope

- Cross-card aggregation (epic depends on its children's gates).
- Predicate-driven gate inclusion ("only QA gate when severity=high").
- Workflow versioning. Live editing is at-your-own-risk.
- Time-based transitions (auto-close, gate auto-approve after N days).
- Per-state required-attribute lists ("description required to leave
  triaged"). Worth a follow-up but separable.
- Multi-approver gates with quorum. Modelable today as multiple
  gate_template cards with different `default_assignee`s but
  quorum-as-a-concept is not in the schema.

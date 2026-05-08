# Workflow as classification + schema selector — Idea 2

Status: draft, not yet implemented. Authored 2026-05-08 in response to
the "per-project process and classification" exploration. Treat this as
a sibling design to PROJECT_SCOPED_SCHEMA_PLAN.md; both extend the
effective-edge resolver, just along a different axis.

This proposal focuses narrowly on **classification as the lifecycle
entry point**. A new card starts in an `unclassified` state with a
near-empty schema. A privileged user classifies it; classification
picks a workflow definition; the workflow definition expands the card's
effective attribute set and constrains its allowed state transitions.

The companion proposal WORKFLOW_SUBCARDS_PLAN.md (Idea 3) makes the
*gate* primitive load-bearing. This proposal does not — sign-offs here
are attributes on the parent card, not separate sub-cards.
WORKFLOW_HYBRID_PLAN.md combines the two.

## Naming

The existing `process` table (migration 0001) names the
authorization/composition unit — `card.create`,
`task.update_with_comment`, etc. To avoid collision this proposal uses
**workflow** for the new concept. A workflow may *invoke* a process as
the action behind a transition; the two are different things.

## Concept

Introduce `workflow_def` as a card type. A workflow definition lives as
a card under a project (or, after PROJECT_SCOPED_SCHEMA_PLAN, a
project_type). Its attributes declare:

- `states[]` — finite list of named states, e.g. `triaged`,
  `in_review`, `done`.
- `initial_state` — state every classified card starts in.
- `transitions[]` — `(from, to, process_id?)` triples; the optional
  `process_id` is the existing-style process that runs when the
  transition fires.
- `attributes[]` — additional attribute_def ids that become effective
  on cards bound to this workflow.

A card carries a new attribute `workflow_def_ref` (`card_ref`)
pointing at the workflow_def card it follows. When unset, the card is
in the `unclassified` pseudo-state.

Whether classification *also* changes the card's `card_type` (issue →
task) or only attaches a workflow_def is a deliberate sub-choice.
Mutating card_type is unusual elsewhere in the system, so the simpler
default is: keep card_type stable, let workflow_def_ref do all the
work. "Issue lifecycle" and "Task lifecycle" become two separate
workflow_def cards under the same intake card_type.

## Classification flow

1. A user creates a card under the intake card_type. Its effective
   edges union only the global `(card_type, *)` edges. The status enum
   has a single value: `unclassified`.

2. A user holding the `classifier` role invokes `card.classify` (a new
   process). The sub-request carries the chosen workflow_def. In one
   transaction the dispatcher:

   - sets `workflow_def_ref` on the card,
   - sets `status` to the workflow's `initial_state`,
   - emits an activity row of kind `classified` carrying the chosen
     workflow_def_ref so the audit trail is intact.

3. From this point on the card's effective edges union:
   - global `(card_type, *)` edges,
   - workflow-scoped `(card_type, workflow_def_id=X)` edges.

   Reads pick up the wider attribute set; writes against attributes
   not in the union are rejected at sub-request validation, before the
   transaction opens.

## Schema changes

```sql
INSERT INTO attribute_def (name, value_type, is_built_in)
VALUES ('workflow_def_ref', 'card_ref', true);

INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
SELECT 'workflow_def', id, false, true FROM card_type WHERE name = 'project';

ALTER TABLE edge ADD COLUMN workflow_def_id bigint REFERENCES card(id);
ALTER TABLE edge DROP CONSTRAINT edge_card_type_id_attribute_def_id_key;
ALTER TABLE edge ADD CONSTRAINT edge_uniq UNIQUE (
    card_type_id, attribute_def_id, COALESCE(workflow_def_id, 0)
);
```

If PROJECT_SCOPED_SCHEMA_PLAN ships first, the unique constraint
expands to `(card_type_id, attribute_def_id, project_type_id,
workflow_def_id)` with the same null-as-wildcard convention on each
scope column.

`workflow_def_id` references `card.id` rather than a dedicated table:
workflow_defs are cards, so we get CRUD, ACL, comments, and history
for free.

## State and transitions

States are a string enum constrained per workflow:

- `attribute_def_option` (migration 0012) gains a `workflow_def_id`
  column; the status enum's option list is unioned by workflow.
- A `workflow_transition` table:

```sql
CREATE TABLE workflow_transition (
    workflow_def_id     bigint NOT NULL REFERENCES card(id),
    from_state          text NOT NULL,
    to_state            text NOT NULL,
    process_id          int REFERENCES process(id),
    PRIMARY KEY (workflow_def_id, from_state, to_state)
);
```

The dispatcher's status-update path checks: if the card has a
workflow_def_ref, the new status must be reachable from the old via a
row in `workflow_transition`. If `process_id` is set, the transition
fires that process's steps in the same transaction.

`workflow_transition` is a real SQL table (not card-modeled) because
the constraint is hot — every status update queries it — and the data
shape is rigid. Workflow_def itself remains a card; transitions hang
off it as a sibling table keyed by the workflow_def's card id.

## Sign-offs in this model

Without sub-cards, each sign-off is an attribute on the parent:

- `completion_signoff_status` — enum (`pending`, `approved`,
  `rejected`).
- `completion_signoff_by` — user_ref.
- `completion_signoff_at` — timestamp.

These are added to the workflow's `attributes[]` and become effective
edges only when the relevant workflow_def_ref is set. A transition
into `done` can require `completion_signoff_status = 'approved'` as a
guard.

Light, but loses what sub-cards would give:

- No comment thread per sign-off.
- No activity history specific to the sign-off (the parent's stream
  carries everything mixed together).
- No way to assign a sign-off to a person and have it land in their
  inbox naturally — `assignee` is a single field on the parent.

If those losses matter, see WORKFLOW_SUBCARDS_PLAN.md. If they don't,
this proposal is the cheapest path to per-project workflow.

## UI implications

1. **Workflow admin** — new card detail screen for workflow_def cards,
   plus an admin index. Editing transitions uses a small grid of
   from→to rows. Editing the attributes list is an attribute_def
   multi-select.

2. **Classify dialog** — a new action exposed on unclassified cards.
   Lists workflow_def cards in scope (filtered by project). Picking
   one fires `card.classify`.

3. **Status picker** — gains a `workflow_def_ref`-aware option list.
   The schema cache keys options by `(attribute_def, workflow_def)`
   rather than just `attribute_def`.

4. **Side panel** — workflow-scoped attributes appear inline once
   classified. Pre-classification, the panel shows only intake fields
   plus the classify action.

## Migration order

Forward-only, one per step. Numbers are placeholders (next free).

1. **NN — `workflow_def` card type** + the `workflow_def_ref`
   attribute_def + `card.classify` process and process_step rows.

2. **NN+1 — `edge.workflow_def_id`**, nullable; drop+re-add unique
   constraint to include it. No data backfill — every existing edge
   stays global.

3. **NN+2 — `attribute_def_option.workflow_def_id`**, same shape.

4. **NN+3 — `workflow_transition` table.**

5. **NN+4 — server resolver changes.** Effective-edge resolver gains
   the workflow axis; status-update path consults
   `workflow_transition`. Code-only but coupled to the schema above.

6. **Client follow-ups** — admin screen for workflows, classify
   action in the side panel, status picker constrained to reachable
   transitions.

## Risk + open questions

- **Two axes interact.** Adding workflow on top of project_type
  doubles the resolver's filter dimensions. Effective edges become
  `global ∪ project_type ∪ workflow_def`. Each axis is independent;
  a card scoped under project_type=Bugs *and* workflow_def=BugLifecycle
  unions both.

- **Re-classification.** Same answer as the project_type re-scoping
  question: keep the values, hide them in pickers, let the user clear
  them explicitly. Worth a banner in the side panel when stale values
  are present.

- **Live workflow editing.** Workflow_def is a card; users with the
  right role can edit it. Edits don't retroactively re-bind in-flight
  cards stuck in a now-removed state. Pragmatic answer: surface drift
  as warnings; offer an admin tool that lists affected cards. Versioned
  workflows are out of scope for this proposal.

- **Status enum readability.** Multiple workflows means multiple status
  vocabularies. Grid-view sort/filter on status has to respect the
  per-card workflow's option order, not a global one. The schema cache
  already keys options by attribute_def; it now keys by
  `(attribute_def, workflow_def)` too.

- **Transition guards beyond state.** A transition might require "all
  required attributes set" or "milestone has shipped." This proposal
  guards from→to only. Richer guards (predicates on attribute values)
  can layer on as JSON rules evaluated by the dispatcher; deferred
  unless asked.

- **Authz on classify.** `card.classify` is a high-trust action — it
  picks the schema lens for the rest of the card's life. The
  classifier role should be narrow and auditable. The activity row
  emitted on classify carries the chosen workflow_def_ref so the
  trail is intact.

## Out of scope

- Sub-cards as gates. See WORKFLOW_SUBCARDS_PLAN.md.
- Per-state required-attribute lists ("description required to leave
  triaged"). The MVP guards transitions by from-state only.
- Workflow versioning, workflow inheritance, workflow templates.
- Time-based transitions ("auto-close after 30 days idle").
- Cross-card aggregation (epic depends on its children's states).

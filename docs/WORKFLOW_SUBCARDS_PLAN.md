# Sub-cards as process-management primitive — Idea 3

Status: draft, not yet implemented. Authored 2026-05-08 in response to
the "per-project process and classification" exploration. Sibling
proposal to WORKFLOW_CLASSIFICATION_PLAN.md (Idea 2). The two partly
overlap and a synthesis lives in WORKFLOW_HYBRID_PLAN.md.

This proposal makes the **gate** primitive — a sign-off, test plan,
review, milestone-acceptance — a *sub-card* of the parent. A workflow
definition is itself a card; its sub-cards are gate templates. When a
parent card is bound to the workflow, the dispatcher clones each gate
template into a real gate sub-card under the parent. Resolution
(approve / reject / mark n/a) is just an attribute update on the gate
card.

The deliberate design move: nothing in the gate machinery is novel.
It's all cards, attributes, edges, activity, ACL. The novelty is the
*template-clone* step at bind time and the *transition guard* that
consults sub-card states.

## Naming

The existing `process` table names the authorization/composition unit
(`card.create`, `task.update_with_comment`). To avoid collision this
proposal uses **workflow** for the new concept and **gate** for the
sub-card primitive.

## Why sub-cards

A gate has:

- One or more assignees who decide.
- A status: pending, approved, rejected, n/a.
- A comment thread — the discussion that justifies the decision.
- An activity history independent of the parent.
- A possible due date / SLA.

That list is the same list as a card's. Modeling gates as anything
other than cards re-implements card features for one specific
sub-domain.

Sub-cards aren't only for work breakdown. They're a way to attach a
*separately-owned, separately-tracked work item* to a parent. A gate is
exactly that. Decomposition sub-cards (a story split into tasks) and
process sub-cards (gates) are distinct uses of the same primitive — a
heuristic to keep them separate: if it has its own assignee or comment
thread, it's a sub-card; if it's a flag with a status, it's an
attribute.

## New card types

```
workflow_def        -- declarative; lives under a project
gate_template       -- declarative; lives under a workflow_def
gate                -- runtime; lives under the parent task
test_plan_template  -- (optional) specialized declarative gate
test_plan           -- (optional) specialized runtime gate
signoff_template    -- (optional) specialized declarative gate
signoff             -- (optional) specialized runtime gate
```

Specializations are not strictly required — a single `gate` card_type
with a `gate_kind` attribute would do — but typed children make ACL,
inbox queries, and reporting clearer. `role_grant(role='qa',
card_type='test_plan', process='resolve')` reads better than a
JSON-filtered grant.

A `gate_template` card carries:

- `title` — name of the gate ("QA sign-off", "Security review").
- `gate_kind` — `signoff`, `test_plan`, `review`, …
- `required_in_states` — string array of parent states in which this
  gate must be resolved before the parent can leave / arrive.
- `default_assignee` — user_ref or role_ref for spawn-time assignment.

A runtime `gate` card carries:

- `title` — copied from the template.
- `gate_kind` — copied.
- `gate_template_ref` — backreference to the template; rename-safe key.
- `status` — `pending`, `approved`, `rejected`, `n/a`.
- `assignee` — usually copied from `default_assignee`, mutable after.
- standard activity / comment surface inherited from `card`.

## Workflow definition as a card with sub-card templates

A `workflow_def` card has gate_template sub-cards. To define a
workflow, an admin creates a workflow_def card and adds child
templates:

```
workflow_def "Bug Lifecycle"
  gate_template "Repro confirmed"  required_in_states=[in_review,ready_qa,done]
  gate_template "QA sign-off"      required_in_states=[done]
  gate_template "Release notes"    required_in_states=[done]
                                   default_assignee=role:tech_writer
```

This is uniform: workflow definitions are cards, gate templates are
cards, the editor is the existing card editor with the right edges
bound. No bespoke admin UI needed beyond exposing the right card
types under a workflow_def.

## Spawning gates

When a parent card binds to a workflow_def — by classification (see
WORKFLOW_CLASSIFICATION_PLAN.md), by direct attribute set, or by an
admin re-bind — the dispatcher walks the workflow_def's gate_template
sub-cards and inserts a runtime gate sub-card under the parent for
each one. This is one INSERT…SELECT against `gate_template`; it
coalesces into the batched-write path the rest of the system uses.

Spawning is idempotent at the `(parent, gate_template_ref)` pair: if
the parent is re-bound to the same workflow, no duplicates are
inserted. If re-bound to a *different* workflow, the previous gates
are *not* deleted — they become orphan sub-cards visible as "stale
gates" until the user clears them. (Soft-delete already handles the
clearing.)

## Transition guards via sub-cards

A status transition on the parent consults its gate sub-cards:

- For each gate_template marked `required_in_states` containing the
  transition's *target* state, find the matching runtime gate sub-card
  by `gate_template_ref`.
- If `status != 'approved'` and `status != 'n/a'`, reject the
  transition with a structured error naming the offending gate.

Cost is one extra read per transition: the gate cards are already
indexed by `parent_card_id` (idx_card_parent_card_id from migration
0001) and the count per parent is small.

## Schema changes

Mostly card-type and attribute-def additions, minimal new structural
tables:

```sql
INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in) VALUES
    ('workflow_def',  (SELECT id FROM card_type WHERE name='project'),      false, true),
    ('gate_template', (SELECT id FROM card_type WHERE name='workflow_def'), false, true),
    ('gate',          (SELECT id FROM card_type WHERE name='task'),         false, true);

INSERT INTO attribute_def (name, value_type, is_built_in) VALUES
    ('gate_kind',           'text',     true),
    ('required_in_states',  'text[]',   true),
    ('default_assignee',    'user_ref', true),
    ('gate_template_ref',   'card_ref', true),
    ('workflow_def_ref',    'card_ref', true);

-- Edges binding the new attributes to the new card types.
-- gate_template: gate_kind required, required_in_states required, default_assignee optional
-- gate:          gate_kind required, gate_template_ref required, status required, assignee optional
-- task (or any parent-eligible card_type): workflow_def_ref optional
```

The transition guard is server code, not schema. It reads the parent's
`workflow_def_ref`, joins to gate_template sub-cards under that
workflow_def, joins to runtime gate sub-cards on `gate_template_ref`,
and checks status.

## UI implications

1. **Card detail side panel** — gates render as a checklist strip:
   `[~] Repro confirmed  [✓] QA sign-off  [ ] Release notes`. Each
   item links to the gate sub-card. Click to expand inline; shift-click
   to open in a side drawer.

2. **Inbox** — a gate is a card with an assignee, so it lands in
   inboxes naturally. A "gates assigned to me" filter is just
   `card_type IN (gate, signoff, test_plan) AND assignee = me AND
   status = 'pending'`. No new query primitives.

3. **Workflow_def admin** — a card detail screen that lists
   gate_template children. CRUD on the workflow shape uses existing
   card creation paths.

4. **Kanban** — the parent's column reflects the parent's status. A
   gate strip on each card indicates progress at a glance. Drag-drop
   into a "done" column rejects with a toast naming the unresolved
   gate(s) when a transition guard fails.

## Migration order

Forward-only, one per step. Numbers are placeholders (next free).

1. **NN — gate-related card types** (workflow_def, gate_template,
   gate, plus any specializations) and the supporting attribute_defs
   (`gate_kind`, `required_in_states`, `default_assignee`,
   `gate_template_ref`, `workflow_def_ref`).

2. **NN+1 — edges** binding gate attributes to gate card types,
   workflow attributes to workflow_def, and `workflow_def_ref` to
   `task` (and any other parent-eligible card type).

3. **NN+2 — server changes.** Spawn step on workflow binding,
   transition guard on parent status update, parent-status-derivation
   read path that joins gate sub-cards.

4. **Client follow-ups** — checklist strip, gate detail rendering,
   workflow_def admin, inbox filter for gates.

This proposal is *additive*: no existing cards or attributes change
shape. A repo without any workflow_def cards behaves exactly as today.

## Risk + open questions

- **Card-count blow-up.** Every bound parent gains N gate sub-cards.
  A project with 1k bound tasks and 4 gates per workflow grows by
  4k gate cards. Acceptable in absolute terms but it changes the
  shape of common queries — `card.select_with_attributes`'s LATERAL
  join is per-card, so total card count matters. Worth a load test
  with realistic seed before shipping.

- **Gate-template editing.** Editing a workflow's gate_template list
  doesn't retroactively spawn gates on already-bound parents. The
  pragmatic answer: a re-bind action that idempotently spawns the
  delta. A migration tool that walks bound parents and reports drift
  is a separate deliverable.

- **Authorization granularity.** "QA approves test_plan" wants
  `role_grant(role='qa', card_type='test_plan', process='resolve')`
  and that already works. "QA approves test_plan **only on Project A**"
  needs a project-scoped grant — a known limitation surfaced in
  PROJECT_SCOPED_SCHEMA_PLAN's authz section.

- **Backreference precedent.** Runtime gates carry
  `gate_template_ref`, a card_ref pointing at a *template* (a
  structural definition) rather than a peer value. Most existing
  card_ref attributes (`milestone_ref`, `component_ref`) point at
  peer values. This isn't broken, but it's worth being explicit:
  templates are first-class cards, and pointing at them with card_ref
  is the natural choice.

- **What if the parent has no workflow?** The transition guard is a
  no-op. Cards without `workflow_def_ref` behave like today. Existing
  flows are preserved for users who don't opt in.

- **Cross-tree concerns.** Sub-cards live under their parent. If a
  parent is moved between projects (rare but legal), gates move with
  it. If gates are reassigned to a user from the destination project
  via `default_assignee`, the assignment doesn't auto-update — that's
  a follow-up if it becomes a need.

## Out of scope

- Classification per se — *how* a card binds to a workflow_def is the
  concern of WORKFLOW_CLASSIFICATION_PLAN.md. This proposal assumes
  some mechanism sets `workflow_def_ref`; the spawn step fires off
  that write.
- Cross-card gates ("epic doesn't ship until child task gates
  resolve"). The model is parent → sub-card only; cross-tree gates
  need card_ref aggregation, deferred.
- Conditional gate inclusion ("only require security review if
  severity = high"). Predicate-driven gate spawn is JSON-rule
  territory; deferred.
- Time-based escalation ("auto-approve after 7 days").
- Multi-approver gates (two signoffs required from distinct users).
  Implementable as multiple gate_template cards with different
  `default_assignee`s but the model doesn't currently express
  quorum.

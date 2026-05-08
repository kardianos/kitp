# Shared gates via card_ref aggregation — Alt 2

Status: draft, not yet implemented. Authored 2026-05-08 as a full
alternative to WORKFLOW_HYBRID_PLAN.md (and its components,
WORKFLOW_CLASSIFICATION_PLAN.md and WORKFLOW_SUBCARDS_PLAN.md). Read
the hybrid plan first; this proposal inverts one of its core
decisions.

The hybrid's premise: each parent card owns its gate sub-cards. A bug
gets its own "QA sign-off" gate; the next bug gets another one;
approving them is a per-card act. This proposal inverts that —
**gates are standalone cards that many parents reference**. One "v2.4
QA sign-off" gate covers every bug targeting v2.4. Approving it once
unblocks every referrer.

The driver: in real workflows many decisions are batch decisions —
release readiness, subsystem migration, legal sign-off on a campaign
launch. Replicating per-card under the hybrid creates fan-out (one
shared decision becomes N gate cards), and replication makes "approve
the batch" a manual fan-in. This proposal models the batch directly.

This proposal can deploy as:

- **A full replacement** for the hybrid's gate spawning — every gate
  is shared, no per-parent private gates.
- **An augmentation** of the hybrid — parents have both private gate
  sub-cards (hybrid behavior) *and* inherited shared gates. The
  transition guard unions both populations.

Augmentation is the recommended path. Most workflows want a mix:
"Repro confirmed" is per-bug (private), "QA sign-off" is per-release
(shared).

## Concept

A **gate card** lives as a real card with `card_type='gate'` (or a
specialization like `signoff`, `test_plan`). Unlike the hybrid, a gate
is not necessarily a sub-card of its consumer — it can live anywhere
appropriate (under a release, under a subsystem, under a project).

A parent card *inherits* gates from cards it `card_ref`s, when the
referenced attribute is marked as propagating gates. Two flavors:

- **Direct private gates** — a gate sub-card under the parent, as in
  WORKFLOW_SUBCARDS_PLAN.
- **Inherited shared gates** — gates that live as children of a card
  the parent references via a gate-propagating attribute.

The **effective gate set** of a parent is the union: gates whose
parent_card_id = parent.id, plus gates whose parent_card_id is any
card the parent references via a propagating attribute.

## Schema changes

Building on WORKFLOW_SUBCARDS_PLAN's gate card types and attributes:

```sql
ALTER TABLE attribute_def
    ADD COLUMN propagates_gates boolean NOT NULL DEFAULT false;
```

That's it. One column. The gate card_type, gate attributes
(`gate_kind`, `required_in_states`, `default_assignee`, `status`,
etc.), and the transition guard all come from the sub-cards plan;
this proposal just adds a flag that says "values of this attribute
should be walked when computing the parent's effective gate set."

If the sub-cards plan hasn't shipped, this proposal carries forward
the necessary card types and attributes from there as a prerequisite.

Built-in attributes likely to be marked `propagates_gates=true`:
`milestone_ref`, `component_ref`, plus any custom card_ref attribute
whose target is intended to be a gate-bearing context (e.g., a
`subsystem_ref`).

## Effective-gate resolver

Pseudocode for evaluating a parent's effective gates:

```
effective_gates(parent) =
    -- private: gate sub-cards directly under the parent
    SELECT g.* FROM card g
    WHERE g.parent_card_id = parent.id
      AND g.card_type_id IN (gate, signoff, test_plan, …)
      AND g.deleted_at IS NULL
  UNION ALL
    -- inherited: gates whose parent is referenced by `parent` via a
    -- propagating attribute
    SELECT g.* FROM card g
    WHERE g.card_type_id IN (gate, signoff, test_plan, …)
      AND g.deleted_at IS NULL
      AND g.parent_card_id IN (
          SELECT (av.value::text)::bigint
          FROM attribute_value av
          JOIN attribute_def ad ON ad.id = av.attribute_def_id
          WHERE av.card_id = parent.id
            AND ad.propagates_gates = true
            AND ad.value_type = 'card_ref'
        UNION
          SELECT (jsonb_array_elements_text(av.value))::bigint
          FROM attribute_value av
          JOIN attribute_def ad ON ad.id = av.attribute_def_id
          WHERE av.card_id = parent.id
            AND ad.propagates_gates = true
            AND ad.value_type = 'card_ref[]'
      )
```

The resolver walks one hop (the parent's direct references); transitive
propagation is intentionally not supported — it makes "why is my card
blocked" much harder to reason about. If transitivity becomes
necessary later, it's a separate proposal with cycle detection.

The transition guard runs WORKFLOW_SUBCARDS_PLAN's logic against this
expanded set: for each effective gate whose `required_in_states`
includes the target state, status must be `approved` or `n/a`.

## Walked example: release train

```
Release "v2.4" (card_type=milestone, parent=Project)
  gate "QA sign-off"     required_in_states=[done]  assignee=role:qa
  gate "Security review" required_in_states=[done]  assignee=role:security
  gate "Release notes"   required_in_states=[done]  assignee=role:tech_writer

Bug "Crash on save" (card_type=task)
  workflow_def_ref → "Bug Lifecycle"
  milestone_ref    → "v2.4"            ← propagates_gates=true
  gate "Repro confirmed" required_in_states=[in_review,done]   (private)

Bug "Login intermittent" (card_type=task)
  milestone_ref    → "v2.4"
  gate "Repro confirmed" required_in_states=[in_review,done]   (private)

Feature "OAuth integration" (card_type=task)
  workflow_def_ref → "Feature Lifecycle"
  milestone_ref    → "v2.4"
```

Effective gates for "Crash on save":

| Source    | Gate              | Required in    | Status   |
| --------- | ----------------- | -------------- | -------- |
| private   | Repro confirmed   | in_review,done | pending  |
| inherited | QA sign-off       | done           | pending  |
| inherited | Security review   | done           | pending  |
| inherited | Release notes     | done           | pending  |

Transition into `done` blocks on any of the four. Approving "QA
sign-off" once on v2.4 flips the inherited gate for *all three*
referrers (both bugs and the feature) in a single write. The Repro
gate is per-bug; each bug owns its own.

When all of v2.4's gates are approved and each bug's private gates
are also approved, all three referrers can transition to `done`.

## Authoring: shared vs private

The model doesn't force a decision at authoring time; the gate just
lives where the author puts it:

- A gate parented to the parent → private to that parent.
- A gate parented to a release / milestone / subsystem (anything with
  a `propagates_gates=true` referrer attribute) → shared with all
  referrers.

Workflow_defs (from the hybrid) can still carry gate_template
sub-cards for **private** gates that auto-spawn on classification.
Shared gates are authored on their owning context (Release, etc.) and
not bound to workflow_def at all — any card that references the
context inherits them automatically.

This means workflow_def authors don't need to know whether a given
gate will be shared. They declare "this state requires QA sign-off";
the runtime resolves where the gate lives by walking propagating
references.

## UI implications

1. **Gate strip on a card** — shows both populations, visually
   distinguished. Private gates render normally; inherited gates
   show a small badge naming the source ("v2.4") and link to the
   source card. Approval action on an inherited gate opens the source
   card; you can't approve it from the referrer's side panel because
   approval is global to all referrers.

2. **Source-card view** — the gate's owner card (e.g., the Release)
   shows a "consumed by" list: which referrers depend on its gates.
   Approving here updates the gate; referrers see the change on
   their next read.

3. **Inbox** — gate cards land in their assignees' inboxes regardless
   of sharing. Sharing doesn't affect inbox semantics; the gate has
   one owner regardless of how many referrers it has.

4. **Transition error rendering** — has to distinguish "your private
   gate is pending" (remediation: open it locally) from "an
   inherited gate is pending" (remediation: open the source card,
   ping the assignee). Different remediation paths produce different
   error messages.

## Migration order

If WORKFLOW_SUBCARDS_PLAN has shipped:

1. **NN — `attribute_def.propagates_gates`** column.
2. **NN+1 — built-in propagating attributes.** Mark `milestone_ref`,
   `component_ref`, and similar by default. New custom attributes
   default to `false`.
3. **NN+2 — server resolver changes.** Effective-gate resolver gains
   the inherited-gates union; transition guard consults it.
4. **NN+3 — client follow-ups.** Gate strip distinguishes
   private/inherited; source links; "consumed by" view on source
   cards; transition error rendering.

If sub-cards has not shipped, prepend its migrations (card types,
gate attributes, transition guard) — this proposal is meaningless
without them.

## Risk + open questions

- **Catastrophic over-blocking.** Rejecting a shared gate blocks every
  referrer at once. For a release sign-off this is correct; for an
  ambiguous "review" it could be a sledgehammer. Mitigation:
  encourage authors to write narrow gates ("Security review for OAuth
  changes") rather than broad ones ("Looks good"). Hard to enforce in
  schema; a docs/UX problem.

- **Per-referrer overrides.** "QA approves 78 of 80 bugs in v2.4"
  needs a way to mark specific referrers as `n/a` for an inherited
  gate without affecting the others. Two options:
  - (a) Per-referrer override attribute (`gate_override` jsonb on the
        parent listing exempt inherited gates).
  - (b) Process-only: QA approves the shared gate and bounces the two
        outliers back to `in_review` with comments.
  This proposal punts to (b) initially. (a) is a follow-up if it
  becomes necessary.

- **Gate ownership semantics.** A shared gate's assignee makes the
  decision once, and it applies broadly. The owner must be trusted to
  decide for the whole batch. If owned by a role rather than a
  person, anyone in the role can approve — may or may not match
  policy. No new authz primitive — same model as the hybrid.

- **Cycles via card_ref.** A propagating attribute that creates a
  reference cycle (A → B → A) would loop the resolver. The one-hop
  walk dodges this; if transitivity is added later, cycle detection
  is required.

- **Stale references.** If a parent's `milestone_ref` flips from v2.4
  to v2.5, it stops inheriting v2.4's gates. Any in-flight approval
  on v2.4-specific gates evaporates from this card's view. Usually
  correct; occasionally surprising. Worth emitting an activity row
  ("inherited gates changed: -3 +3") when a propagating attribute
  changes.

- **Performance.** The effective-gate query has two parts. The
  inherited side dereferences card_refs — fine for one parent at a
  time, more expensive in grid views (1k cards × N references each).
  Solvable with a `LATERAL` join keyed by `parent_card_id` and the
  existing index on `card.parent_card_id`, but worth an EXPLAIN
  ANALYZE on realistic seed before shipping.

- **Composition with project scoping.** A shared gate under a Release
  is implicitly project-scoped (Releases live under projects).
  Cross-project sharing requires releases that span projects, which
  is rare and out of scope here. PROJECT_SCOPED_SCHEMA_PLAN's
  project_type axis is orthogonal — propagating attributes work
  identically inside any project_type.

- **Discoverability.** Inherited gates can blindside users who didn't
  realize their card carried obligations from a referenced context.
  The gate strip's "v2.4" badge mitigates this in the UI; a "what's
  blocking me" view that explains every effective gate is a useful
  follow-up.

## When to prefer this over the hybrid

- Many cards target the same release / milestone / subsystem and
  share decisions for it.
- Approvers think in batches, not per-card.
- The duplication cost (one decision → N gate cards in the hybrid) is
  a recurring source of pain.

## When to prefer the hybrid

- Each card's gates are genuinely independent (per-bug repro, per-task
  code review).
- Approvers think per-card and the comment thread is per-card.
- Sharing introduces blast-radius concerns that outweigh the
  duplication savings.

The augmentation deployment lets you have both — private where it
matters, shared where it matters — at the cost of a more complex
mental model for new authors.

## Out of scope

- Transitive propagation. One hop only.
- Per-referrer gate overrides as a schema feature. Use process /
  comments / explicit `n/a` on the shared gate.
- Quorum / multi-approver shared gates ("two approvals needed").
  Modelable as multiple gate sub-cards under the source context, but
  quorum-as-a-concept is not in the schema.
- Time-based escalation on shared gates.
- Conditional propagation ("only inherit Security review when
  amount > $5k") — same conditional-gate gap as in the hybrid;
  unaffected by sharing.
- Cross-project shared gates. The propagating-attribute mechanism is
  agnostic, but no built-in cross-project context card type is
  defined here.

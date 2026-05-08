# Implementation plan — project-scoped schema, workflows, shared gates, aggregate guards

Status: draft. Authored 2026-05-08. This plan sequences the
implementation of three composable proposals:

- PROJECT_SCOPED_SCHEMA_PLAN.md — `project_type` as schema-customization
  unit, plus per-project-type and per-project enum option scoping (an
  extension to the original proposal — see Phase 1).
- WORKFLOW_HYBRID_PLAN.md — workflow_def + classification + state
  graph + gate sub-cards, plus the components it composes
  (WORKFLOW_CLASSIFICATION_PLAN.md, WORKFLOW_SUBCARDS_PLAN.md).
- WORKFLOW_SHARED_GATES_PLAN.md — gate inheritance via card_ref
  propagation.
- WORKFLOW_AGGREGATE_GUARDS_PLAN.md — predicate-driven transition
  guards over child attributes.

The user-facing scope is: **project types with edges/options scoped to
project type or project, workflows with classification + gates, shared
gates across referrers, aggregate guards on transitions.** Everything
called out as "out of scope" in the source proposals stays out of
scope here.

## Sequencing principle

Each phase is independently shippable and backward-compatible. A repo
running at the end of phase N behaves like a repo running phase N's
features only — earlier phases remain functional, later phases sit
inert. This lets us gate phases behind a feature flag and ship them as
discrete PRs without coupling.

Migrations are forward-only and use the next free number after `0016_attachment_thumbs.sql`
(starts at `0017`). Numbers below are illustrative; renumber at PR
time to match the live state of `db/migrations/`.

## Phase 0 — pre-flight

Goal: baseline + safety net before touching the schema.

- **0a — snapshot existing tests passing.** Capture a green run of
  `go test ./...` and the client unit tests; this is the baseline for
  every later phase to compare against.
- **0b — capture baseline EXPLAIN ANALYZEs** for the hot read paths
  (`card.select_with_attributes`, inbox query, kanban query) under
  realistic seed data (the dense_demo seed from migration 0007 is a
  reasonable starting point). Add the outputs to `docs/perf/baseline/`
  as the diff target for later phase performance checks.
- **0c — feature flag scaffolding.** Add a server config gate
  (`KITP_FEATURES` env var, comma-separated tokens) and a small
  helper in `server/internal/config` that exposes
  `features.Enabled("project_types")`, `features.Enabled("workflows")`,
  etc. Default off. Client mirrors it via the existing
  `client/src/config/`.

No migrations in this phase.

## Phase 1 — project type foundation

Goal: ship project_type, scope edges and enum options by project_type
*and* by project. No workflow yet.

This phase implements PROJECT_SCOPED_SCHEMA_PLAN.md verbatim **plus
one extension**: `attribute_def_option` gains a `project_card_id`
column for per-project enum option scoping, in addition to the
proposal's `project_type_id`. Resolution is union (option visible if
in scope at any axis); a CHECK constraint forbids both columns being
non-null on the same row.

### Migrations

- **0017 — `project_type` table.**
  ```sql
  CREATE TABLE project_type (
      id          serial PRIMARY KEY,
      name        text NOT NULL UNIQUE,
      doc         text,
      is_built_in boolean NOT NULL DEFAULT false,
      is_default  boolean NOT NULL DEFAULT false
  );
  CREATE UNIQUE INDEX uniq_project_type_default
      ON project_type(is_default) WHERE is_default = true;

  INSERT INTO project_type (name, doc, is_built_in, is_default)
  VALUES ('default', 'Catch-all type for unconfigured projects', true, true);
  ```

- **0018 — `card.project_type_id`** on project rows; backfill to
  default; nullable on non-project rows (resolver derives by ancestor
  walk).
  ```sql
  ALTER TABLE card ADD COLUMN project_type_id int REFERENCES project_type(id);
  UPDATE card SET project_type_id = (SELECT id FROM project_type WHERE is_default)
   WHERE card_type_id = (SELECT id FROM card_type WHERE name='project');
  ```

- **0019 — `edge.project_type_id`** + uniqueness.
  ```sql
  ALTER TABLE edge ADD COLUMN project_type_id int REFERENCES project_type(id);
  ALTER TABLE edge DROP CONSTRAINT edge_card_type_id_attribute_def_id_key;
  ALTER TABLE edge ADD CONSTRAINT edge_uniq UNIQUE (
      card_type_id, attribute_def_id, COALESCE(project_type_id, 0)
  );
  ```

- **0020 — `attribute_def_option.project_type_id` + `.project_card_id`.**
  ```sql
  ALTER TABLE attribute_def_option
      ADD COLUMN project_type_id int    REFERENCES project_type(id),
      ADD COLUMN project_card_id bigint REFERENCES card(id),
      ADD CONSTRAINT ado_scope_exclusive
          CHECK (project_type_id IS NULL OR project_card_id IS NULL);
  ```

  Constraint encodes "at most one scope". Both NULL means global; one
  non-null means scoped at that axis. `project_card_id` references a
  card row; the resolver constrains it at write time to project-typed
  cards.

### Server changes

- **`server/internal/dom/projecttype/`** — new domain package.
  CRUD handlers (`projecttype.insert`, `projecttype.select`,
  `projecttype.update`, `projecttype.delete`). Mirrors
  `cardtype` package shape.

- **`server/internal/dom/card/select_attrs.go`** — effective-edge
  resolver gains a project_type axis. Walk `card.parent_card_id` up
  to the enclosing project; read its `project_type_id`; filter edges
  on `project_type_id IS NULL OR project_type_id = $pt`.

- **`server/internal/dom/attributedef/attributedef.go`** — option
  resolver returns the union over (global, project_type-scoped,
  project-scoped). Caller passes both scope ids; either may be null.

- **`server/internal/dom/card/card.go`** — `card.insert` for
  `card_type='project'` accepts and validates `project_type_id`;
  defaults to the row marked `is_default`.

### Client changes

- **`client/src/screens/admin/`** — new `ProjectTypesScreen.svelte`
  modeled on the existing attributes admin. CRUD on project_type rows
  + a "Mark default" affordance.

- **Project create dialog** — gains a "Type" combobox loaded from
  `projecttype.select`. Read-only after creation in v1.

- **Schema cache (`client/src/reg/`)** — `AttributeSchemaCache` keys
  by `(attribute_def, project_type, project)` for option lists.
  Active scope's project_type and project id flow into option queries.

- **Admin attributes "Bound to" matrix** — gains the project_type
  column; existing global-only edges render with `project_type='*'`.
  Add a project_type filter at the top.

### Tests

- Unit: project_type CRUD; default uniqueness constraint; edge
  uniqueness with the new tuple; attribute_def_option scope CHECK
  constraint; effective-edge resolver across all axes; option
  resolver returns global ∪ project_type ∪ project unions correctly.
- Lifecycle: create project with non-default type → child task sees
  the type-scoped edges → option picker shows type-scoped options.
- Performance: re-run baseline EXPLAIN ANALYZE; assert the new
  filters don't regress card.select_with_attributes by more than
  15%.

### Acceptance

- A user can create a `Bugs` project_type and a project of that type;
  edges scoped to `Bugs` show up only on cards under that project;
  enum options scoped to `Bugs` show up only there; enum options
  scoped to a specific project show up only inside that project.

## Phase 2 — workflow infrastructure

Goal: workflow_def + classification + state graph. No gates yet.
Cards can bind to workflows; transitions are checked against the
state graph; effective edges expand by workflow.

### Migrations

- **0021 — `workflow_def` card type, `workflow_def_ref` attribute_def,
  `card.classify` process.**
  ```sql
  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
  SELECT 'workflow_def', id, false, true FROM card_type WHERE name='project';

  INSERT INTO attribute_def (name, value_type, is_built_in)
  VALUES ('workflow_def_ref', 'card_ref', true);

  INSERT INTO process (name) VALUES ('card.classify');
  -- process_step rows: attribute.update (ordinal=1)
  ```

- **0022 — `workflow_transition` table.**
  ```sql
  CREATE TABLE workflow_transition (
      workflow_def_id bigint NOT NULL REFERENCES card(id),
      from_state      text NOT NULL,
      to_state        text NOT NULL,
      process_id      int REFERENCES process(id),
      PRIMARY KEY (workflow_def_id, from_state, to_state)
  );
  ```

- **0023 — `edge.workflow_def_id`** + extend uniqueness.
  ```sql
  ALTER TABLE edge ADD COLUMN workflow_def_id bigint REFERENCES card(id);
  ALTER TABLE edge DROP CONSTRAINT edge_uniq;
  ALTER TABLE edge ADD CONSTRAINT edge_uniq UNIQUE (
      card_type_id, attribute_def_id,
      COALESCE(project_type_id, 0),
      COALESCE(workflow_def_id, 0)
  );
  ```

- **0024 — `attribute_def_option.workflow_def_id`** for status enum
  scoping per workflow.

### Server changes

- **`server/internal/dom/workflowdef/`** — new domain package.
  Workflow_def CRUD is mostly card CRUD with workflow-specific
  attribute validation (states, initial_state); add a small
  `workflow.set_transitions` handler that bulk-replaces
  `workflow_transition` rows for a workflow_def.

- **`server/internal/dom/workflowtransition/`** — read-side helper;
  exposes `Reachable(workflow, from, to)` consulted by the dispatcher.

- **Effective-edge resolver** — extend Phase 1's resolver to also
  filter by `(workflow_def_id IS NULL OR workflow_def_id =
  $card.workflow_def_ref)`. Same null-as-wildcard semantics.

- **Status-update guard** — when an attribute_value update is for the
  `status` attribute on a card with a non-null `workflow_def_ref`,
  the dispatcher consults `workflow_transition` and rejects
  unreachable transitions before commit. If the matching transition
  has a `process_id`, run that process's steps in the same
  transaction.

- **`card.classify` handler** — bundles `workflow_def_ref` set +
  `status` set to the workflow's `initial_state` + the
  `classified` activity row.

### Client changes

- **Workflow_def admin screen** — new card detail page for
  `card_type='workflow_def'`. Inline editor for `states[]`,
  `initial_state`. Separate transitions table editor with
  add/edit/delete.

- **Classify dialog** — accessible from the side panel of
  unclassified cards; lists workflow_defs in the active project's
  scope.

- **Status picker** — gains a workflow-aware option list. The
  picker hides options not reachable via a transition from the
  current status.

- **Schema cache** — keys options by `(attribute_def, project_type,
  project, workflow_def)`. Queries pass all four scope ids; null is
  permitted on each.

### Tests

- Unit: workflow_transition reachability lookup; classify process
  emits all three writes in one tx; effective-edge resolver across
  all four scope axes; status-update guard rejects unreachable
  transitions; workflow-scoped status options resolve correctly.
- Lifecycle: create workflow → bind a card → drag through legal
  transitions → drag illegal transition rejected → activity stream
  shows `classified` with the chosen workflow_def_ref.

### Acceptance

- A user can author a workflow_def, bind a card to it via classify,
  and the card's available statuses reflect the workflow's state
  graph. Illegal status transitions are rejected with a structured
  error.

## Phase 3 — gate sub-cards primitive

Goal: gates as cards; gate templates; auto-spawn on classify;
transition guard consults gate statuses.

### Migrations

- **0025 — gate-related card types.**
  ```sql
  -- gate_template lives under workflow_def
  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
  SELECT 'gate_template', id, false, true FROM card_type WHERE name='workflow_def';

  -- gate lives under task (or any parent-eligible card_type)
  INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
  SELECT 'gate', id, false, true FROM card_type WHERE name='task';

  -- (specializations: signoff, test_plan deferred to follow-ups unless
  -- explicit policy needs them; one generic 'gate' card_type with a
  -- gate_kind discriminator suffices for v1)
  ```

- **0026 — gate attributes + edges.**
  ```sql
  INSERT INTO attribute_def (name, value_type, is_built_in) VALUES
      ('gate_kind',           'text',     true),
      ('required_in_states',  'text[]',   true),
      ('default_assignee',    'user_ref', true),
      ('gate_template_ref',   'card_ref', true);

  -- edges binding gate attrs to gate_template / gate; status enum
  -- options for gate.status (pending, approved, rejected, n/a) via
  -- attribute_def_option.
  ```

- **0027 — `gate.spawn` process.** Adds a process_step that the
  classify handler runs after the attribute.update step.

### Server changes

- **`server/internal/dom/gate/`** — new package. `gate.spawn`
  handler: given a parent card and its workflow_def_ref, walk the
  workflow's `gate_template` sub-cards and INSERT `gate` rows under
  the parent. Idempotent on `(parent_card_id, gate_template_ref)`.

- **`card.classify` handler** — extended with `gate.spawn` as
  process_step ordinal=2, after the attribute.update step. Spawn
  ordering matters; pin it via the process_step PK.

- **Transition guard** — extended: in addition to the
  `workflow_transition` reachability check, walk the parent's gate
  sub-cards. For each gate whose `required_in_states` includes the
  target state, require `status IN ('approved', 'n/a')`. Reject with
  a structured error naming the offending gate(s).

- **Activity emission** — gate status updates emit standard
  `attr_update` rows on the gate card; surface them in the parent's
  side panel by extending the existing activity feed query to walk
  one level of children.

### Client changes

- **Gate checklist strip** — new component on
  `TaskDetailScreen.svelte` that lists gate sub-cards with a status
  indicator. Click expands inline; modifier-click opens detail.

- **Workflow_def admin** — gate_template children render as a child
  grid below the inline attributes editor. CRUD via existing card
  creation paths.

- **Inbox filter** — add a "gates assigned to me" toggle that filters
  to `card_type='gate' AND assignee=me AND status='pending'`.

### Tests

- Unit: gate.spawn idempotency; transition guard rejects when
  required gate is pending; transition guard accepts when gate is
  `n/a`; gate.spawn doesn't duplicate on re-classify.
- Lifecycle: classify → gates spawn → drag fails until gates
  approved → drag succeeds; reject one gate → drag fails again with
  named gate.

### Acceptance

- Classifying a card with a workflow that has gate templates
  auto-spawns gate sub-cards; the parent's status transitions are
  blocked until required gates are approved; gates appear in
  assignees' inboxes naturally.

## Phase 4 — shared gates

Goal: gate inheritance via card_ref propagation
(WORKFLOW_SHARED_GATES_PLAN.md). The augmentation deployment: private
+ inherited coexist.

### Migrations

- **0028 — `attribute_def.propagates_gates`.**
  ```sql
  ALTER TABLE attribute_def
      ADD COLUMN propagates_gates boolean NOT NULL DEFAULT false;

  -- Mark default propagators
  UPDATE attribute_def SET propagates_gates = true
   WHERE name IN ('milestone_ref', 'component_ref');
  ```

### Server changes

- **Effective-gate resolver** — replace the "gate sub-cards under
  parent" query with a union: private gates (parent_card_id = parent)
  ∪ inherited gates (parent_card_id IN derefs of parent's
  propagating-attribute values). One hop only; no transitive walks.
  Implemented as a single CTE query keyed by parent id; uses the
  existing index on `card.parent_card_id`.

- **Transition guard** — switches to consulting `effective_gates()`
  rather than direct sub-cards. Otherwise unchanged.

- **Stale-reference activity** — when a propagating attribute's
  value changes, emit an extra activity row on the parent
  (`gates_changed`, with old and new inherited gate id sets). Helps
  audit / debugging.

### Client changes

- **Gate strip** — distinguishes private vs inherited; inherited
  rows show a small badge linking to the source card. Approval
  action on inherited rows opens the source card; the strip itself
  doesn't allow approve.

- **Source-card view** — milestone / component / workflow_def
  detail pages gain a "consumed by" panel listing referrers whose
  effective-gate set includes a gate from this card.

- **Transition error messages** — distinguish
  `private gate "<x>" pending` vs `inherited gate "<x>" pending
  on <source-card>`; the second includes a link to the source.

### Tests

- Unit: effective-gate resolver returns the right union for cards
  with and without propagating attributes; one-hop only (verify a
  two-hop chain doesn't propagate); rejection on inherited gate
  blocks the transition; flipping `milestone_ref` away changes the
  effective set.
- Lifecycle: bug A and bug B both target v2.4; approve v2.4's QA
  gate once → both bugs unblock; revert → both block again.

### Acceptance

- A gate card under a milestone is inherited by every task whose
  `milestone_ref` points at that milestone. Approving the gate once
  satisfies the transition guard for all referrers.

## Phase 5 — aggregate guards

Goal: predicate-driven guards on transitions
(WORKFLOW_AGGREGATE_GUARDS_PLAN.md).

### Migrations

- **0029 — `workflow_transition.aggregate_guard`.**
  ```sql
  ALTER TABLE workflow_transition
      ADD COLUMN aggregate_guard jsonb;
  ```

### Server changes

- **`server/internal/dom/workflowtransition/predicate.go`** — new
  file containing the AST evaluator. Operators: `eq`, `neq`, `in`,
  `nin`, `lt`, `lte`, `gt`, `gte`, `set`, `unset`. Quantifiers:
  `all`, `any`, `none`. Empty-scope semantics: `all` true,
  `any` false, `none` true (and surfaced verbatim in errors).

- **Predicate stores attribute references by id, not name.** The
  evaluator resolves `attribute_def_id` to the column path; renames
  don't break stored guards. Workflow_def save-time validation
  walks the JSON and checks every referenced attribute_def_id
  exists and is bound by an edge in the workflow's effective scope.

- **Transition guard** — extends to also evaluate the
  `aggregate_guard` if non-null. Single SQL query per guard:
  ```sql
  SELECT count(*) FROM card c
  LEFT JOIN attribute_value av ON av.card_id = c.id
  WHERE c.parent_card_id = $parent
    AND c.card_type_id   = $scope_card_type
    AND c.deleted_at IS NULL
    AND <where-clause-rewritten-from-AST>
  ```
  Returns count; comparison vs quantifier yields pass/fail. Failure
  produces a structured error: `"3 of 7 test_cases not yet passed"`
  (count + total + readable predicate string).

- **Validator** — the server endpoint that saves a workflow_def
  (or a workflow_transition row) re-runs the AST validator on every
  guard. Bad guards rejected at save time, not at first transition.

### Client changes

- **Workflow_def admin transition editor** — gains an "Aggregate
  guard" expandable section. v1 ships as a JSON text area with a
  client-side schema check (mirrors the server's allowlist).

- **Transition error rendering** — distinguishes the three failure
  sources (state graph, gate guard, aggregate guard) with appropriate
  remediation hints.

- **"What's blocking me" panel** — new side-panel section on
  TaskDetailScreen that lists outgoing transitions and evaluates
  every guard, showing pass/fail per condition. Cheap (one read per
  transition); makes self-service debugging viable.

### Tests

- Unit: predicate evaluator covers each operator + quantifier;
  attribute references survive rename; empty-scope semantics
  documented and tested; guard validator rejects bad shapes;
  transition guard integrates correctly.
- Lifecycle (test plan): test_plan card with 3 test_cases →
  in_progress → approved blocked while any case pending → flip all
  to passed → transition succeeds.

### Acceptance

- A workflow author can declare an aggregate guard on a transition;
  bad guard JSON is rejected at save; transitions are blocked until
  the predicate is satisfied; the error message names what's
  outstanding.

## Phase 6 — integration & hardening

Goal: prove the composed system holds together; close out the perf
and migration loose ends.

- **Cross-feature integration tests.** The walked examples from the
  proposal docs become end-to-end tests:
  - Bug intake (Phase 2 + 3): classify → spawn gates → transition
    blocked → approve → transition succeeds.
  - Marketing campaign (Phase 2 + 3): multi-stakeholder gates;
    parallel approvals; "rework" transition resets gates if explicitly
    flipped.
  - Release train (Phase 2 + 3 + 4): one shared gate covers many
    referrers; approve once unblocks all.
  - Test plan with review (Phase 2 + 3 + 5): nested workflow on a
    gate sub-card; aggregate guard on `in_progress → approved`.

- **Performance pass.** Re-run baseline EXPLAIN ANALYZEs from
  Phase 0. Targets: card.select_with_attributes within 15% of
  baseline at typical scope (1k cards, 4 gates each, 1 propagating
  attribute); aggregate-guard evaluation under 100ms for 100
  children.

- **Migration drift tooling.** A small admin command that walks
  classified cards and reports:
  - Cards with `workflow_def_ref` pointing at a deleted workflow.
  - Cards with attribute values whose edges are no longer in scope
    ("stale attributes").
  - Cards inheriting gates from a deleted source card.
  Output is a CSV the user can act on; no automatic remediation in
  v1.

- **Documentation sweep.** Update README, REQUIREMENTS.md (Section
  3 / 4 additions), and the existing TASKS_PLAN.md to reflect the
  new domain entities. Add a `docs/AUTHORING_WORKFLOWS.md` quick-start
  for end users (separate from the design plans).

- **Authz follow-up note.** `role_grant` is keyed by
  `(role, card_type, process)`. Project-scoped or workflow-scoped
  authz is *not* shipped here — it remains a known limitation
  surfaced in PROJECT_SCOPED_SCHEMA_PLAN's "open questions". File a
  follow-up issue, link from this plan, move on.

## Cross-cutting concerns

### Testing strategy

- **Unit tests** live alongside their domain package (`*_test.go`
  in `server/internal/dom/<entity>/`). Continue the project's "real
  Postgres, no mocks" stance from N-TEST-4.
- **Lifecycle tests** in `server/internal/api/api_test.go` exercise
  the batch endpoint with multi-step scenarios.
- **Client unit tests** in `client/test/unit/` cover schema-cache
  scope keying and transition error rendering.
- **End-to-end tests** in `e2e/` get one flow per phase. The
  walked examples in Phase 6 become e2e specs.

### Performance budget

- card.select_with_attributes: ≤ 15% slower at end of phase 5 vs
  Phase 0 baseline.
- Aggregate guard evaluation: ≤ 100ms for 100 children.
- Effective-gate resolver: ≤ 50ms per card with 5 propagating
  references each pointing at a card with 5 gates.

If any budget is missed, profile + optimize before next phase
ships.

### Rollout

Each phase ships behind its own feature flag
(`KITP_FEATURES=project_types,workflows,gates,shared_gates,aggregate_guards`).
Migrations run unconditionally — they're additive — but server
behavior gates by flag. Client code reads the flags via
`/api/v1/config` and hides admin surfaces accordingly. This lets
production deployments enable phases incrementally with a one-line
config change and roll back without a schema revert.

### Migration ordering with concurrent work

Renumber migrations at PR time. If another change adds migration
0017 first, this plan's 0017 becomes 0018 and the chain shifts.
Each phase's migrations are internally consistent — within a phase
they must land together — but phases can interleave with unrelated
migrations.

## Risks not addressed elsewhere

- **Re-classification UX.** A card moving between workflows leaves
  stale attributes and orphaned gates. Phase 6's drift tool reports
  them; manual cleanup expected. A "garbage collect stale items"
  admin action is a follow-up.
- **Workflow editing on live data.** Renaming a state or removing a
  transition can strand in-flight cards. Phase 5's predicate
  validator catches the predicate-side breakage; transition-side
  breakage needs a separate migration walker. Filed as follow-up.
- **Sub-card recursion depth.** `task.allow_self_parent=true` plus
  gate sub-cards plus test_plan-as-card creates unbounded depth in
  the card tree. The UI renders one level inline; deeper trees need
  a tree view that doesn't yet exist. Out of scope for this plan;
  noted for the UI follow-up.
- **Authz granularity gap.** Project-scoped and workflow-scoped
  role grants are not shipped here. `role_grant` remains keyed by
  `(role, card_type, process)`. Documented limitation.

## What we are not building

Lifted from the proposal docs' "out of scope" sections, consolidated:

- Workflow versioning / time-travel.
- Conditional gate inclusion ("only require X when amount > 5k").
- Per-referrer overrides on shared gates.
- Cross-card aggregation beyond direct children.
- Time-based transitions / escalation.
- Quorum / multi-approver gates.
- Per-state required-attribute lists ("description required to
  leave triaged").
- BPMN / fork-join / arbitrary boolean composition in guards.
- Project-scoped or workflow-scoped role grants.

Each can become a follow-up proposal once the base lands and real
usage surfaces the need.

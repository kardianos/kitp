# Aggregate guards on transitions — follow-up

Status: draft, not yet implemented. Authored 2026-05-08 as a follow-up
to WORKFLOW_HYBRID_PLAN.md (and its components,
WORKFLOW_CLASSIFICATION_PLAN.md and WORKFLOW_SUBCARDS_PLAN.md). Pairs
naturally with the test-plan-with-review structure discussed in chat;
that's the motivating use case.

The hybrid's transition guards check two things today:

1. The state graph (`workflow_transition` rows) — is the target
   reachable from the current state?
2. Gate sub-cards — are required gates `approved` or `n/a`?

Neither covers a third common pattern: **predicates over aggregated
child attributes** — "all test_cases passed", "at least one
sub-task in done state", "no open blockers." This proposal adds
aggregate guards as a third class of transition check.

The motivating case is the test-plan workflow's `in_progress →
approved` transition: it wants to require all `test_case` children to
have `result IN ('passed','n/a')`. Doable manually today (the test
lead is trusted to not flip the state until the grid is green), but
the manual version scales poorly once 3+ workflows want similar
checks.

## Concept

A workflow_transition row gains an optional `aggregate_guard` JSON
field. When set, the dispatcher evaluates it as part of the transition
check; a false result rejects the transition with a structured error.

The guard is a small declarative expression: scope (which children to
look at), match (how many must satisfy), and where (the predicate over
their attribute values).

This is *not* a general rules engine. The expression language is
deliberately narrow — direct children only, attribute predicates only,
no cross-tree walks. Anything beyond this scope is either expressible
as multiple gates (use the gate primitive) or warrants a different
proposal (use SQL views or a real workflow tool).

## Schema changes

```sql
ALTER TABLE workflow_transition
    ADD COLUMN aggregate_guard jsonb;
```

That's it. The transition table is the natural home — every guard
attaches to one transition and runs in the same code path as the
existing state-graph check.

If multiple aggregate guards on a single transition becomes necessary,
the column can hold a JSON array; the v1 evaluator treats a JSON
object as a single guard and a JSON array as a logical AND. Punted on
authoring UX for arrays in v1.

## Expression language

```jsonc
{
  "scope":   {"card_type": "test_case"},
  "match":   "all",                              // all | any | none
  "where":   {"result": {"in": ["passed", "n/a"]}}
}
```

Components:

- **scope** — selects which descendants to evaluate. v1 supports
  direct children only: `{"card_type": "<name>"}` matches non-deleted
  children of the transitioning card whose card_type matches. (Future:
  multi-type lists, depth>1 walks.)

- **match** — quantifier over the scoped set:
  - `"all"` — every matched child satisfies `where`.
  - `"any"` — at least one does.
  - `"none"` — zero do.
  - Empty scope: `all` is vacuously true; `any` is false; `none` is
    vacuously true. Worth surfacing in the error message.
  - Future: `{"count": {"gte": N}}` and similar count expressions.

- **where** — predicate over attribute values, structured as
  `attribute_name → operator → operand`. v1 operators:
  - `eq` / `neq` — exact match.
  - `in` / `nin` — membership in a list.
  - `lt` / `lte` / `gt` / `gte` — for numeric/date attributes.
  - `set` / `unset` — presence check, no operand.
  - Compound: an object with multiple keys is an implicit AND
    (`{"result": {...}, "blocked_by": {"unset": true}}`).

This is an AST, not a free-form filter — the evaluator is a switch
over a fixed operator set. Validating at workflow_def save time
catches typos before they can block transitions.

## Evaluation

Pseudocode for the dispatcher's transition check, with the aggregate
step added:

```
on transition(parent, target_state):
    -- existing checks
    require workflow_transition(workflow_def_ref, current_state, target_state) exists
    for each gate G in effective_gates(parent):
        if target_state in G.required_in_states:
            require G.status in ('approved', 'n/a')

    -- new
    let g = workflow_transition(...).aggregate_guard
    if g is not null:
        require evaluate_aggregate(parent, g)
```

`evaluate_aggregate` is one SQL query joining `card` to
`attribute_value`, filtered by `parent_card_id` and `card_type`,
counting rows that match `where`, and comparing the count against
`match`.

Existing indexes (`idx_card_parent_card_id`,
`idx_card_card_type_id`) cover the read path. The query is bounded
by direct child count — small in practice. Worst-case scenarios
(thousands of children) need EXPLAIN ANALYZE before declaring victory,
but the shape is similar to today's gate query and shouldn't surprise.

## Walked example: test plan completion

The motivating case from the chat discussion:

```
workflow_def "Test Plan Lifecycle"
  states: draft, in_review, in_progress, approved, rejected
  transitions:
    in_progress → approved:
      gates required:        ["Results reviewed"]
      aggregate_guard: {
        "scope": {"card_type": "test_case"},
        "match": "all",
        "where": {"result": {"in": ["passed", "n/a"]}}
      }
```

When the test lead drags the test_plan card from `in_progress` to
`approved`:

1. State graph: `in_progress → approved` exists. ✓
2. Gate "Results reviewed": status is `approved`. ✓
3. Aggregate guard:
   ```sql
   SELECT count(*)
   FROM card c
   LEFT JOIN attribute_value av_result
     ON av_result.card_id = c.id AND av_result.attribute_def_id = $result_attr
   WHERE c.parent_card_id = $test_plan
     AND c.card_type_id   = $test_case
     AND c.deleted_at IS NULL
     AND COALESCE(av_result.value #>> '{}', '') NOT IN ('passed', 'n/a')
   ```
   If count = 0, pass. If count > 0, reject with
   `"3 of 7 test_cases not yet passed"`.

The error includes the count and the total so the user knows what's
left without opening every child.

## Other shapes worth supporting

Three more cases that fall out of the same expression language:

**No open blockers before `done`:**
```jsonc
{
  "scope": {"card_type": "task"},
  "match": "none",
  "where": {"is_blocking": {"eq": true}, "status": {"neq": "done"}}
}
```

**At least one sub-task started before `in_progress`:**
```jsonc
{
  "scope": {"card_type": "task"},
  "match": "any",
  "where": {"status": {"in": ["doing", "review", "done"]}}
}
```

**All sign-off cards approved before campaign launch** (overlaps with
gate guards but expressible as aggregate too — useful when the
sign-off type isn't a built-in `gate`):
```jsonc
{
  "scope": {"card_type": "approval"},
  "match": "all",
  "where": {"decision": {"eq": "approved"}}
}
```

## UI implications

1. **Workflow_def admin** — transition editor gains an "Aggregate
   guard" expandable section. v1 can ship as a JSON text area with a
   schema check on save; a visual builder is a follow-up. The
   currently-active workflow's guards render as a read-only summary
   on the transition's row in the matrix.

2. **Transition error rendering** — has to distinguish the three
   sources of failure:
   - "Not a legal transition" (state graph)
   - "Gate X is pending" (gate guard)
   - "Aggregate condition failed: 3 of 7 test_cases not yet passed"
     (aggregate guard, with count + total + readable predicate)

3. **Side panel diagnostics** — a "what's blocking me" view that
   evaluates every outgoing transition's guards and shows which would
   pass / fail. Cheap to compute (one extra read per transition);
   makes self-service debugging feasible.

## Migration order

1. **NN — `workflow_transition.aggregate_guard`** column.
2. **NN+1 — server changes.** Predicate evaluator + transition guard
   integration + structured error response.
3. **NN+2 — workflow_def save-time validation** of aggregate_guard
   shape (operator allowlist, attribute existence in the workflow's
   bound edges).
4. **NN+3 — client follow-ups.** Workflow admin guard editor (text
   first, builder later), error rendering, "what's blocking me" view.

A workflow_def with no `aggregate_guard` rows behaves exactly as
today. The feature is fully optional per-transition.

## Risk + open questions

- **Predicate validation.** A guard referencing an attribute the
  workflow doesn't bind via edges should be rejected at save time, not
  at first transition. The validator needs the workflow's effective
  edge set in scope.

- **Stale predicates after attribute rename.** If `result` is
  renamed, every guard referencing it breaks. Two mitigations:
  resolve attribute references by id (not name) inside the stored
  JSON; or run a one-shot rewriter in the rename migration. The first
  is more robust — the JSON should store `attribute_def_id` for
  durable references.

- **Performance worst-case.** A guard over 10k direct children would
  be slow. Direct-child-only scope keeps the worst case bounded by
  what's already a normal grid view query. If it becomes a problem,
  cache the aggregate result keyed by `(parent_card_id, transition)`
  and invalidate on child writes — same pattern as the existing
  attribute_value denorm.

- **Empty-scope semantics.** `all` over zero children is `true`
  (vacuous). This can mask bugs ("oh we never created any
  test_cases"). The error message should explicitly say "0 children
  of type test_case found; vacuously satisfied" so users notice the
  case. Or, future: a `min_count` on the scope to reject the empty
  case explicitly.

- **Interaction with shared gates.** Aggregate guards walk direct
  children only — they don't see inherited gate cards from
  WORKFLOW_SHARED_GATES_PLAN. That's intentional: shared gates have
  their own guard mechanism. Mixing the two would create circular
  reasoning ("guard says all gates approved" + "shared gate says
  approved depends on guards"). Direct-children-only avoids it.

- **Authoring UX.** JSON predicates are not friendly for non-engineer
  workflow authors. v1 ships text-editing only; expect to pair with
  documentation and example library. A small visual builder (similar
  to GitHub's branch protection rules) is the natural follow-up
  after the predicate language has stabilized.

- **Multiple guards per transition.** v1 supports one. The JSON-array
  AND form is a clean extension when needed; OR or arbitrary boolean
  composition is not in scope — write a different transition with a
  different precondition instead.

## Out of scope

- Predicates over indirect descendants (children of children). Use
  multiple cards-with-workflows in a chain, each with its own guards.
- Predicates over inherited gate cards (WORKFLOW_SHARED_GATES_PLAN
  territory). Shared gates have their own approve/reject semantics;
  aggregate guards don't compose with them.
- Time-based predicates ("all children created in the last week").
  Doable as a follow-up by adding `created_at` as a queryable axis;
  not urgent.
- Custom functions / extensibility hooks. The operator set is fixed
  and additions are migrations.
- Cross-card predicates that read non-descendant cards. Use card_ref
  attributes and shared gates instead.
- OR / NOT / arbitrary boolean composition. Multiple transitions with
  different preconditions covers most cases; nested booleans rarely
  earn their complexity.

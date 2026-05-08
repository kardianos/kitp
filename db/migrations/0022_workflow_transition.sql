-- 0022_workflow_transition.sql — state graph for workflow_def cards.
--
-- Background: WORKFLOW_HYBRID_PLAN.md "State and transitions" + Phase 2.
--
-- A workflow_def declares its state machine via rows in this table. Each
-- row is a directed edge from `from_state` to `to_state` for the
-- workflow keyed by its workflow_def_id (which references the
-- workflow_def card). An optional process_id fires the named process
-- when the transition succeeds.
--
-- This is a "real" SQL table rather than card-modeled because the
-- transition guard reads it on every status update — it earns its place
-- as a hot lookup.
--
-- Forward-only.

CREATE TABLE IF NOT EXISTS workflow_transition (
    workflow_def_id bigint NOT NULL REFERENCES card(id) ON DELETE CASCADE,
    from_state      text   NOT NULL,
    to_state        text   NOT NULL,
    process_id      int    REFERENCES process(id),
    aggregate_guard jsonb,
    PRIMARY KEY (workflow_def_id, from_state, to_state)
);

-- Most reads are "all transitions for this workflow_def" so the PK
-- prefix already covers them. No additional index required.

-- Note: aggregate_guard is added here (rather than in a separate
-- migration 0029) so that workflow authoring + Phase 5's evaluator
-- share the same column. Until Phase 5 ships the dispatcher ignores
-- the column.

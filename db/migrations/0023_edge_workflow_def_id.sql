-- 0023_edge_workflow_def_id.sql — scope edges by workflow_def.
--
-- Background: WORKFLOW_HYBRID_PLAN.md "Schema changes" + Phase 2.
--
-- An edge with workflow_def_id IS NULL is global within its
-- (card_type, project_type) scope. A non-null workflow_def_id narrows
-- the binding so the attribute is effective only on cards bound to that
-- workflow. The unique index expands to four columns with the COALESCE-0
-- null-as-wildcard convention.
--
-- Forward-only.

ALTER TABLE edge
    ADD COLUMN IF NOT EXISTS workflow_def_id bigint REFERENCES card(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS edge_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS edge_uniq
    ON edge (
        card_type_id,
        attribute_def_id,
        COALESCE(project_type_id, 0),
        COALESCE(workflow_def_id, 0)
    );

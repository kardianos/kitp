-- 0024_option_workflow_def_id.sql — scope enum options by workflow_def.
--
-- Background: WORKFLOW_HYBRID_PLAN.md "Schema changes" + Phase 2.
--
-- An attribute_def_option may now carry workflow_def_id alongside
-- project_type_id and project_card_id. The CHECK from 0020 still
-- applies (project_type_id and project_card_id are mutually exclusive).
-- workflow_def_id is independent — a status enum scoped to a particular
-- workflow_def can also carry a project_type_id for additional narrowing,
-- though in practice authors pick one axis at a time.
--
-- Forward-only.

ALTER TABLE attribute_def_option
    ADD COLUMN IF NOT EXISTS workflow_def_id bigint REFERENCES card(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS attribute_def_option_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS attribute_def_option_uniq
    ON attribute_def_option (
        attribute_def_id,
        value,
        COALESCE(project_type_id, 0),
        COALESCE(project_card_id, 0),
        COALESCE(workflow_def_id, 0)
    );

DROP INDEX IF EXISTS idx_attribute_def_option_def_ordering;
CREATE INDEX IF NOT EXISTS idx_attribute_def_option_def_ordering
    ON attribute_def_option (
        attribute_def_id, project_type_id, project_card_id, workflow_def_id, ordering
    );

-- 0019_edge_project_type_id.sql — scope edges by project_type.
--
-- Background: PROJECT_SCOPED_SCHEMA_PLAN.md "Edge scoping". An edge with
-- project_type_id IS NULL is global (today's behaviour). An edge with
-- project_type_id = X applies only on cards whose enclosing project's
-- project_type matches X.
--
-- The unique constraint expands to (card_type_id, attribute_def_id,
-- COALESCE(project_type_id, 0)) so the global edge and any number of
-- project-type-scoped edges can coexist for the same (card_type, def)
-- pair. Index drops are guarded for re-runs.
--
-- Forward-only.

ALTER TABLE edge
    ADD COLUMN IF NOT EXISTS project_type_id int REFERENCES project_type(id);

-- Drop the legacy 2-column uniqueness so we can re-establish it with
-- project_type_id participating. The constraint name is the default
-- pgx-generated one from migration 0001 (edge_card_type_id_attribute_def_id_key).
ALTER TABLE edge
    DROP CONSTRAINT IF EXISTS edge_card_type_id_attribute_def_id_key;
ALTER TABLE edge
    DROP CONSTRAINT IF EXISTS edge_uniq;

-- Use a unique index instead of UNIQUE(...) on COALESCE(...) because
-- the latter isn't directly supported as a table constraint on every
-- Postgres version. This expression covers the same ground.
CREATE UNIQUE INDEX IF NOT EXISTS edge_uniq
    ON edge (card_type_id, attribute_def_id, COALESCE(project_type_id, 0));

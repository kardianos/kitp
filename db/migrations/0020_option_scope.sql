-- 0020_option_scope.sql — scope enum options by project_type or by project.
--
-- Background: PROJECT_SCOPED_SCHEMA_PLAN.md "Attribute value scoping" +
-- the IMPL plan's Phase 1 extension. The original proposal scoped options
-- by project_type only; this migration also adds project_card_id so an
-- enum option can be narrow to a single project (e.g. project-specific
-- statuses for one team without publishing them globally).
--
-- Resolution rule (server-side):
--   global option        — both columns NULL
--   project_type option  — project_type_id set, project_card_id NULL
--   project option       — project_card_id set, project_type_id NULL
--
-- An option must declare at most one scope. The CHECK enforces it.
--
-- The natural key changes from (attribute_def_id, value) to
-- (attribute_def_id, value, project_type_id, project_card_id) because the
-- same value string ('high') may carry different labels under different
-- scopes. Postgres treats NULLs as distinct in a UNIQUE constraint, so
-- the COALESCE form encodes "treat NULL as the same scope" properly.
--
-- Forward-only and idempotent.

ALTER TABLE attribute_def_option
    ADD COLUMN IF NOT EXISTS project_type_id int    REFERENCES project_type(id),
    ADD COLUMN IF NOT EXISTS project_card_id bigint REFERENCES card(id);

ALTER TABLE attribute_def_option
    DROP CONSTRAINT IF EXISTS ado_scope_exclusive;
ALTER TABLE attribute_def_option
    ADD  CONSTRAINT ado_scope_exclusive
         CHECK (project_type_id IS NULL OR project_card_id IS NULL);

-- Replace the natural key. The previous PRIMARY KEY was
-- (attribute_def_id, value) — see migration 0012.
ALTER TABLE attribute_def_option
    DROP CONSTRAINT IF EXISTS attribute_def_option_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS attribute_def_option_uniq
    ON attribute_def_option (
        attribute_def_id,
        value,
        COALESCE(project_type_id, 0),
        COALESCE(project_card_id, 0)
    );

-- The ordering index from 0012 is still useful but we re-create it to
-- include the scope columns so the resolver can use index-only scans.
DROP INDEX IF EXISTS idx_attribute_def_option_def_ordering;
CREATE INDEX IF NOT EXISTS idx_attribute_def_option_def_ordering
    ON attribute_def_option (attribute_def_id, project_type_id, project_card_id, ordering);

-- 0017_project_type.sql — introduce project_type as the schema-customization unit.
--
-- Background: docs/PROJECT_SCOPED_SCHEMA_PLAN.md and
-- docs/IMPL_PLAN_SCOPED_WORKFLOW.md (Phase 1).
--
-- Project types group projects that share a schema. "Bugs", "Roadmap",
-- "Marketing campaigns" are project types. Two roadmap projects share
-- the same edges/options; a roadmap and a bug tracker do not.
--
-- This migration only creates the table and seeds a default row. The
-- project_type_id columns on card / edge / attribute_def_option arrive
-- in 0018-0020. Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS project_type (
    id          serial  PRIMARY KEY,
    name        text    NOT NULL UNIQUE,
    doc         text,
    is_built_in boolean NOT NULL DEFAULT false,
    is_default  boolean NOT NULL DEFAULT false
);

-- Exactly one row may carry is_default = true. The partial unique index
-- enforces it without preventing the (much more common) case of every
-- non-default row having is_default = false.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_type_default
    ON project_type (is_default)
    WHERE is_default = true;

-- Seed the catch-all "default" project_type. Existing projects (and any
-- created without an explicit type) backfill to this row in 0018.
INSERT INTO project_type (name, doc, is_built_in, is_default)
VALUES ('default',
        'Catch-all type for projects that do not declare a custom schema.',
        true, true)
ON CONFLICT (name) DO NOTHING;

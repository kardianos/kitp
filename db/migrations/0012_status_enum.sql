-- 0012_status_enum.sql — promote the built-in `status` attribute_def to an
-- enum-typed attribute and seed its allowed options.
--
-- Background: §6 of SVELTE_MIGRATION_PLAN.md (and §5.9) calls for moving
-- the hardcoded ['todo','doing','review','done'] list out of every screen
-- and onto the server. We do that with a small, additive change:
--
--   1. A new attribute_def_option table holds (def_id, value, label,
--      ordering) tuples. It's the single source of truth for any future
--      enum-typed attribute_def — not just status.
--   2. The existing 'status' attribute_def gets value_type = 'enum'
--      (was 'text') and four option rows in the canonical kanban order.
--
-- Forward-only / non-destructive:
--  - existing attribute_value rows for status (jsonb 'todo' | 'doing' | …)
--    stay valid — the value column is still jsonb and the option values
--    match what 0007_dense_demo and the seeds wrote.
--  - the UPDATE to value_type='enum' is gated on the current value being
--    'text', so re-runs and out-of-band manual fixes both no-op safely.
--  - INSERTs use ON CONFLICT DO NOTHING so the migration is idempotent.

-- 1. The options table. One row per (def, value).
CREATE TABLE IF NOT EXISTS attribute_def_option (
    attribute_def_id    int  NOT NULL REFERENCES attribute_def(id) ON DELETE CASCADE,
    value               text NOT NULL,
    label               text NOT NULL,
    ordering            int  NOT NULL DEFAULT 0,
    PRIMARY KEY (attribute_def_id, value)
);

CREATE INDEX IF NOT EXISTS idx_attribute_def_option_def_ordering
    ON attribute_def_option (attribute_def_id, ordering);

-- 2. Seed the four canonical status options. The label mirrors the value
--    today; the admin UI (T5 enum-options editor) can edit labels later
--    without touching the underlying jsonb stored on cards.
INSERT INTO attribute_def_option (attribute_def_id, value, label, ordering)
SELECT ad.id, v.value, v.label, v.ordering
FROM attribute_def ad
CROSS JOIN (VALUES
    ('todo',   'Todo',   0),
    ('doing',  'Doing',  1),
    ('review', 'Review', 2),
    ('done',   'Done',   3)
) AS v(value, label, ordering)
WHERE ad.name = 'status'
ON CONFLICT (attribute_def_id, value) DO NOTHING;

-- 3. Promote status from 'text' to 'enum'. Guarded so re-runs are no-ops
--    and any hand-edited value_type (e.g. a future 'enum_multi') is left
--    alone.
UPDATE attribute_def
   SET value_type = 'enum'
 WHERE name = 'status' AND value_type = 'text';

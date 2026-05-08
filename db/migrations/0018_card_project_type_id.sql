-- 0018_card_project_type_id.sql — attach project_type_id to project cards.
--
-- Background: see 0017_project_type.sql + IMPL_PLAN_SCOPED_WORKFLOW Phase 1.
--
-- Only project cards (card_type='project') need an explicit
-- project_type_id. Descendant cards derive their effective project_type
-- by walking parent_card_id up to the enclosing project at read time
-- (see server/internal/dom/card/select_attrs.go). We don't denormalize
-- the value onto every card — projects rarely change type, and one extra
-- join in the resolver is the right cost.
--
-- Forward-only and idempotent.

ALTER TABLE card
    ADD COLUMN IF NOT EXISTS project_type_id int REFERENCES project_type(id);

-- Backfill: every existing project gets the default project_type. This
-- is the only state where existing rows would otherwise carry a NULL
-- project_type_id and trip later resolver expectations. Non-project
-- rows stay NULL — the resolver doesn't read them anyway.
UPDATE card
   SET project_type_id = (SELECT id FROM project_type WHERE is_default)
 WHERE card_type_id = (SELECT id FROM card_type WHERE name = 'project')
   AND project_type_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_card_project_type_id
    ON card (project_type_id)
    WHERE project_type_id IS NOT NULL;

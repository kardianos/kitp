-- 0021_workflow_def.sql — workflow_def card_type + workflow_def_ref
-- attribute + the card.classify process.
--
-- Background: WORKFLOW_HYBRID_PLAN.md + IMPL_PLAN_SCOPED_WORKFLOW Phase 2.
--
-- workflow_def is itself a card_type. A workflow_def card lives under a
-- project (or under a project_type-scoped admin screen) and declares a
-- finite state machine via the companion workflow_transition table
-- (migration 0022). Cards bind to a workflow_def via the
-- workflow_def_ref attribute, set by the card.classify process.
--
-- Forward-only and idempotent.

INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
SELECT 'workflow_def', id, false, true FROM card_type WHERE name = 'project'
ON CONFLICT (name) DO NOTHING;

INSERT INTO attribute_def (name, value_type, is_built_in) VALUES
    ('workflow_def_ref', 'card_ref', true),
    -- states is a JSON array of strings stored as text. Authors edit it
    -- as a comma-separated list in the UI; the server validates it on
    -- save.
    ('states',           'text',     true),
    ('initial_state',    'text',     true)
ON CONFLICT (name) DO NOTHING;

-- workflow_def cards carry states and initial_state.
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, true, 1
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'workflow_def' AND ad.name = 'states'
ON CONFLICT (card_type_id, attribute_def_id, COALESCE(project_type_id, 0)) DO NOTHING;

INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, true, 2
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'workflow_def' AND ad.name = 'initial_state'
ON CONFLICT (card_type_id, attribute_def_id, COALESCE(project_type_id, 0)) DO NOTHING;

-- The title attribute is required on every card_type; mirror the seed in
-- migration 0002 for workflow_def. Insert global edges (project_type_id
-- IS NULL).
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, true, 0
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'workflow_def' AND ad.name = 'title'
ON CONFLICT (card_type_id, attribute_def_id, COALESCE(project_type_id, 0)) DO NOTHING;

-- The workflow_def_ref attribute is allowed (not required) on task and on
-- any card_type that may be classified. We start with task; new card_types
-- that join later (issue, gate, test_plan) get their own edge rows in
-- their respective migrations.
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 5
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'task' AND ad.name = 'workflow_def_ref'
ON CONFLICT (card_type_id, attribute_def_id, COALESCE(project_type_id, 0)) DO NOTHING;

-- The classify process: composes attribute.update steps that set
-- workflow_def_ref + status to the workflow's initial state. Phase 3
-- adds gate.spawn as ordinal=2 in the same process.
INSERT INTO process (name) VALUES ('card.classify')
ON CONFLICT (name) DO NOTHING;

INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 1, 'attribute', 'update' FROM process p WHERE p.name = 'card.classify'
ON CONFLICT (process_id, ordinal) DO NOTHING;

-- System role gets the new process; matches the pattern in 0013.
INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'system' AND p.name = 'card.classify'
ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;

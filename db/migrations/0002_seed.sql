-- 0002_seed.sql — built-in seed rows (System User, card types, attributes, edges)
-- Idempotent on re-run via ON CONFLICT.

INSERT INTO user_account (id, oidc_sub, display_name)
VALUES (1, NULL, 'System')
ON CONFLICT (id) DO NOTHING;
SELECT setval('user_account_id_seq', GREATEST((SELECT MAX(id) FROM user_account), 1));

-- Built-in card types: project (top-level), task (parented to project, self-parent ok),
-- milestone, component, tag (all parented to project), comment_body (parentless storage row).
INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
VALUES ('project', NULL, false, true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
SELECT 'task', id, true, true FROM card_type WHERE name = 'project'
ON CONFLICT (name) DO NOTHING;

INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
SELECT 'milestone', id, false, true FROM card_type WHERE name = 'project'
ON CONFLICT (name) DO NOTHING;

INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
SELECT 'component', id, false, true FROM card_type WHERE name = 'project'
ON CONFLICT (name) DO NOTHING;

INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
SELECT 'tag', id, false, true FROM card_type WHERE name = 'project'
ON CONFLICT (name) DO NOTHING;

INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
VALUES ('comment_body', NULL, false, true)
ON CONFLICT (name) DO NOTHING;

-- Built-in attribute defs.
INSERT INTO attribute_def (name, value_type, is_built_in) VALUES
    ('title',           'text',     true),
    ('status',          'text',     true),
    ('assignee',        'user_ref', true),
    ('milestone_ref',   'card_ref', true),
    ('component_ref',   'card_ref', true)
ON CONFLICT (name) DO NOTHING;

-- Built-in edges:
--  - title required on every card type
--  - status, assignee, milestone_ref, component_ref allowed on task only
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, true, 0
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ad.name = 'title'
  AND ct.name IN ('project','task','milestone','component','tag')
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 1
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'task'
  AND ad.name IN ('status','assignee','milestone_ref','component_ref')
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

-- Built-in role; System User holds it.
INSERT INTO role (name) VALUES ('system') ON CONFLICT (name) DO NOTHING;

INSERT INTO user_role (user_id, role_id, scope_card_id)
SELECT 1, r.id, NULL FROM role r WHERE r.name = 'system'
ON CONFLICT DO NOTHING;

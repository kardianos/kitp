-- 0003_tag_attrs.sql — tag-related attribute_defs and edges (Phase 10).
-- Idempotent on re-run via ON CONFLICT.

-- New built-in attribute defs:
--   path                — slash-delimited path on a tag card (e.g. priority/high)
--   root_exclusive_at   — path prefix at which the tag is mutually exclusive
--                         with other tags sharing the same prefix (e.g. priority)
--   tags                — jsonb array of tag card ids attached to a card
INSERT INTO attribute_def (name, value_type, is_built_in) VALUES
    ('path',              'text',      true),
    ('root_exclusive_at', 'text',      true),
    ('tags',              'card_ref[]', true)
ON CONFLICT (name) DO NOTHING;

-- Edges:
--  - tag has 'path' required.
--  - tag has 'root_exclusive_at' allowed (optional).
--  - task / project / milestone / component have 'tags' allowed.
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, true, 2
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'tag' AND ad.name = 'path'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 3
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name = 'tag' AND ad.name = 'root_exclusive_at'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 4
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name IN ('project','task','milestone','component') AND ad.name = 'tags'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

-- Built-in processes for phase 11.
INSERT INTO process (name) VALUES
    ('card.create'),
    ('card.update'),
    ('card.delete'),
    ('comment.post'),
    ('task.update_with_comment')
ON CONFLICT (name) DO NOTHING;

-- Process steps. The (process_id, ordinal) pair is the PK; we INSERT ... SELECT
-- against process to avoid hard-coded ids and use ON CONFLICT to stay idempotent.
INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 1, 'card', 'insert' FROM process p WHERE p.name = 'card.create'
ON CONFLICT (process_id, ordinal) DO NOTHING;

INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 1, 'attribute', 'update' FROM process p WHERE p.name = 'card.update'
ON CONFLICT (process_id, ordinal) DO NOTHING;

INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 1, 'card', 'delete' FROM process p WHERE p.name = 'card.delete'
ON CONFLICT (process_id, ordinal) DO NOTHING;

INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 1, 'comment', 'insert' FROM process p WHERE p.name = 'comment.post'
ON CONFLICT (process_id, ordinal) DO NOTHING;

-- task.update_with_comment is the demo compositional process: update some
-- attribute(s) and then leave a comment, all in one tx.
INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 1, 'attribute', 'update' FROM process p WHERE p.name = 'task.update_with_comment'
ON CONFLICT (process_id, ordinal) DO NOTHING;

INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 2, 'comment', 'insert' FROM process p WHERE p.name = 'task.update_with_comment'
ON CONFLICT (process_id, ordinal) DO NOTHING;

-- System role gets every grant against every card_type so dev mode can
-- exercise everything without OIDC. role_grant PK is (role_id, card_type_id, process_id).
INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'system'
ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;

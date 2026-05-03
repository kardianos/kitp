-- 0011_attribute_admin.sql — register the 'is_active' attribute used by the
-- attribute admin screen (T5). The attribute is a boolean defaulting to true
-- (absent value == active); pickers filter is_active=true, renderers ignore
-- the flag. Bound to milestone, component, and tag — the three ref-style
-- value card types that today populate user-facing pickers.
--
-- Idempotent on re-run via ON CONFLICT.

INSERT INTO attribute_def (name, value_type, is_built_in) VALUES
    ('is_active', 'bool', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 5
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ct.name IN ('milestone','component','tag') AND ad.name = 'is_active'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

-- area_present — whether a project already has an area (docs/AREAS.md),
-- whatever its switch says:
--   - it used one of the area's starting points (a card_origin row), or
--   - it holds the area's items, one or two levels below the project (a
--     task / page / channel, and a comm / approval / link on a task), or
--   - it has its own status flow for one of the area's item types (a flow
--     scoped to the project whose attribute is bound to such a type).
-- The last case is a project set up some other way: copied from a template,
-- or created before areas existed. It has the area's statuses and screens
-- without any items yet, so it has the area: it reads 'on', and switching
-- the area on adds no starting point (one would duplicate the flow, which
-- bundle_apply refuses). The same flow test claims a project's screens for
-- an area in area.list.
CREATE OR REPLACE FUNCTION area_present(project_id bigint, key text)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM card_origin o
                   WHERE o.project_id = area_present.project_id AND a.starts ? o.bundle_key)
        OR EXISTS (SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id
                   WHERE c.parent_card_id = area_present.project_id AND c.deleted_at IS NULL
                     AND a.card_types ? ct.name)
        OR EXISTS (SELECT 1 FROM card t
                   JOIN card c ON c.parent_card_id = t.id AND c.deleted_at IS NULL
                   JOIN card_type ct ON ct.id = c.card_type_id
                   WHERE t.parent_card_id = area_present.project_id AND t.deleted_at IS NULL
                     AND a.card_types ? ct.name)
        OR EXISTS (SELECT 1 FROM flow f
                   JOIN edge e ON e.attribute_def_id = f.attribute_def_id
                   JOIN card_type ect ON ect.id = e.card_type_id
                   WHERE f.scope_card_id = area_present.project_id
                     AND a.card_types ? ect.name)
    FROM area a
    WHERE a.key = area_present.key
$$;

-- area_state — one area's state in one project (project_id 0 = the
-- workspace, for a workspace-scoped area):
--   'off'    an explicit project_area / workspace_area row says off;
--   'on'     an explicit row says on, or (no row) the project holds the
--            area's items or has applied one of its starting points;
--   'unused' no row and nothing of the area in the project yet.
-- A workspace area with no row is 'on'. Items are looked for one and two
-- levels below the project (a task / page / channel, and a comm /
-- approval / link on a task), which is where every area's items live.
CREATE OR REPLACE FUNCTION area_state(project_id bigint, key text)
RETURNS text LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN a.key IS NULL THEN 'unused'
        WHEN a.scope = 'workspace' THEN
            COALESCE((SELECT w.state FROM workspace_area w WHERE w.area_key = a.key), 'on')
        WHEN EXISTS (SELECT 1 FROM project_area pa
                     WHERE pa.project_id = area_state.project_id AND pa.area_key = a.key) THEN
            (SELECT pa.state FROM project_area pa
             WHERE pa.project_id = area_state.project_id AND pa.area_key = a.key)
        WHEN EXISTS (SELECT 1 FROM card_origin o
                     WHERE o.project_id = area_state.project_id AND a.starts ? o.bundle_key)
          OR EXISTS (SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id
                     WHERE c.parent_card_id = area_state.project_id AND c.deleted_at IS NULL
                       AND a.card_types ? ct.name)
          OR EXISTS (SELECT 1 FROM card t
                     JOIN card c ON c.parent_card_id = t.id AND c.deleted_at IS NULL
                     JOIN card_type ct ON ct.id = c.card_type_id
                     WHERE t.parent_card_id = area_state.project_id AND t.deleted_at IS NULL
                       AND a.card_types ? ct.name) THEN 'on'
        ELSE 'unused'
    END
    FROM (SELECT 1) one
    LEFT JOIN area a ON a.key = area_state.key
$$;

-- area_state — one area's state in one project (project_id 0 = the
-- workspace, for a workspace-scoped area):
--   'off'    an explicit project_area / workspace_area row says off;
--   'on'     an explicit row says on, or (no row) the project already has
--            the area (area_present: a starting point it used, the area's
--            items, or its own status flow for them);
--   'unused' no row and nothing of the area in the project yet.
-- A workspace area with no row is 'on'.
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
        WHEN area_present(area_state.project_id, a.key) THEN 'on'
        ELSE 'unused'
    END
    FROM (SELECT 1) one
    LEFT JOIN area a ON a.key = area_state.key
$$;

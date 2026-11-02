-- area.list handler — the areas a project is split into (docs/AREAS.md),
-- each with its state, for the project's Areas settings, the sidebar and
-- the detail view; or, without a project, the whole catalog: every
-- project area (state 'unused': the new-project dialog's list) and the
-- workspace areas with their state (Sites).
--
-- Input:  {"project_id"?}
-- Result: {"areas": [{
--   "key", "title", "doc", "scope", "sort",
--   "state": "on" | "off" | "unused"   (area_state),
--   "depends_on": [key…],
--   "starts": [{"key", "title"}…]      starting points, default first,
--   "added": [key…]                    starting points this project used,
--   "screens": ["<screen id>"…]        this project's screens of the area
--                                      (by the item type their flow drives),
--   "items": n | null                  how many items it holds — admins only
-- }…]} by sort; a project's areas, or (no project) every area.
--
-- Visibility: a project's areas need a role that sees the project.
CREATE OR REPLACE FUNCTION area_list_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (
    idx int,
    ok boolean,
    code text,
    message text,
    result jsonb
) LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _project bigint;
    _admin boolean;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _project := COALESCE(NULLIF(_raw->>'project_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'area.list: project_id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END;
        IF _project <> 0 AND NOT (
            EXISTS (SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
                    WHERE c.id = _project AND c.deleted_at IS NULL)
            AND user_sees_project(area_list_batch.actor_id, _project)) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                'area.list: project not found'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT EXISTS (
            SELECT 1 FROM user_role_effective(area_list_batch.actor_id) ur JOIN role r ON r.id = ur.role_id AND r.name = 'admin'
            WHERE ur.user_id = area_list_batch.actor_id
              AND (ur.scope_card_id IS NULL OR ur.scope_card_id = _project)
        ) INTO _admin;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('areas', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'key', a.key,
                    'title', a.title,
                    'doc', a.doc,
                    'scope', a.scope,
                    'sort', a.sort_order,
                    'state', area_state(_project, a.key),
                    -- The last switch, when there is one: what, when, who
                    -- (the workspace's Sites has no card to carry an
                    -- activity row, so this is its record; review A22).
                    'switched', CASE WHEN a.scope = 'workspace' THEN
                        (SELECT jsonb_build_object('state', w.state, 'at', w.changed_at,
                                                   'by', COALESCE(user_label(w.changed_by), ''))
                         FROM workspace_area w WHERE w.area_key = a.key)
                      ELSE
                        (SELECT jsonb_build_object('state', pa.state, 'at', pa.changed_at,
                                                   'by', COALESCE(user_label(pa.changed_by), ''))
                         FROM project_area pa WHERE pa.project_id = _project AND pa.area_key = a.key)
                    END,
                    'depends_on', a.depends_on,
                    'starts', COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('key', s.key, 'title', COALESCE(b.title, s.key)) ORDER BY s.ord)
                        FROM jsonb_array_elements_text(a.starts) WITH ORDINALITY AS s(key, ord)
                        LEFT JOIN bundle b ON b.key = s.key
                    ), '[]'::jsonb),
                    'added', COALESCE((
                        SELECT jsonb_agg(DISTINCT o.bundle_key)
                        FROM card_origin o
                        WHERE o.project_id = _project AND a.starts ? o.bundle_key
                    ), '[]'::jsonb),
                    'screens', COALESCE((
                        SELECT jsonb_agg(sc.id::text ORDER BY sc.id)
                        FROM card sc
                        JOIN card_type sct ON sct.id = sc.card_type_id AND sct.name = 'screen'
                        JOIN attribute_value fv ON fv.card_id = sc.id
                        JOIN attribute_def fd ON fd.id = fv.attribute_def_id AND fd.name = 'flow_ref'
                        JOIN flow f ON f.id = CASE
                                                WHEN jsonb_typeof(fv.value) = 'number' THEN (fv.value)::text::bigint
                                                WHEN (fv.value #>> '{}') ~ '^\d+$' THEN (fv.value #>> '{}')::bigint
                                              END
                        WHERE sc.parent_card_id = _project AND sc.deleted_at IS NULL
                          AND EXISTS (SELECT 1 FROM edge e JOIN card_type ect ON ect.id = e.card_type_id
                                      WHERE e.attribute_def_id = f.attribute_def_id AND a.card_types ? ect.name)
                    ), '[]'::jsonb),
                    'items', CASE WHEN _admin AND _project <> 0 THEN (
                        (SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id
                         WHERE c.parent_card_id = _project AND c.deleted_at IS NULL AND a.card_types ? ct.name)
                      + (SELECT count(*) FROM card t
                         JOIN card c ON c.parent_card_id = t.id AND c.deleted_at IS NULL
                         JOIN card_type ct ON ct.id = c.card_type_id
                         WHERE t.parent_card_id = _project AND t.deleted_at IS NULL AND a.card_types ? ct.name)
                    ) END
                ) ORDER BY a.sort_order, a.key)
                FROM area a
                WHERE _project = 0 OR a.scope = 'project'
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

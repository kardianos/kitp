-- portal.list handler — every live portal with its configuration and
-- build state, for the Portals admin screen.
--
-- Input:  {}
-- Result: {"rows": [{
--   "id", "title", "host", "public",
--   "root_page_id", "root_title", "root_project_id",
--   "statuses":   ["Docs › In review", …]   statuses whose publishes_to names it
--   "page_count", "built_at", "active_build_id", "warnings": [...],
--   "dirty": bool (a rebuild is pending), "last_error"
-- }, …]}
--
-- Visibility: a caller with a global role sees every portal; anyone else
-- sees the portals whose root page they can see (card_visible_to).
CREATE OR REPLACE FUNCTION portal_list_batch(
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
    _global boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM user_account caller
        JOIN user_role ur
          ON ur.user_id = caller.id
          OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
        WHERE caller.id = portal_list_batch.actor_id AND ur.scope_card_id IS NULL
    ) INTO _global;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', p.id::text,
                    'title', COALESCE(a.title, ''),
                    'host', COALESCE(a.host, ''),
                    'public', COALESCE(a.public, false),
                    'root_page_id', COALESCE(a.root, 0)::text,
                    'root_title', COALESCE(rt.value #>> '{}', ''),
                    'root_project_id', COALESCE(card_enclosing_project(a.root), 0)::text,
                    'statuses', COALESCE(st.names, '[]'::jsonb),
                    'page_count', COALESCE(b.page_count, 0),
                    'built_at', CASE WHEN ps.built_at IS NULL THEN ''
                                     ELSE to_char(ps.built_at AT TIME ZONE 'UTC',
                                                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
                    'active_build_id', COALESCE(ps.active_build_id, 0)::text,
                    'warnings', COALESCE(b.warnings, '[]'::jsonb),
                    'dirty', ps.dirty_since IS NOT NULL,
                    'last_error', COALESCE(ps.last_error, '')
                ) ORDER BY lower(COALESCE(a.title, '')), p.id)
                FROM card p
                JOIN card_type pct ON pct.id = p.card_type_id AND pct.name = 'portal'
                LEFT JOIN LATERAL (
                    SELECT
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'title') AS title,
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'portal_host') AS host,
                        bool_or(av.value = to_jsonb(true)) FILTER (WHERE ad.name = 'portal_public') AS public,
                        max(CASE WHEN ad.name = 'portal_root' AND jsonb_typeof(av.value) = 'number'
                                 THEN (av.value)::text::bigint
                                 WHEN ad.name = 'portal_root' AND jsonb_typeof(av.value) = 'string'
                                      AND (av.value #>> '{}') ~ '^\d+$'
                                 THEN (av.value #>> '{}')::bigint END) AS root
                    FROM attribute_value av
                    JOIN attribute_def ad ON ad.id = av.attribute_def_id
                    WHERE av.card_id = p.id
                ) a ON true
                LEFT JOIN attribute_value rt
                  ON rt.card_id = a.root
                 AND rt.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'title')
                LEFT JOIN portal_state ps ON ps.portal_id = p.id
                LEFT JOIN portal_build b ON b.id = ps.active_build_id
                LEFT JOIN LATERAL (
                    SELECT jsonb_agg(
                               COALESCE(pt.value #>> '{}', '?') || ' › ' || COALESCE(stt.value #>> '{}', '?')
                               ORDER BY pt.value #>> '{}', s.id) AS names
                    FROM attribute_value pv
                    JOIN attribute_def pd ON pd.id = pv.attribute_def_id AND pd.name = 'publishes_to'
                    JOIN card s ON s.id = pv.card_id AND s.deleted_at IS NULL
                    LEFT JOIN attribute_value stt
                      ON stt.card_id = s.id
                     AND stt.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'title')
                    LEFT JOIN attribute_value pt
                      ON pt.card_id = s.parent_card_id
                     AND pt.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'title')
                    WHERE jsonb_typeof(pv.value) = 'array'
                      AND (pv.value @> jsonb_build_array(p.id::text)
                           OR pv.value @> jsonb_build_array(p.id))
                ) st ON true
                WHERE p.deleted_at IS NULL
                  AND (_global OR (a.root IS NOT NULL AND card_visible_to(actor_id, a.root)))
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

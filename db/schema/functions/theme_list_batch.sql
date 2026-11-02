-- theme.list handler — every live theme with its settings, the files it
-- adds or overrides, and the portals using it, for the Themes admin screen
-- and the Portals screen's theme picker.
--
-- Input:  {}
-- Result: {"rows": [{
--   "id", "title", "base", "nav", "accent", "footer",
--   "files":   [{"path", "mime_type", "size_bytes", "updated_at"}, …] by path,
--   "portals": ["Docs (PROD)", …]   live portals using the theme, by title
-- }, …]} by title
--
-- Authz: admin only (the dispatcher's AllowedRoles).
CREATE OR REPLACE FUNCTION theme_list_batch(
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
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', t.id::text,
                    'title', COALESCE(a.title, ''),
                    'base', COALESCE(a.base, ''),
                    'nav', COALESCE(a.nav, ''),
                    'accent', COALESCE(a.accent, ''),
                    'footer', COALESCE(a.footer, ''),
                    'files', COALESCE(f.files, '[]'::jsonb),
                    'portals', COALESCE(pu.titles, '[]'::jsonb)
                ) ORDER BY lower(COALESCE(a.title, '')), t.id)
                FROM card t
                JOIN card_type tct ON tct.id = t.card_type_id AND tct.name = 'theme'
                LEFT JOIN LATERAL (
                    SELECT
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'title') AS title,
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'theme_base') AS base,
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'theme_nav') AS nav,
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'theme_accent') AS accent,
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'theme_footer') AS footer
                    FROM attribute_value av
                    JOIN attribute_def ad ON ad.id = av.attribute_def_id
                    WHERE av.card_id = t.id
                ) a ON true
                LEFT JOIN LATERAL (
                    SELECT jsonb_agg(jsonb_build_object(
                               'path', tf.path,
                               'mime_type', tf.mime_type,
                               'size_bytes', tf.size_bytes,
                               'updated_at', to_char(tf.updated_at AT TIME ZONE 'UTC',
                                                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                           ) ORDER BY tf.path) AS files
                    FROM theme_file tf
                    WHERE tf.theme_id = t.id
                ) f ON true
                LEFT JOIN LATERAL (
                    SELECT jsonb_agg(COALESCE(pt.value #>> '{}', '') ORDER BY lower(COALESCE(pt.value #>> '{}', '')), p.id) AS titles
                    FROM card p
                    JOIN card_type pct ON pct.id = p.card_type_id AND pct.name = 'portal'
                    JOIN attribute_value pv ON pv.card_id = p.id
                    JOIN attribute_def pd ON pd.id = pv.attribute_def_id AND pd.name = 'portal_theme'
                    LEFT JOIN attribute_value pt
                      ON pt.card_id = p.id
                     AND pt.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'title')
                    WHERE p.deleted_at IS NULL
                      AND (pv.value = to_jsonb(t.id) OR pv.value = to_jsonb(t.id::text))
                ) pu ON true
                WHERE t.deleted_at IS NULL
                  AND NOT workspace_area_off('sites')
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

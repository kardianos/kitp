-- page.publications handler — where one page is live: a row per portal
-- that holds a snapshot of it.
--
-- Input:  {"page_id": "<id>"}
-- Result: {"rows": [{
--   "portal_id", "portal_title", "host", "public",
--   "published_at", "published_by",
--   "current": bool  — the snapshot still matches the page (title, body,
--                       slug, order, parent); false = the page has edits
--                       that portal doesn't show yet,
--   "path":    the page's path in the portal's ACTIVE build ('' = not
--              built yet, e.g. the build is pending or the page isn't
--              reachable from the portal's root)
-- }, …]}
--
-- Visibility: the page's (DI-6). An invisible page lists nothing.
CREATE OR REPLACE FUNCTION page_publications_batch(
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
    _page bigint;
    _title text;
    _slug text;
    _sort double precision;
    _body text;
    _parent bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _page := COALESCE(NULLIF(_raw->>'page_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _page := 0;
        END;
        IF _page = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'page.publications: page_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT card_visible_to(actor_id, _page) THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('rows', '[]'::jsonb);
            CONTINUE;
        END IF;

        SELECT c.parent_card_id,
               COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'title'), ''),
               COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'slug'), ''),
               COALESCE(max(CASE WHEN ad.name = 'sort_order' AND jsonb_typeof(av.value) = 'number'
                                 THEN (av.value)::text::double precision END), 0),
               COALESCE(max(av.value #>> '{}') FILTER (WHERE ad.name = 'description'), '')
          INTO _parent, _title, _slug, _sort, _body
        FROM card c
        LEFT JOIN attribute_value av ON av.card_id = c.id
        LEFT JOIN attribute_def ad ON ad.id = av.attribute_def_id
        WHERE c.id = _page
        GROUP BY c.parent_card_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'portal_id', pub.portal_id::text,
                    'portal_title', COALESCE(pa.title, ''),
                    'host', COALESCE(pa.host, ''),
                    'public', COALESCE(pa.public, false),
                    'published_at', to_char(pub.published_at AT TIME ZONE 'UTC',
                                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                    'published_by', COALESCE(user_label(pub.published_by), ''),
                    'current', pub.title = _title AND pub.body = _body AND pub.slug = _slug
                               AND pub.sort_order = _sort
                               AND pub.parent_card_id IS NOT DISTINCT FROM _parent,
                    'path', COALESCE(f.path, '')
                ) ORDER BY lower(COALESCE(pa.title, '')), pub.portal_id)
                FROM publication pub
                JOIN card pc ON pc.id = pub.portal_id AND pc.deleted_at IS NULL
                LEFT JOIN LATERAL (
                    SELECT
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'title') AS title,
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'portal_host') AS host,
                        bool_or(av.value = to_jsonb(true)) FILTER (WHERE ad.name = 'portal_public') AS public
                    FROM attribute_value av
                    JOIN attribute_def ad ON ad.id = av.attribute_def_id
                    WHERE av.card_id = pub.portal_id
                ) pa ON true
                LEFT JOIN portal_state ps ON ps.portal_id = pub.portal_id
                LEFT JOIN portal_build_file f
                  ON f.build_id = ps.active_build_id AND f.card_id = _page
                WHERE pub.card_id = _page
                  AND NOT workspace_area_off('sites')
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

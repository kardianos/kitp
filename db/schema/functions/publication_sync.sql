-- publication_sync — apply a page's CURRENT publish_status to the portals.
-- Called by attribute.update after it writes a page's publish_status (and
-- by card.insert when a page is created in a status), with the page id.
--
-- Rules (docs/BUNDLES_AND_PORTALS.md):
--   - entering a status whose publishes_to names portals snapshots the
--     page onto each of them (title, body, slug, sort_order, parent, and
--     revision = the page's newest activity id) — insert or replace;
--   - entering a TERMINAL-phase status withdraws the page from every
--     portal;
--   - entering any other status changes nothing: what a portal shows is
--     pinned until the page next enters a status that publishes there.
--     That is what lets a live page be edited (and sent back to review)
--     without its PROD copy changing.
-- Every portal whose publications changed is marked dirty for the builder.
--
-- Returns the number of portals touched.
CREATE OR REPLACE FUNCTION publication_sync(page_id bigint, actor_id bigint)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
    _status_id bigint;
    _phase text;
    _targets bigint[];
    _portal bigint;
    _n int := 0;
    _title text;
    _slug text;
    _sort double precision;
    _body text;
    _parent bigint;
    _rev bigint;
BEGIN
    SELECT CASE
             WHEN jsonb_typeof(av.value) = 'number' THEN (av.value)::text::bigint
             WHEN jsonb_typeof(av.value) = 'string' AND (av.value #>> '{}') ~ '^\d+$'
                  THEN (av.value #>> '{}')::bigint
           END
      INTO _status_id
    FROM attribute_value av
    JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'publish_status'
    WHERE av.card_id = page_id;
    IF _status_id IS NULL THEN
        RETURN 0;
    END IF;
    SELECT phase INTO _phase FROM card WHERE id = _status_id;

    IF _phase = 'terminal' THEN
        FOR _portal IN SELECT p.portal_id FROM publication p WHERE p.card_id = page_id
        LOOP
            PERFORM portal_mark_dirty(_portal);
            _n := _n + 1;
        END LOOP;
        DELETE FROM publication WHERE card_id = page_id;
        RETURN _n;
    END IF;

    -- The status's portals: live portal cards only.
    SELECT COALESCE(array_agg(pc.id ORDER BY pc.id), ARRAY[]::bigint[]) INTO _targets
    FROM attribute_value av
    JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'publishes_to'
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(av.value) = 'array' THEN av.value ELSE '[]'::jsonb END) e(v)
    JOIN card pc
      ON pc.id = CASE WHEN (e.v #>> '{}') ~ '^\d+$' THEN (e.v #>> '{}')::bigint END
     AND pc.deleted_at IS NULL
    JOIN card_type pct ON pct.id = pc.card_type_id AND pct.name = 'portal'
    WHERE av.card_id = _status_id;
    IF cardinality(_targets) = 0 THEN
        RETURN 0;
    END IF;

    -- Snapshot the page as it is now.
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
    WHERE c.id = page_id
    GROUP BY c.parent_card_id;
    SELECT max(a.id) INTO _rev FROM activity a WHERE a.card_id = page_id;

    FOREACH _portal IN ARRAY _targets
    LOOP
        INSERT INTO publication (portal_id, card_id, parent_card_id, title, slug, sort_order,
                                 body, revision_activity_id, published_at, published_by)
        VALUES (_portal, page_id, _parent, _title, _slug, _sort, _body, _rev, now(), actor_id)
        ON CONFLICT (portal_id, card_id) DO UPDATE SET
            parent_card_id = EXCLUDED.parent_card_id,
            title = EXCLUDED.title,
            slug = EXCLUDED.slug,
            sort_order = EXCLUDED.sort_order,
            body = EXCLUDED.body,
            revision_activity_id = EXCLUDED.revision_activity_id,
            published_at = EXCLUDED.published_at,
            published_by = EXCLUDED.published_by;
        PERFORM portal_mark_dirty(_portal);
        _n := _n + 1;
    END LOOP;
    RETURN _n;
END;
$$;

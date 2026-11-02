-- portal.set handler — create or update a PORTAL: a published site. A
-- portal is a global `portal` card carrying
--   title          — the site's name (shown in its header)
--   portal_root    — the page whose tree the site publishes (its Home)
--   portal_host    — the host name the public listener serves it on
--                    (KITP_PORTAL_ADDR); '' = no public host
--   portal_public  — false keeps it off the public listener entirely:
--                    viewable only through the signed-in preview route,
--                    which is how a QA portal stays internal
--   portal_theme   — the theme card the site is built with; none = the
--                    built-in Side menu theme
--   portal_internal — "Show in kitp": the site is listed in kitp's
--                    sidebar and shown (sandboxed) in the content area to
--                    people who can see its root page
-- Which PAGES appear is decided elsewhere: a status's publishes_to names
-- the portals a page is published to when it enters that status.
--
-- Input:  {"id"?, "title"?, "host"?, "root_page_id"?, "public"?,
--          "theme_id"?, "internal"?}
--         id absent / "0" → create (title required). Absent fields are
--         left alone; host "" clears; root_page_id / theme_id "0" clear.
-- Result: {"id": "<id>", "created": bool, "changed": bool}
--
-- Host names are lower-cased and must be unique among live portals (one
-- host, one site). Only CHANGED attributes write activity rows; any change
-- marks the portal dirty for the builder.
--
-- Authz: admin only (the dispatcher's AllowedRoles) — a portal decides
-- what reaches a public host.
CREATE OR REPLACE FUNCTION portal_set_batch(
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
    _portal_ct bigint;
    _title_def bigint;
    _host_def bigint;
    _root_def bigint;
    _public_def bigint;
    _theme_def bigint;
    _internal_def bigint;
    _idx int;
    _raw jsonb;
    _id bigint;
    _created boolean;
    _title text;
    _host text;
    _root bigint;
    _public boolean;
    _theme bigint;
    _internal boolean;
    _writes int;
BEGIN
    SELECT id INTO _portal_ct FROM card_type WHERE name = 'portal';
    SELECT id INTO _title_def FROM attribute_def WHERE name = 'title';
    SELECT id INTO _host_def FROM attribute_def WHERE name = 'portal_host';
    SELECT id INTO _root_def FROM attribute_def WHERE name = 'portal_root';
    SELECT id INTO _public_def FROM attribute_def WHERE name = 'portal_public';
    SELECT id INTO _theme_def FROM attribute_def WHERE name = 'portal_theme';
    SELECT id INTO _internal_def FROM attribute_def WHERE name = 'portal_internal';
    IF _portal_ct IS NULL OR _host_def IS NULL OR _root_def IS NULL OR _public_def IS NULL
       OR _theme_def IS NULL OR _internal_def IS NULL THEN
        RAISE EXCEPTION 'portal.set: portal card_type or its attribute_defs are missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF workspace_area_off('sites') THEN
            RETURN QUERY SELECT _idx, false, 'area_off'::text,
                'portal.set: Sites is switched off for this workspace'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        BEGIN
            _id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
            _root := CASE WHEN _raw ? 'root_page_id'
                          THEN COALESCE(NULLIF(_raw->>'root_page_id', '')::bigint, 0) END;
            _theme := CASE WHEN _raw ? 'theme_id'
                           THEN COALESCE(NULLIF(_raw->>'theme_id', '')::bigint, 0) END;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'portal.set: id, root_page_id and theme_id must be card ids'::text, NULL::jsonb;
            CONTINUE;
        END;
        _title := CASE WHEN _raw ? 'title' AND jsonb_typeof(_raw->'title') = 'string'
                       THEN btrim(_raw->>'title') END;
        _host := CASE WHEN _raw ? 'host' AND jsonb_typeof(_raw->'host') = 'string'
                      THEN lower(btrim(_raw->>'host')) END;
        _public := CASE WHEN jsonb_typeof(_raw->'public') = 'boolean'
                        THEN (_raw->>'public')::boolean END;
        _internal := CASE WHEN jsonb_typeof(_raw->'internal') = 'boolean'
                          THEN (_raw->>'internal')::boolean END;

        -- 1. Shape validation.
        IF _title = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'portal.set: title can''t be blank'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _id = 0 AND _title IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'portal.set: a new portal needs a title'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _host IS NOT NULL AND _host <> ''
           AND (length(_host) > 253
                OR _host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('portal.set: %L is not a host name (letters, digits, dots and dashes; no scheme, port or path)', _host),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. The target portal (update) must be a live portal card.
        IF _id <> 0 THEN
            PERFORM 1 FROM card c
            WHERE c.id = _id AND c.card_type_id = _portal_ct AND c.deleted_at IS NULL;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'portal_not_found'::text,
                    format('portal.set: portal %s not found', _id), NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 3. The root must be a live page in a project that isn't a
        --    template. Templates include the hidden feature-bundle source
        --    projects, whose starter pages share titles ("Home") with the
        --    pages real projects get from them; none of them ever publishes.
        IF _root IS NOT NULL AND _root <> 0 THEN
            PERFORM 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'page'
            WHERE c.id = _root AND c.deleted_at IS NULL;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('portal.set: card %s is not a page', _root), NULL::jsonb;
                CONTINUE;
            END IF;
            PERFORM 1
            FROM attribute_value tv
            JOIN attribute_def td ON td.id = tv.attribute_def_id AND td.name = 'is_template'
            WHERE tv.card_id = card_enclosing_project(_root) AND tv.value = to_jsonb(true);
            IF FOUND THEN
                RETURN QUERY SELECT _idx, false, 'root_in_template'::text,
                    format('portal.set: page %s belongs to a template, not a live project', _root),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 3b. The theme must be a live theme card.
        IF _theme IS NOT NULL AND _theme <> 0 THEN
            PERFORM 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'theme'
            WHERE c.id = _theme AND c.deleted_at IS NULL;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'theme_not_found'::text,
                    format('portal.set: card %s is not a theme', _theme), NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 4. One host, one site.
        IF _host IS NOT NULL AND _host <> '' THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('kitp.portal_host:' || _host, 0));
            PERFORM 1
            FROM card c
            JOIN attribute_value av ON av.card_id = c.id AND av.attribute_def_id = _host_def
            WHERE c.card_type_id = _portal_ct AND c.deleted_at IS NULL
              AND c.id <> _id
              AND av.value = to_jsonb(_host);
            IF FOUND THEN
                RETURN QUERY SELECT _idx, false, 'host_taken'::text,
                    format('portal.set: another portal already serves %L', _host), NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        _created := _id = 0;
        IF _created THEN
            INSERT INTO card (card_type_id) VALUES (_portal_ct) RETURNING id INTO _id;
            INSERT INTO activity (card_id, kind, actor_id)
            VALUES (_id, 'card_create', portal_set_batch.actor_id);
            _public := COALESCE(_public, false);
            _internal := COALESCE(_internal, false);
        END IF;

        -- 5. Write the changed attributes only.
        WITH want(ord, attr_def_id, value) AS (
            SELECT 1, _title_def, to_jsonb(_title) WHERE _title IS NOT NULL
            UNION ALL
            SELECT 2, _host_def, to_jsonb(_host) WHERE _host IS NOT NULL
            UNION ALL
            SELECT 3, _root_def, CASE WHEN _root = 0 THEN 'null'::jsonb ELSE to_jsonb(_root) END
            WHERE _root IS NOT NULL
            UNION ALL
            SELECT 4, _public_def, to_jsonb(_public) WHERE _public IS NOT NULL
            UNION ALL
            SELECT 5, _theme_def, CASE WHEN _theme = 0 THEN 'null'::jsonb ELSE to_jsonb(_theme) END
            WHERE _theme IS NOT NULL
            UNION ALL
            SELECT 6, _internal_def, to_jsonb(_internal) WHERE _internal IS NOT NULL
        ),
        changed AS (
            SELECT w.ord, w.attr_def_id, w.value, cur.value AS old_value
            FROM want w
            LEFT JOIN attribute_value cur
              ON cur.card_id = _id AND cur.attribute_def_id = w.attr_def_id
            WHERE cur.value IS DISTINCT FROM w.value
              AND NOT (cur.value IS NULL AND w.value IN ('null'::jsonb, to_jsonb(''::text)))
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _id, 'attr_update', c.attr_def_id, c.old_value, c.value, portal_set_batch.actor_id
            FROM changed c
            ORDER BY c.ord
            RETURNING id, attribute_def_id, value_new
        ),
        upsert AS (
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            SELECT _id, ia.attribute_def_id, ia.value_new, ia.id
            FROM ins_activity ia
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value,
                    last_activity_id = EXCLUDED.last_activity_id
            RETURNING 1
        )
        SELECT count(*)::int INTO _writes FROM upsert;

        IF _created OR _writes > 0 THEN
            PERFORM portal_mark_dirty(_id);
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('id', _id::text, 'created', _created,
                               'changed', _created OR _writes > 0);
    END LOOP;
END;
$$;

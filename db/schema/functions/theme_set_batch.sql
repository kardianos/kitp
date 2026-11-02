-- theme.set handler — create or update a THEME: what a site looks like. A
-- theme is a global `theme` card carrying
--   title         — its name in the Themes screen and the portal picker
--   theme_base    — the built-in theme it starts from ('sidebar',
--                   'topbar', 'newspaper', …); the Go PreRun checks it
--                   against the themes compiled into the server
--   theme_nav     — the navigation mode: 'full' (the whole tree),
--                   'section' (top level, opened along the current page),
--                   'collapsible' (the whole tree, closed except along the
--                   current page); '' = the base theme's default
--   theme_accent  — a #rrggbb colour; '' = the base theme's
--   theme_footer  — markdown shown in every page's footer; '' = none
-- Its files (templates, CSS, logo, favicon, fonts) are theme_file rows,
-- written by theme.file_put.
--
-- Input:  {"id"?, "title"?, "base"?, "nav"?, "accent"?, "footer"?}
--         id absent / "0" → create (title and base required). Absent
--         fields are left alone; "" clears nav / accent / footer.
-- Result: {"id": "<id>", "created": bool, "changed": bool}
--
-- Only CHANGED attributes write activity rows; any change rebuilds the
-- portals using the theme.
--
-- Authz: admin only (the dispatcher's AllowedRoles).
CREATE OR REPLACE FUNCTION theme_set_batch(
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
    _theme_ct bigint;
    _title_def bigint;
    _base_def bigint;
    _nav_def bigint;
    _accent_def bigint;
    _footer_def bigint;
    _idx int;
    _raw jsonb;
    _id bigint;
    _created boolean;
    _title text;
    _base text;
    _nav text;
    _accent text;
    _footer text;
    _writes int;
BEGIN
    SELECT id INTO _theme_ct FROM card_type WHERE name = 'theme';
    SELECT id INTO _title_def FROM attribute_def WHERE name = 'title';
    SELECT id INTO _base_def FROM attribute_def WHERE name = 'theme_base';
    SELECT id INTO _nav_def FROM attribute_def WHERE name = 'theme_nav';
    SELECT id INTO _accent_def FROM attribute_def WHERE name = 'theme_accent';
    SELECT id INTO _footer_def FROM attribute_def WHERE name = 'theme_footer';
    IF _theme_ct IS NULL OR _base_def IS NULL OR _nav_def IS NULL
       OR _accent_def IS NULL OR _footer_def IS NULL THEN
        RAISE EXCEPTION 'theme.set: theme card_type or its attribute_defs are missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'theme.set: id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END;
        _title := CASE WHEN jsonb_typeof(_raw->'title') = 'string' THEN btrim(_raw->>'title') END;
        _base := CASE WHEN jsonb_typeof(_raw->'base') = 'string' THEN btrim(_raw->>'base') END;
        _nav := CASE WHEN jsonb_typeof(_raw->'nav') = 'string' THEN btrim(_raw->>'nav') END;
        _accent := CASE WHEN jsonb_typeof(_raw->'accent') = 'string' THEN lower(btrim(_raw->>'accent')) END;
        _footer := CASE WHEN jsonb_typeof(_raw->'footer') = 'string' THEN btrim(_raw->>'footer') END;

        -- 1. Shape validation.
        IF _title = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'theme.set: title can''t be blank'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _base = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'theme.set: a theme needs a base theme'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _id = 0 AND (_title IS NULL OR _base IS NULL) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'theme.set: a new theme needs a title and a base theme'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _nav IS NOT NULL AND _nav NOT IN ('', 'full', 'section', 'collapsible') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('theme.set: navigation %L is not one of full, section, collapsible', _nav),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _accent IS NOT NULL AND _accent <> '' AND _accent !~ '^#[0-9a-f]{6}$' THEN
            RETURN QUERY SELECT _idx, false, 'bad_accent'::text,
                format('theme.set: accent %L is not a colour like #2f6bdb', _accent), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _footer IS NOT NULL AND length(_footer) > 4000 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'theme.set: the footer is longer than 4000 characters'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. The target theme (update) must be a live theme card.
        IF _id <> 0 THEN
            PERFORM 1 FROM card c
            WHERE c.id = _id AND c.card_type_id = _theme_ct AND c.deleted_at IS NULL;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'theme_not_found'::text,
                    format('theme.set: theme %s not found', _id), NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        _created := _id = 0;
        IF _created THEN
            INSERT INTO card (card_type_id) VALUES (_theme_ct) RETURNING id INTO _id;
            INSERT INTO activity (card_id, kind, actor_id)
            VALUES (_id, 'card_create', theme_set_batch.actor_id);
        END IF;

        -- 3. Write the changed attributes only.
        WITH want(ord, attr_def_id, value) AS (
            SELECT 1, _title_def, to_jsonb(_title) WHERE _title IS NOT NULL
            UNION ALL
            SELECT 2, _base_def, to_jsonb(_base) WHERE _base IS NOT NULL
            UNION ALL
            SELECT 3, _nav_def, to_jsonb(_nav) WHERE _nav IS NOT NULL
            UNION ALL
            SELECT 4, _accent_def, to_jsonb(_accent) WHERE _accent IS NOT NULL
            UNION ALL
            SELECT 5, _footer_def, to_jsonb(_footer) WHERE _footer IS NOT NULL
        ),
        changed AS (
            SELECT w.ord, w.attr_def_id, w.value, cur.value AS old_value
            FROM want w
            LEFT JOIN attribute_value cur
              ON cur.card_id = _id AND cur.attribute_def_id = w.attr_def_id
            WHERE cur.value IS DISTINCT FROM w.value
              AND NOT (cur.value IS NULL AND w.value = to_jsonb(''::text))
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _id, 'attr_update', c.attr_def_id, c.old_value, c.value, theme_set_batch.actor_id
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

        IF _writes > 0 THEN
            PERFORM theme_mark_portals_dirty(_id);
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('id', _id::text, 'created', _created,
                               'changed', _created OR _writes > 0);
    END LOOP;
END;
$$;

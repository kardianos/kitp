-- my_screen.set — create (id absent / 0) or update one of the caller's
-- personal screens (docs/PERSONAL_SCREENS.md). A personal screen is a
-- `screen` card with no parent, private to the caller's person (card.
-- private_to): card.insert can't make one (a screen's parent type is
-- project), so this does.
--
-- Fields (absent = unchanged on update):
--   title           1–60 characters; required to create.
--   layout          list | grid (default list; no kanban — its columns are
--                   one project's statuses).
--   list_card_type  task | comm (default task); changing it resets the
--                   phase toggles to that type's status attribute.
--   predicate       the base filter, screen-filter JSON ('@me' = you; ''
--                   = every task or thread you can see). A `project` leaf
--                   limits it to some projects.
--   sort_order      its place in Mine (lower first; default: after the
--                   last).
--   default_filter  one of its own views ('0' clears).
-- A new screen gets slug my-<id> (screens need one) and the phase toggles
-- New / Active (on) / Closed (my_screen_toggles). Only changed attributes
-- are written, each with an activity row.
CREATE OR REPLACE FUNCTION my_screen_set_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _person bigint := account_person(my_screen_set_batch.actor_id);
    _screen_ct bigint := (SELECT id FROM card_type WHERE name = 'screen');
    _filter_ct bigint := (SELECT id FROM card_type WHERE name = 'filter');
    _id bigint;
    _creating boolean;
    _title text;
    _layout text;
    _list text;
    _pred text;
    _sort numeric;
    _default bigint;
    _cur_list text;
BEGIN
    IF (SELECT id FROM attribute_def WHERE name = 'list_card_type') IS NULL THEN
        RAISE EXCEPTION 'my_screen.set: the list_card_type attribute is missing (migration 0028)' USING ERRCODE = 'P0001';
    END IF;
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'id', '0') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'my_screen.set: id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _id := COALESCE(NULLIF(_raw->>'id', ''), '0')::bigint;
        _creating := _id = 0;
        IF _person IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'no_person'::text,
                'my_screen.set: your account has no person card to own a screen'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT _creating AND NOT EXISTS (
            SELECT 1 FROM card c WHERE c.id = _id AND c.card_type_id = _screen_ct
              AND c.parent_card_id IS NULL AND c.private_to = _person AND c.deleted_at IS NULL) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('my_screen.set: screen %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;

        _title := btrim(COALESCE(_raw->>'title', ''));
        IF (_creating OR _raw ? 'title') AND (_title = '' OR length(_title) > 60) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'my_screen.set: a name (up to 60 characters) is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _layout := COALESCE(NULLIF(_raw->>'layout', ''), CASE WHEN _creating THEN 'list' END);
        IF _layout IS NOT NULL AND _layout NOT IN ('list', 'grid') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('my_screen.set: layout %L is not one of list / grid', _layout), NULL::jsonb;
            CONTINUE;
        END IF;
        _list := COALESCE(NULLIF(_raw->>'list_card_type', ''), CASE WHEN _creating THEN 'task' END);
        IF _list IS NOT NULL AND _list NOT IN ('task', 'comm') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('my_screen.set: list_card_type %L is not one of task / comm', _list), NULL::jsonb;
            CONTINUE;
        END IF;
        _pred := COALESCE(_raw->>'predicate', '');
        IF btrim(_pred) <> '' THEN
            BEGIN
                IF jsonb_typeof(_pred::jsonb) <> 'object' THEN
                    RAISE EXCEPTION 'the filter must be a JSON object';
                END IF;
                PERFORM card_compile_predicate(_resolve_me_tokens(_pred::jsonb, _person), '[]'::jsonb, ARRAY[]::bigint[], _person);
            EXCEPTION WHEN OTHERS THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('my_screen.set: the filter is not valid: %s', CASE WHEN SQLSTATE = 'P0001' THEN SQLERRM ELSE 'it can''t be read' END), NULL::jsonb;
                CONTINUE;
            END;
        END IF;
        -- A whole number, as every number attribute is (attr_scalar_norm):
        -- the attribute_value_def_ref index casts stored numbers to bigint,
        -- so 2.5 or 1e300 failed as an internal error (review 2026-11-03
        -- round 3 #23).
        IF _raw ? 'sort_order' AND (jsonb_typeof(_raw->'sort_order') IS DISTINCT FROM 'number'
                                    OR attr_scalar_norm('number', _raw->'sort_order') IS NULL) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'my_screen.set: sort_order must be a whole number'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _sort := CASE WHEN _raw ? 'sort_order' THEN (_raw->>'sort_order')::numeric
                      WHEN _creating THEN COALESCE((
                          SELECT max((v.value)::text::numeric) FROM card c
                          JOIN attribute_value v ON v.card_id = c.id
                          JOIN attribute_def d ON d.id = v.attribute_def_id AND d.name = 'sort_order'
                          WHERE c.card_type_id = _screen_ct AND c.parent_card_id IS NULL AND c.private_to = _person
                            AND c.deleted_at IS NULL AND jsonb_typeof(v.value) = 'number'), 0) + 10
                 END;
        _default := NULL;
        IF _raw ? 'default_filter' THEN
            IF COALESCE(_raw->>'default_filter', '') !~ '^\d+$' THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text, 'my_screen.set: default_filter must be a view id or 0'::text, NULL::jsonb;
                CONTINUE;
            END IF;
            _default := (_raw->>'default_filter')::bigint;
            IF _default <> 0 AND (_creating OR NOT EXISTS (
                SELECT 1 FROM card f WHERE f.id = _default AND f.card_type_id = _filter_ct
                  AND f.parent_card_id = _id AND f.deleted_at IS NULL)) THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'my_screen.set: default_filter must be one of the screen''s own views'::text, NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- At most 200 personal screens each (review 2026-11-03 round 4:
        -- nothing capped it; personal_cap_full, round 5 #11).
        IF _creating AND personal_cap_full('screen', _person) THEN
            RETURN QUERY SELECT _idx, false, 'limit'::text,
                'my_screen.set: you can have at most 200 personal screens'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _creating THEN
            INSERT INTO card (card_type_id, parent_card_id, private_to) VALUES (_screen_ct, NULL, _person)
            RETURNING card.id INTO _id;
            INSERT INTO activity (card_id, kind, actor_id) VALUES (_id, 'card_create', my_screen_set_batch.actor_id);
            _cur_list := NULL;
        ELSE
            SELECT v.value #>> '{}' INTO _cur_list FROM attribute_value v
            JOIN attribute_def d ON d.id = v.attribute_def_id AND d.name = 'list_card_type'
            WHERE v.card_id = _id;
        END IF;

        WITH want(attr, value) AS (
            SELECT 'title', to_jsonb(_title) WHERE _creating OR _raw ? 'title'
            UNION ALL SELECT 'slug', to_jsonb('my-' || _id::text) WHERE _creating
            UNION ALL SELECT 'layout', to_jsonb(_layout) WHERE _layout IS NOT NULL
            UNION ALL SELECT 'list_card_type', to_jsonb(_list) WHERE _list IS NOT NULL
            -- The phase toggles follow the listed type's status attribute.
            UNION ALL SELECT 'toggle_groups', to_jsonb(my_screen_toggles(_list)::text)
                WHERE _list IS NOT NULL AND _list IS DISTINCT FROM _cur_list
            UNION ALL SELECT 'predicate', to_jsonb(_pred) WHERE _creating OR _raw ? 'predicate'
            UNION ALL SELECT 'sort_order', to_jsonb(_sort) WHERE _sort IS NOT NULL
            UNION ALL SELECT 'default_filter', CASE WHEN _default = 0 THEN 'null'::jsonb ELSE to_jsonb(_default) END
                WHERE _default IS NOT NULL
        ),
        resolved AS (
            SELECT row_number() OVER () AS ord, ad.id AS attr_def_id, w.value
            FROM want w JOIN attribute_def ad ON ad.name = w.attr
        ),
        changed AS (
            SELECT r.ord, r.attr_def_id, r.value, cur.value AS old_value
            FROM resolved r
            LEFT JOIN attribute_value cur ON cur.card_id = _id AND cur.attribute_def_id = r.attr_def_id
            WHERE cur.value IS DISTINCT FROM r.value
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _id, 'attr_update', c.attr_def_id, c.old_value, c.value, my_screen_set_batch.actor_id
            FROM changed c ORDER BY c.ord
            RETURNING activity.id, attribute_def_id, value_new
        )
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        SELECT _id, ia.attribute_def_id, ia.value_new, ia.id FROM ins_activity ia
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('id', _id::text);
    END LOOP;
END;
$$;

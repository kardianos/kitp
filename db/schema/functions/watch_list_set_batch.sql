-- watch_list.set — create (id absent / 0) or update one of the caller's
-- watch lists (docs/WATCH_LISTS.md): title (1–60 characters; required to
-- create), symbol (1–16 characters, an emoji or a character such as ★;
-- defaults to ★) and description (up to 1000). The owner is always the
-- caller's person (watch_owner); only the owner may change a list. Only
-- changed attributes are written, each with an activity row.
CREATE OR REPLACE FUNCTION watch_list_set_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _person bigint := watch_owner(watch_list_set_batch.actor_id);
    _wl_ct bigint := (SELECT id FROM card_type WHERE name = 'watch_list');
    _title_def bigint := (SELECT id FROM attribute_def WHERE name = 'title');
    _sub_def bigint := (SELECT id FROM attribute_def WHERE name = 'subscriber');
    _sym_def bigint := (SELECT id FROM attribute_def WHERE name = 'symbol');
    _desc_def bigint := (SELECT id FROM attribute_def WHERE name = 'description');
    _id bigint;
    _creating boolean;
    _title text;
    _symbol text;
    _desc text;
BEGIN
    IF _wl_ct IS NULL OR _sym_def IS NULL THEN
        RAISE EXCEPTION 'watch_list.set: the watch_list card_type is missing (migration 0026)' USING ERRCODE = 'P0001';
    END IF;
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'id', '0') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'watch_list.set: id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _id := COALESCE(NULLIF(_raw->>'id', ''), '0')::bigint;
        _creating := _id = 0;
        _title := btrim(COALESCE(_raw->>'title', ''));
        _symbol := btrim(COALESCE(_raw->>'symbol', ''));
        _desc := btrim(COALESCE(_raw->>'description', ''));

        IF _person IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'no_person'::text,
                'watch_list.set: your account has no linked person card to own a watch list'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF (_creating OR _raw ? 'title') AND (_title = '' OR length(_title) > 60) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'watch_list.set: a name (up to 60 characters) is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _creating AND _symbol = '' THEN
            _symbol := '★';
        END IF;
        IF (_creating OR _raw ? 'symbol') AND (_symbol = '' OR length(_symbol) > 16) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'watch_list.set: a symbol (an emoji or a character, up to 16) is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF length(_desc) > 1000 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'watch_list.set: the description is up to 1000 characters'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        IF _creating THEN
            INSERT INTO card (card_type_id, parent_card_id) VALUES (_wl_ct, NULL) RETURNING card.id INTO _id;
            INSERT INTO activity (card_id, kind, actor_id) VALUES (_id, 'card_create', watch_list_set_batch.actor_id);
        ELSIF NOT watch_list_owned_by(_id, watch_list_set_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('watch_list.set: watch list %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;

        WITH want(ord, attr_def_id, value) AS (
            SELECT row_number() OVER () AS ord, w.attr_def_id, w.value FROM (
                SELECT _title_def AS attr_def_id, to_jsonb(_title) AS value WHERE _creating OR _raw ? 'title'
                UNION ALL SELECT _sub_def, to_jsonb(_person) WHERE _creating
                UNION ALL SELECT _sym_def, to_jsonb(_symbol) WHERE _creating OR _raw ? 'symbol'
                UNION ALL SELECT _desc_def, to_jsonb(_desc) WHERE _raw ? 'description'
            ) w
        ),
        changed AS (
            SELECT w.ord, w.attr_def_id, w.value, cur.value AS old_value
            FROM want w
            LEFT JOIN attribute_value cur ON cur.card_id = _id AND cur.attribute_def_id = w.attr_def_id
            WHERE cur.value IS DISTINCT FROM w.value
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _id, 'attr_update', c.attr_def_id, c.old_value, c.value, watch_list_set_batch.actor_id
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

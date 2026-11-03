-- watch_list.list — the caller's watch lists (docs/WATCH_LISTS.md), oldest
-- first: id, title, symbol, description and how many items each holds; with
-- card_id, also whether that card is on each (the bookmarks in a task's or
-- thread's corner).
--
-- An account's first call makes its default list, Stars (★): when no watch
-- list has ever belonged to its person — a deleted one counts, so deleting
-- Stars sticks. A transaction-scoped advisory lock on the person keeps two
-- first calls from making two. An account with no person (watch_owner NULL)
-- has no lists.
CREATE OR REPLACE FUNCTION watch_list_list_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _person bigint := watch_owner(watch_list_list_batch.actor_id);
    _wl_ct bigint := (SELECT id FROM card_type WHERE name = 'watch_list');
    _title_def bigint := (SELECT id FROM attribute_def WHERE name = 'title');
    _sub_def bigint := (SELECT id FROM attribute_def WHERE name = 'subscriber');
    _sym_def bigint := (SELECT id FROM attribute_def WHERE name = 'symbol');
    _card bigint;
    _id bigint;
BEGIN
    IF _wl_ct IS NULL OR _sym_def IS NULL THEN
        RAISE EXCEPTION 'watch_list.list: the watch_list card_type is missing (migration 0026)' USING ERRCODE = 'P0001';
    END IF;
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'card_id', '0') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'watch_list.list: card_id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _card := COALESCE(NULLIF(_raw->>'card_id', ''), '0')::bigint;
        IF _person IS NULL THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('lists', '[]'::jsonb);
            CONTINUE;
        END IF;

        -- First use: Stars.
        PERFORM pg_advisory_xact_lock(hashtext('watch_list'), hashtext(_person::text));
        IF NOT EXISTS (
            SELECT 1 FROM card c
            JOIN attribute_value av ON av.card_id = c.id AND av.attribute_def_id = _sub_def
            WHERE c.card_type_id = _wl_ct AND av.value = to_jsonb(_person)
        ) THEN
            INSERT INTO card (card_type_id, parent_card_id) VALUES (_wl_ct, NULL) RETURNING card.id INTO _id;
            INSERT INTO activity (card_id, kind, actor_id) VALUES (_id, 'card_create', watch_list_list_batch.actor_id);
            WITH want(ord, attr_def_id, value) AS (
                VALUES (1, _title_def, to_jsonb('Stars'::text)),
                       (2, _sub_def, to_jsonb(_person)),
                       (3, _sym_def, to_jsonb('★'::text))
            ),
            ins_activity AS (
                INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                SELECT _id, 'attr_update', w.attr_def_id, NULL, w.value, watch_list_list_batch.actor_id
                FROM want w ORDER BY w.ord
                RETURNING activity.id, attribute_def_id, value_new
            )
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            SELECT _id, ia.attribute_def_id, ia.value_new, ia.id FROM ins_activity ia;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('lists', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', c.id::text,
                'title', COALESCE((SELECT v.value #>> '{}' FROM attribute_value v
                                   WHERE v.card_id = c.id AND v.attribute_def_id = _title_def), ''),
                'symbol', COALESCE((SELECT v.value #>> '{}' FROM attribute_value v
                                    WHERE v.card_id = c.id AND v.attribute_def_id = _sym_def), ''),
                'description', COALESCE((SELECT v.value #>> '{}' FROM attribute_value v
                                         JOIN attribute_def d ON d.id = v.attribute_def_id
                                         WHERE v.card_id = c.id AND d.name = 'description'), ''),
                'count', (SELECT count(*) FROM watch_entry we
                          JOIN card x ON x.id = we.card_id AND x.deleted_at IS NULL
                          WHERE we.watch_list_id = c.id),
                'has_card', _card <> 0 AND EXISTS (
                    SELECT 1 FROM watch_entry we WHERE we.watch_list_id = c.id AND we.card_id = _card))
                ORDER BY c.id)
            FROM card c
            JOIN attribute_value av ON av.card_id = c.id AND av.attribute_def_id = _sub_def
            WHERE c.card_type_id = _wl_ct AND c.deleted_at IS NULL AND av.value = to_jsonb(_person)
        ), '[]'::jsonb));
    END LOOP;
END;
$$;

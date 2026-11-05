-- watch.set — put a task or thread on one of the caller's watch lists, or
-- take it off (docs/WATCH_LISTS.md): {watch_list_id, card_id, on}. The list
-- must be the caller's (watch_list_owned_by); the card a live task or comm
-- the caller can see, outside an area that is switched off. A new entry goes
-- to the top of the list (sort_order below the lowest). Already on / already
-- off is ok. Bookmarks are the account's own, not the card's history, so no
-- activity rows are written (like user_card_sort).
CREATE OR REPLACE FUNCTION watch_set_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _list bigint;
    _card bigint;
    _on boolean;
    _type text;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'watch_list_id', '') !~ '^\d+$' OR COALESCE(_raw->>'card_id', '') !~ '^\d+$'
           OR jsonb_typeof(_raw->'on') IS DISTINCT FROM 'boolean' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'watch.set: watch_list_id, card_id and on (true / false) are required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _list := (_raw->>'watch_list_id')::bigint;
        _card := (_raw->>'card_id')::bigint;
        _on := (_raw->'on')::text::boolean;
        IF NOT watch_list_owned_by(_list, watch_set_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('watch.set: watch list %s not found', _list), NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT _on THEN
            DELETE FROM watch_entry WHERE watch_list_id = _list AND card_id = _card;
            RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('on', false);
            CONTINUE;
        END IF;
        SELECT ct.name INTO _type
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _card AND c.deleted_at IS NULL;
        IF _type IS NULL OR NOT card_visible_to(watch_set_batch.actor_id, _card) OR card_in_off_area(_card) THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text, format('watch.set: card %s not found', _card), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _type NOT IN ('task', 'comm') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('watch.set: only tasks and threads go on a watch list, not %s', _type), NULL::jsonb;
            CONTINUE;
        END IF;
        -- At most 5,000 entries on one list (review 2026-11-03 round 4:
        -- nothing capped it). Entries on cards that are gone or that the
        -- owner can't see any more don't count, and a lock on the list
        -- keeps two adds at once from both taking the last place (round 5
        -- #11). The visible count runs only on a list that is nearly full.
        PERFORM pg_advisory_xact_lock(hashtextextended('kitp.watch_list:' || _list, 0));
        IF NOT EXISTS (SELECT 1 FROM watch_entry WHERE watch_list_id = _list AND card_id = _card)
           AND (SELECT count(*) FROM watch_entry WHERE watch_list_id = _list) >= 5000
           AND (SELECT count(*) FROM watch_entry we JOIN card wc ON wc.id = we.card_id AND wc.deleted_at IS NULL
                WHERE we.watch_list_id = _list AND card_visible_to(watch_set_batch.actor_id, wc.id)) >= 5000 THEN
            RETURN QUERY SELECT _idx, false, 'limit'::text,
                'watch.set: a watch list can hold at most 5000 tasks and threads'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        INSERT INTO watch_entry (watch_list_id, card_id, sort_order)
        VALUES (_list, _card,
                COALESCE((SELECT min(sort_order) FROM watch_entry WHERE watch_list_id = _list), 0) - 1)
        ON CONFLICT (watch_list_id, card_id) DO NOTHING;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('on', true);
    END LOOP;
END;
$$;

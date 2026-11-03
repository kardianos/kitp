-- watch.move — set an item's place on one of the caller's watch lists
-- (docs/WATCH_LISTS.md): {watch_list_id, card_id, sort_order}. The client
-- computes sort_order between the item's new neighbours (the midpoint, or one
-- past an end), as the inbox does for user_card_sort; items list by it.
CREATE OR REPLACE FUNCTION watch_move_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _list bigint;
    _card bigint;
    _n int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'watch_list_id', '') !~ '^\d+$' OR COALESCE(_raw->>'card_id', '') !~ '^\d+$'
           OR jsonb_typeof(_raw->'sort_order') IS DISTINCT FROM 'number' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'watch.move: watch_list_id, card_id and a numeric sort_order are required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _list := (_raw->>'watch_list_id')::bigint;
        _card := (_raw->>'card_id')::bigint;
        IF NOT watch_list_owned_by(_list, watch_move_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('watch.move: watch list %s not found', _list), NULL::jsonb;
            CONTINUE;
        END IF;
        UPDATE watch_entry SET sort_order = (_raw->>'sort_order')::double precision
        WHERE watch_list_id = _list AND card_id = _card;
        GET DIAGNOSTICS _n = ROW_COUNT;
        IF _n = 0 THEN
            RETURN QUERY SELECT _idx, false, 'not_on_list'::text, format('watch.move: card %s is not on watch list %s', _card, _list), NULL::jsonb;
            CONTINUE;
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('sort_order', (_raw->>'sort_order')::double precision);
    END LOOP;
END;
$$;

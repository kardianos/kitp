-- watch_list.delete — delete one of the caller's watch lists
-- (docs/WATCH_LISTS.md): soft-delete the card with a card_delete activity
-- row and drop its entries. The tasks and threads on it are untouched.
CREATE OR REPLACE FUNCTION watch_list_delete_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _id bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'id', '') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'watch_list.delete: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _id := (_raw->>'id')::bigint;
        IF NOT watch_list_owned_by(_id, watch_list_delete_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('watch_list.delete: watch list %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;
        UPDATE card SET deleted_at = now() WHERE id = _id;
        INSERT INTO activity (card_id, kind, actor_id) VALUES (_id, 'card_delete', watch_list_delete_batch.actor_id);
        DELETE FROM watch_entry WHERE watch_list_id = _id;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('id', _id::text);
    END LOOP;
END;
$$;

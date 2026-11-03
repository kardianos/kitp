-- calendar.delete — delete one of the caller's calendars (a workspace admin
-- may delete anyone's): soft-delete the card with a card_delete activity
-- row, and drop its URLs so they stop working at once.
-- docs/MAIL_INTAKE_AND_CALENDARS.md §8.
CREATE OR REPLACE FUNCTION calendar_delete_batch(
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
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'calendar.delete: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _id := (_raw->>'id')::bigint;
        IF NOT calendar_owned_by(_id, calendar_delete_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('calendar.delete: calendar %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;
        UPDATE card SET deleted_at = now() WHERE id = _id;
        INSERT INTO activity (card_id, kind, actor_id) VALUES (_id, 'card_delete', calendar_delete_batch.actor_id);
        DELETE FROM card_access WHERE card_id = _id AND purpose = 'calendar';
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('id', _id::text);
    END LOOP;
END;
$$;

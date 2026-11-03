-- calendar_url.delete — see calendar_url_create_batch.sql; the URL must be on one
-- of the caller's calendars (calendar_owned_by).
CREATE OR REPLACE FUNCTION calendar_url_delete_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _id bigint;
    _cal bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'id', '') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'calendar_url.delete: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _id := (_raw->>'id')::bigint;
        _cal := NULL;
        SELECT a.card_id INTO _cal FROM card_access a WHERE a.id = _id AND a.purpose = 'calendar';
        IF _cal IS NULL OR NOT calendar_owned_by(_cal, calendar_url_delete_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('calendar_url.delete: URL %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;
        DELETE FROM card_access WHERE id = _id;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('id', _id::text);
    END LOOP;
END;
$$;

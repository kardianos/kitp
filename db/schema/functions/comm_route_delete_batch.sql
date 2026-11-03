-- comm_route.delete — remove an inbound route. Its URL or address stops
-- working at once (404 / 550). Its Comm log rows stay (route_id has no FK).
-- Admin only. docs/MAIL_INTAKE_AND_CALENDARS.md §5.
CREATE OR REPLACE FUNCTION comm_route_delete_batch(
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
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'comm_route.delete: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _id := (_raw->>'id')::bigint;
        DELETE FROM card_access a WHERE a.id = _id AND a.purpose IN ('inbound_post', 'inbound_smtp');
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('comm_route.delete: route %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('id', _id::text);
    END LOOP;
END;
$$;

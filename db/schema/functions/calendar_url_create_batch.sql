-- calendar_url.create / .update / .delete — the secret .ics URLs of one of
-- the caller's calendars (docs/MAIL_INTAKE_AND_CALENDARS.md §5, §8). A
-- calendar may have several, each with a comment ("iPhone", "Google
-- work"), so one can be revoked alone. create returns the token ONCE; the
-- client shows /api/v1/calendar/<token>.ics. At most 50 per calendar.
CREATE OR REPLACE FUNCTION calendar_url_create_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _cal bigint;
    _m record;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'calendar_id', '') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'calendar_url.create: calendar_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _cal := (_raw->>'calendar_id')::bigint;
        IF NOT calendar_owned_by(_cal, calendar_url_create_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('calendar_url.create: calendar %s not found', _cal), NULL::jsonb;
            CONTINUE;
        END IF;
        IF (SELECT count(*) FROM card_access a WHERE a.card_id = _cal AND a.purpose = 'calendar') >= 50 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'calendar_url.create: a calendar has at most 50 URLs; delete one first'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT * INTO _m FROM card_access_mint(_cal, 'calendar', '', left(btrim(COALESCE(_raw->>'comment', '')), 200),
                                               '{}'::jsonb, '', calendar_url_create_batch.actor_id);
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('id', _m.id::text, 'token', _m.token, 'hint', _m.hint);
    END LOOP;
END;
$$;

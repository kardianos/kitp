-- comm_route.update — change an inbound route's comment, filters or (Mailgun)
-- signing key. The token, purpose and provider are fixed: make a new route
-- to change them. Absent fields are left alone. Admin only.
-- docs/MAIL_INTAKE_AND_CALENDARS.md §5.
CREATE OR REPLACE FUNCTION comm_route_update_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _id bigint;
    _provider text;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'id', '') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'comm_route.update: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _id := (_raw->>'id')::bigint;
        SELECT a.provider INTO _provider FROM card_access a
        WHERE a.id = _id AND a.purpose IN ('inbound_post', 'inbound_smtp');
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('comm_route.update: route %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _raw ? 'signing_key' AND _provider <> 'mailgun' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_route.update: only a Mailgun route has a signing key'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _raw ? 'signing_key' AND btrim(COALESCE(_raw->>'signing_key', '')) = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_route.update: a Mailgun route needs its signing key'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        UPDATE card_access a SET
            comment = CASE WHEN _raw ? 'comment' THEN left(btrim(COALESCE(_raw->>'comment', '')), 200) ELSE a.comment END,
            policy = CASE WHEN _raw ? 'policy' AND jsonb_typeof(_raw->'policy') = 'object' THEN _raw->'policy' ELSE a.policy END,
            signing_key = CASE WHEN _raw ? 'signing_key'
                               THEN pgp_sym_encrypt(btrim(_raw->>'signing_key'), current_setting('app.comm_secret_key'))
                               ELSE a.signing_key END
        WHERE a.id = _id;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('id', _id::text);
    END LOOP;
END;
$$;

-- person_email.verify — the caller confirms an address they added with the
-- code mailed to it (code_hash: its hash, from the handler's PreRun). The
-- code is 10 characters of 32 and lasts 24 hours; a failed batch rolls
-- back, so tries aren't counted — the code is too long to guess instead.
CREATE OR REPLACE FUNCTION person_email_verify_batch(actor_id bigint, inputs jsonb)
RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx    int;
    _raw    jsonb;
    _email  text;
    _hash   text;
    _row    person_email%ROWTYPE;
    _person bigint := account_person(actor_id);
    _agent  boolean := COALESCE((SELECT is_agent FROM user_account WHERE id = actor_id), false);
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _email := lower(btrim(COALESCE(_raw->>'email', '')));
        _hash := COALESCE(_raw->>'code_hash', '');
        IF _agent OR _person IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text, 'person_email.verify: only the person verifies their addresses'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT * INTO _row FROM person_email WHERE person_card_id = _person AND email = _email FOR UPDATE;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, 'person_email.verify: you haven''t added that address'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _row.verified_at IS NOT NULL THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('email', _email, 'verified', true);
            CONTINUE;
        END IF;
        IF _row.verify_code_hash IS NULL OR _row.verify_expires_at < now() THEN
            RETURN QUERY SELECT _idx, false, 'expired'::text, 'person_email.verify: that code has expired; send a new one'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _row.verify_code_hash <> _hash THEN
            RETURN QUERY SELECT _idx, false, 'invalid_code'::text, 'person_email.verify: that code doesn''t match'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        BEGIN
            UPDATE person_email SET verified_at = now(), verify_code_hash = NULL, verify_expires_at = NULL
            WHERE person_card_id = _person AND email = _email;
        EXCEPTION WHEN unique_violation THEN
            RETURN QUERY SELECT _idx, false, 'in_use'::text, 'person_email.verify: someone else verified that address first'::text, NULL::jsonb;
            CONTINUE;
        END;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('email', _email, 'verified', true);
    END LOOP;
END $$;

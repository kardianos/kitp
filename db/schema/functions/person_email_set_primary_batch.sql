-- person_email.set_primary — the caller makes one of their verified
-- addresses the primary: the person card's `email`, which mail and digests
-- use. A later sign-in with a new email moves the primary only if it was
-- the previous sign-in email (person_email_note_signin).
CREATE OR REPLACE FUNCTION person_email_set_primary_batch(actor_id bigint, inputs jsonb)
RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx    int;
    _raw    jsonb;
    _email  text;
    _person bigint := account_person(actor_id);
    _agent  boolean := COALESCE((SELECT is_agent FROM user_account WHERE id = actor_id), false);
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _email := lower(btrim(COALESCE(_raw->>'email', '')));
        IF _agent OR _person IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text, 'person_email.set_primary: only the person chooses their primary address'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM person_email WHERE person_card_id = _person AND email = _email AND verified_at IS NOT NULL) THEN
            RETURN QUERY SELECT _idx, false, 'not_verified'::text, 'person_email.set_primary: only a verified address of yours can be the primary'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        PERFORM person_email_set_primary_row(_person, _email, actor_id);
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('email', _email);
    END LOOP;
END $$;

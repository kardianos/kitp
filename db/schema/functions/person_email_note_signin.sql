-- person_email_note_signin — a sign-in's trusted email joins its person's
-- addresses (docs/EMAIL_ADDRESSES.md): added as verified (source 'signin'),
-- unless another person has it verified. The primary — the person card's
-- `email`, what mail and digests use — follows it when it was the login's
-- previous email (p_old), empty, or isn't one of the person's verified
-- addresses (an address typed onto the card before the login was granted,
-- merged in, or while it was revoked; review 2026-11-06 L1); a primary
-- the person chose among their verified addresses stays. Called by the
-- OIDC sign-in (oidc.provisionUser).
CREATE OR REPLACE FUNCTION person_email_note_signin(p_person bigint, p_email text, p_old text, p_actor bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    _email   text := lower(btrim(COALESCE(p_email, '')));
    _old     text := lower(btrim(COALESCE(p_old, '')));
    _def     bigint;
    _primary text;
    _act     bigint;
BEGIN
    IF p_person IS NULL OR _email = '' OR NOT email_plain(_email) THEN
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM person_email
               WHERE email = _email AND verified_at IS NOT NULL AND person_card_id <> p_person) THEN
        RETURN; -- someone else's; this sign-in doesn't take it
    END IF;
    BEGIN
        INSERT INTO person_email (person_card_id, email, source, verified_at)
        VALUES (p_person, _email, 'signin', now())
        ON CONFLICT (person_card_id, email) DO UPDATE
            SET source = 'signin', verified_at = COALESCE(person_email.verified_at, now()),
                verify_code_hash = NULL, verify_expires_at = NULL;
    EXCEPTION WHEN unique_violation THEN
        RETURN; -- verified on someone else since the check
    END;
    SELECT id INTO _def FROM attribute_def WHERE name = 'email';
    SELECT lower(btrim(COALESCE(av.value #>> '{}', ''))) INTO _primary
    FROM attribute_value av WHERE av.card_id = p_person AND av.attribute_def_id = _def;
    _primary := COALESCE(_primary, '');
    IF _primary = _email THEN
        RETURN;
    END IF;
    IF _primary <> '' AND _primary <> _old
       AND EXISTS (SELECT 1 FROM person_email
                   WHERE person_card_id = p_person AND email = _primary AND verified_at IS NOT NULL) THEN
        RETURN; -- one the person chose
    END IF;
    INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
    VALUES (p_person, 'attr_update', _def, CASE WHEN _primary = '' THEN NULL ELSE to_jsonb(_primary) END, to_jsonb(_email), p_actor)
    RETURNING id INTO _act;
    INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
    VALUES (p_person, _def, to_jsonb(_email), _act)
    ON CONFLICT (card_id, attribute_def_id) DO UPDATE
        SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
END $$;

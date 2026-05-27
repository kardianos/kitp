-- person.grant_account handler: link a NEW user_account to an EXISTING person
-- card — i.e. promote an "assignee" (or contact) to a "user" (login). Mirrors
-- person_create_batch's tier='user' account creation, but for a person that
-- already exists. The caller (the People admin screen) sets person_kind='member'
-- separately via attribute.update; this function only mints the account + link.
--
-- Per-row pipeline:
--   1. Decode + validate person_card_id (required; must name a person card).
--   2. Idempotent: if the person already has a user_account_person link, return
--      that account id with ok=true (already a user).
--   3. Resolve display_name (the person's title) + email — the request email
--      override wins, else the person's stored email attribute. Email is
--      required (the OIDC match key). A pre-existing user_account.email collision
--      raises 23505 → the dispatcher maps it to code='conflict'.
--   4. INSERT user_account (oidc_sub NULL — attached on first sign-in) + the
--      user_account_person link.
--
-- Result JSON shape: {"user_account_id": "<bigint>"}.
CREATE OR REPLACE FUNCTION person_grant_account_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (
    idx int,
    ok boolean,
    code text,
    message text,
    result jsonb
) LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _person_id bigint;
    _email_in text;
    _email text;
    _title text;
    _person_ct_id bigint;
    _title_def bigint;
    _email_def bigint;
    _existing bigint;
    _account_id bigint;
BEGIN
    SELECT id INTO _person_ct_id FROM card_type WHERE name = 'person';
    SELECT id INTO _title_def FROM attribute_def WHERE name = 'title';
    SELECT id INTO _email_def FROM attribute_def WHERE name = 'email';
    IF _person_ct_id IS NULL OR _title_def IS NULL OR _email_def IS NULL THEN
        RAISE EXCEPTION 'person.grant_account: required schema rows missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _person_id := NULLIF(_raw->>'person_card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _person_id := NULL;
        END;
        IF _person_id IS NULL OR _person_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'person.grant_account: person_card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM card WHERE id = _person_id AND card_type_id = _person_ct_id
        ) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('person.grant_account: %s is not a person card', _person_id), NULL::jsonb;
            CONTINUE;
        END IF;

        -- Idempotent: already a user → return the existing account.
        SELECT user_account_id INTO _existing
        FROM user_account_person WHERE person_card_id = _person_id;
        IF _existing IS NOT NULL THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('user_account_id', _existing::text);
            CONTINUE;
        END IF;

        -- display_name + email: request override wins, else the person's attrs.
        SELECT value #>> '{}' INTO _title
        FROM attribute_value WHERE card_id = _person_id AND attribute_def_id = _title_def;

        _email_in := COALESCE(_raw->>'email', '');
        IF _email_in <> '' THEN
            _email := lower(btrim(_email_in));
        ELSE
            SELECT lower(btrim(value #>> '{}')) INTO _email
            FROM attribute_value WHERE card_id = _person_id AND attribute_def_id = _email_def;
        END IF;
        IF _email IS NULL OR _email = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'person.grant_account: an email is required to grant a login'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        INSERT INTO user_account (display_name, email)
        VALUES (COALESCE(_title, ''), _email)
        RETURNING id INTO _account_id;
        INSERT INTO user_account_person (user_account_id, person_card_id)
        VALUES (_account_id, _person_id);

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('user_account_id', _account_id::text);
    END LOOP;
END;
$$;

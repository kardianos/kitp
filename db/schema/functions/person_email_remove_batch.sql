-- person_email.remove — take an address off a person's list: the caller's
-- own (person_id omitted), or any person's for a workspace admin. The
-- primary can't be removed while it is the primary; choose another first.
-- A sign-in email removed comes back with that sign-in.
CREATE OR REPLACE FUNCTION person_email_remove_batch(actor_id bigint, inputs jsonb)
RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx     int;
    _raw     jsonb;
    _email   text;
    _person  bigint;
    _own     bigint := account_person(actor_id);
    _agent   boolean := COALESCE((SELECT is_agent FROM user_account WHERE id = actor_id), false);
    _admin   boolean := user_is_global_admin(actor_id);
    _def     bigint := (SELECT id FROM attribute_def WHERE name = 'email');
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _email := lower(btrim(COALESCE(_raw->>'email', '')));
        BEGIN
            _person := COALESCE(NULLIF(_raw->>'person_id', '')::bigint, _own);
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'person_email.remove: person_id must be an id'::text, NULL::jsonb;
            CONTINUE;
        END;
        IF _person IS NULL OR (_person IS DISTINCT FROM _own AND NOT _admin) OR (_agent AND NOT _admin) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text, 'person_email.remove: only the person, or an admin, removes their addresses'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF EXISTS (SELECT 1 FROM attribute_value av WHERE av.card_id = _person AND av.attribute_def_id = _def
                   AND lower(btrim(av.value #>> '{}')) = _email) THEN
            RETURN QUERY SELECT _idx, false, 'primary'::text, 'person_email.remove: that is the primary address; choose another primary first'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        DELETE FROM person_email WHERE person_card_id = _person AND email = _email;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, 'person_email.remove: no such address'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('email', _email);
    END LOOP;
END $$;

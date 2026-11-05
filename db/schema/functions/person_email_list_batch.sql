-- person_email.list — a person's email addresses (docs/EMAIL_ADDRESSES.md):
-- the caller's own (person_id omitted), or any person's for a workspace
-- admin. Each address says where it came from (signin: a sign-in brought
-- it; added: the person added it; card: the person card's email, not on
-- the list), whether it is verified, whether it is the primary (the person
-- card's `email`, what mail and digests use), and when a pending code
-- expires. can_add says whether a mail account sends account emails
-- (account_mail), which adding an address needs.
CREATE OR REPLACE FUNCTION person_email_list_batch(actor_id bigint, inputs jsonb)
RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx     int;
    _raw     jsonb;
    _person  bigint;
    _own     bigint := account_person(actor_id);
    _admin   boolean := user_is_global_admin(actor_id);
    _def     bigint := (SELECT id FROM attribute_def WHERE name = 'email');
    _primary text;
    _sender  boolean := EXISTS (SELECT 1 FROM account_mail m JOIN card c ON c.id = m.channel_id AND c.deleted_at IS NULL);
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _person := COALESCE(NULLIF(_raw->>'person_id', '')::bigint, _own);
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'person_email.list: person_id must be an id'::text, NULL::jsonb;
            CONTINUE;
        END;
        IF _person IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'no_person'::text, 'person_email.list: your account has no person card'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _person IS DISTINCT FROM _own AND NOT _admin THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text, 'person_email.list: only an admin can see another person''s addresses'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT lower(btrim(av.value #>> '{}')) INTO _primary
        FROM attribute_value av WHERE av.card_id = _person AND av.attribute_def_id = _def;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object(
            'person_id', _person::text,
            'primary', COALESCE(_primary, ''),
            'can_add', _sender AND _person IS NOT DISTINCT FROM _own,
            'addresses', COALESCE((
                SELECT jsonb_agg(a ORDER BY a->>'source' <> 'card', a->>'email')
                FROM (
                    SELECT jsonb_build_object(
                               'email', pe.email, 'source', pe.source,
                               'verified', pe.verified_at IS NOT NULL,
                               'primary', pe.email = COALESCE(_primary, ''),
                               'code_expires_at', CASE WHEN pe.verified_at IS NULL THEN pe.verify_expires_at END) AS a
                    FROM person_email pe WHERE pe.person_card_id = _person
                    UNION ALL
                    SELECT jsonb_build_object('email', _primary, 'source', 'card', 'verified', true, 'primary', true,
                                              'code_expires_at', NULL)
                    WHERE COALESCE(_primary, '') <> ''
                      AND NOT EXISTS (SELECT 1 FROM person_email pe WHERE pe.person_card_id = _person AND pe.email = _primary)
                ) x), '[]'::jsonb));
    END LOOP;
END $$;

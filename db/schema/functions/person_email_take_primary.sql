-- person_email_take_primary — make an address a person's primary (the
-- person card's `email`, what mail and digests use), with an activity row;
-- nothing when it already is. person.grant_account gives a new login's
-- email the primary: the card's was typed by whoever edited the contact
-- (review 2026-11-06 L1).
CREATE OR REPLACE FUNCTION person_email_take_primary(p_person bigint, p_email text, p_actor bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    _email   text := lower(btrim(COALESCE(p_email, '')));
    _def     bigint := (SELECT id FROM attribute_def WHERE name = 'email');
    _primary text;
    _act     bigint;
BEGIN
    IF p_person IS NULL OR _email = '' OR _def IS NULL THEN
        RETURN;
    END IF;
    SELECT lower(btrim(COALESCE(av.value #>> '{}', ''))) INTO _primary
    FROM attribute_value av WHERE av.card_id = p_person AND av.attribute_def_id = _def;
    IF COALESCE(_primary, '') = _email THEN
        RETURN;
    END IF;
    INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
    VALUES (p_person, 'attr_update', _def,
            CASE WHEN COALESCE(_primary, '') = '' THEN NULL ELSE to_jsonb(_primary) END, to_jsonb(_email), p_actor)
    RETURNING id INTO _act;
    INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
    VALUES (p_person, _def, to_jsonb(_email), _act)
    ON CONFLICT (card_id, attribute_def_id) DO UPDATE
        SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
END $$;

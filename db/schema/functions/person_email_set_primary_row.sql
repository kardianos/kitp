-- person_email_set_primary_row — make one of a person's addresses the
-- primary: the person card's `email`, with its activity row. Shared by
-- person_email.set_primary and person_email.remove (which never leaves the
-- primary pointing at a removed address).
CREATE OR REPLACE FUNCTION person_email_set_primary_row(p_person bigint, p_email text, p_actor bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    _def bigint;
    _old text;
    _act bigint;
BEGIN
    SELECT id INTO _def FROM attribute_def WHERE name = 'email';
    SELECT av.value #>> '{}' INTO _old FROM attribute_value av WHERE av.card_id = p_person AND av.attribute_def_id = _def;
    IF lower(COALESCE(_old, '')) = lower(p_email) THEN
        RETURN;
    END IF;
    INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
    VALUES (p_person, 'attr_update', _def, CASE WHEN _old IS NULL THEN NULL ELSE to_jsonb(_old) END, to_jsonb(p_email), p_actor)
    RETURNING id INTO _act;
    INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
    VALUES (p_person, _def, to_jsonb(p_email), _act)
    ON CONFLICT (card_id, attribute_def_id) DO UPDATE
        SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
END $$;

-- comm_author_join — the author of a message sent from kitp joins the thread.
--
-- A message written here (reply.post, or comm.create's initial message) is from
-- the author's person, so a later reply by anyone else must go to them too. This
-- is the union an inbound sender already gets (syncCommRecipientsFromInbound):
-- the person is appended to comm.comm_recipients when missing, and nobody is
-- ever removed. Callers run it AFTER taking the message's To: snapshot, so the
-- author is not sent their own message.
--
-- An agent writes for its owner, so the owner's person joins. A user with no
-- person card, or a person with no email (the System user), cannot be sent
-- anything and is left off.
--
-- Returns true when the person was added.
CREATE OR REPLACE FUNCTION comm_author_join(
    comm_id bigint,
    author_id bigint
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
    _recipients_def bigint;
    _person bigint;
    _old jsonb;
    _new jsonb;
    _activity_id bigint;
BEGIN
    SELECT id INTO _recipients_def FROM attribute_def WHERE name = 'comm_recipients';
    IF _recipients_def IS NULL THEN
        RAISE EXCEPTION 'comm_author_join: attribute_def comm_recipients missing'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT uap.person_card_id
      INTO _person
    FROM user_account ua
    JOIN user_account_person uap
      ON uap.user_account_id = CASE WHEN ua.is_agent THEN ua.parent_user_id ELSE ua.id END
    JOIN card p ON p.id = uap.person_card_id AND p.deleted_at IS NULL
    WHERE ua.id = comm_author_join.author_id
      AND EXISTS (
          SELECT 1
          FROM attribute_value pav
          JOIN attribute_def pad ON pad.id = pav.attribute_def_id AND pad.name = 'email'
          WHERE pav.card_id = uap.person_card_id
            AND COALESCE(pav.value #>> '{}', '') <> ''
      );
    IF _person IS NULL THEN
        RETURN false;
    END IF;

    SELECT av.value INTO _old
    FROM attribute_value av
    WHERE av.card_id = comm_author_join.comm_id
      AND av.attribute_def_id = _recipients_def;
    IF _old IS NULL OR jsonb_typeof(_old) <> 'array' THEN
        _old := '[]'::jsonb;
    END IF;
    -- A numeric string is tolerated on read, as decodeCardRefArray does.
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(_old) AS e(v)
        WHERE (e.v #>> '{}') = _person::text
    ) THEN
        RETURN false;
    END IF;

    _new := _old || jsonb_build_array(to_jsonb(_person));
    INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
    VALUES (comm_author_join.comm_id, 'attr_update', _recipients_def, NULL, _new,
            comm_author_join.author_id)
    RETURNING id INTO _activity_id;
    INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
    VALUES (comm_author_join.comm_id, _recipients_def, _new, _activity_id)
    ON CONFLICT (card_id, attribute_def_id) DO UPDATE
        SET value = EXCLUDED.value,
            last_activity_id = EXCLUDED.last_activity_id;
    RETURN true;
END;
$$;

-- comm_confirm — people on a thread whom kitp may send its messages on to.
--
-- The relay (internal/dom/comm/relay.go, docs/MAIL_INTAKE_AND_CALENDARS.md
-- "Sending replies on") sends an emailed reply on only between confirmed
-- people, and nothing a received message says can confirm anyone: its From,
-- To and Cc are not authenticated (review 2026-11-03 round 2 #1). A person is
-- confirmed by something done in kitp:
--   - a person in kitp added them to the thread (comm.create's recipients,
--     comm.set_recipients — only the people it adds, not those already on);
--   - they started the thread by writing to the account (the intake's first
--     message, which is what the thread is);
--   - a message written in kitp was sent to them (read from the messages
--     themselves, so nothing is stored for it).
-- The first two are kept here, in comm.comm_confirmed (person ids, union
-- only). Nobody but kitp writes it (attribute.update and card.insert refuse
-- it). No activity row: comm_recipients' own row records the change.
CREATE OR REPLACE FUNCTION comm_confirm(
    comm_id bigint,
    people bigint[]
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    _def bigint;
    _old jsonb;
BEGIN
    IF people IS NULL OR cardinality(people) = 0 THEN
        RETURN;
    END IF;
    SELECT id INTO _def FROM attribute_def WHERE name = 'comm_confirmed';
    IF _def IS NULL THEN
        RAISE EXCEPTION 'comm_confirm: attribute_def comm_confirmed missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT av.value INTO _old
    FROM attribute_value av
    WHERE av.card_id = comm_confirm.comm_id AND av.attribute_def_id = _def;
    IF _old IS NULL OR jsonb_typeof(_old) <> 'array' THEN
        _old := '[]'::jsonb;
    END IF;
    INSERT INTO attribute_value (card_id, attribute_def_id, value)
    SELECT comm_confirm.comm_id, _def, COALESCE(jsonb_agg(to_jsonb(id) ORDER BY first_ord), '[]'::jsonb)
    FROM (
        SELECT id, min(ord) AS first_ord
        FROM (
            SELECT (e.v #>> '{}')::bigint AS id, e.ord
            FROM jsonb_array_elements(_old) WITH ORDINALITY AS e(v, ord)
            WHERE (e.v #>> '{}') ~ '^[0-9]{1,18}$'
            UNION ALL
            SELECT p.id, 1000000 + p.ord
            FROM unnest(people) WITH ORDINALITY AS p(id, ord)
            WHERE p.id IS NOT NULL
        ) all_ids
        GROUP BY id
    ) merged
    ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value;
END;
$$;

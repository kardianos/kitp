-- comm_remove — people a person in kitp took off a thread
-- (comm.set_recipients). They lose their relay confirmation (comm_confirm)
-- and are kept in comm.comm_removed, so mail they send to the thread later
-- doesn't put them back on its recipients: it is still filed, but they get
-- neither staff replies nor other people's messages until someone in kitp
-- adds them again (review 2026-11-03 round 3 #8). Only kitp writes
-- comm_removed (attribute.update and card.insert refuse it).
CREATE OR REPLACE FUNCTION comm_remove(
    comm_id bigint,
    people bigint[]
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF people IS NULL OR cardinality(people) = 0 THEN
        RETURN;
    END IF;
    PERFORM comm_people_edit(comm_remove.comm_id, 'comm_confirmed', NULL, people);
    PERFORM comm_people_edit(comm_remove.comm_id, 'comm_removed', people, NULL);
END;
$$;

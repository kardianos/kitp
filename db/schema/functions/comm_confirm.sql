-- comm_confirm — people on a thread whom kitp may send its messages on to.
--
-- The relay (internal/dom/comm/relay.go, docs/MAIL_INTAKE_AND_CALENDARS.md
-- "Sending replies on") sends an emailed reply on only between confirmed
-- people, and nothing a received message says can confirm anyone: its From,
-- To and Cc are not authenticated (review 2026-11-03 round 2 #1). A person is
-- confirmed by something done in kitp, and only that:
--   - a person in kitp added them to the thread (comm.create's recipients,
--     comm.set_recipients — only the people it adds, not those already on);
--   - they started the thread by writing to the account (the intake's first
--     message, which is what the thread is).
-- A staff reply confirms nobody: reply.post writes to everyone on the
-- thread, including whoever a received message put there (round 3 #5).
-- Confirmed people are kept in comm.comm_confirmed (person ids). Nobody but
-- kitp writes it (attribute.update and card.insert refuse it). Confirming
-- someone also clears them from comm.comm_removed (comm_remove), since
-- kitp has just put them back on.
CREATE OR REPLACE FUNCTION comm_confirm(
    comm_id bigint,
    people bigint[]
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF people IS NULL OR cardinality(people) = 0 THEN
        RETURN;
    END IF;
    PERFORM comm_people_edit(comm_confirm.comm_id, 'comm_confirmed', people, NULL);
    PERFORM comm_people_edit(comm_confirm.comm_id, 'comm_removed', NULL, people);
END;
$$;

-- card_list_lock — the lock every read-modify-write of a card's kitp-kept
-- lists takes first: a thread's replies, comm_recipients, comm_confirmed and
-- comm_removed, a task's comms. Each is read, changed and written back
-- whole, so two writers at once — a customer's mail being filed while staff
-- press Send, two staff replying, a recipient change during filing — each
-- wrote the list it had read and one lost the other's message or change
-- (review 2026-11-06 round 8 #2). Taken first, the lock makes the second
-- writer wait for the first to commit; its read (a later statement, a fresh
-- snapshot under READ COMMITTED) then sees the first one's list.
--
-- FOR NO KEY UPDATE, not FOR UPDATE: it doesn't block the key-share locks a
-- foreign-key check takes, so inserting a thread's messages, values and
-- activity rows doesn't wait on it. Several cards are locked in id order,
-- so two writers that each need two (comm.attach between tasks) can't
-- deadlock. Held until the transaction ends.
CREATE OR REPLACE FUNCTION card_list_lock(_cards bigint[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM card c WHERE c.id = ANY(_cards) ORDER BY c.id FOR NO KEY UPDATE;
END;
$$;

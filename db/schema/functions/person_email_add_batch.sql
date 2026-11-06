-- person_email.add — the caller adds an address of their own, to verify by
-- the code mailed to it (docs/EMAIL_ADDRESSES.md). code_hash is set by the
-- handler's PreRun (never from the wire); its PostRun mails the code
-- through the account-mail account (sender_channel_id). Refused: an agent
-- (its owner adds theirs), an address that isn't a plain one, one already
-- verified (on this person, or another — in_use), no account-mail account
-- (no_sender), more than 20 addresses, or past a send limit
-- (person_email_code_sent: 5 codes an hour per person; per address 1 a
-- minute and 5 a day, whoever asks — review 2026-11-06 #7). Adding a
-- pending address again sends a new code (24 hours).
--
-- The limits hold under concurrency and failure (round 8 #5): the person
-- and the address are locked (advisory, to the end of the transaction)
-- before they are counted, so a second request waits for the first; and a
-- send is recorded in person_email_code_sent by the handler's PostRun on
-- its own connection just before the mail goes out, so a batch that fails
-- after sending — and rolls back — still counts it. Within one batch the
-- earlier sub-requests are counted here (_batch_*).
--
-- An address verified on someone else is answered like any other — the
-- address is pending on the caller's list — but no code goes out (`send`
-- false; the handler's output hides it): add must not tell whose an
-- address is (review 2026-11-06 L2). Verified on the caller themselves:
-- already_verified.
CREATE OR REPLACE FUNCTION person_email_add_batch(actor_id bigint, inputs jsonb)
RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx    int;
    _raw    jsonb;
    _email  text;
    _hash   text;
    _person bigint := account_person(actor_id);
    _taken  boolean;
    _agent  boolean := COALESCE((SELECT is_agent FROM user_account WHERE id = actor_id), false);
    _sender bigint := (SELECT m.channel_id FROM account_mail m JOIN card c ON c.id = m.channel_id AND c.deleted_at IS NULL);
    _batch_emails text[] := ARRAY[]::text[]; -- this batch's sends, in order
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _email := lower(btrim(COALESCE(_raw->>'email', '')));
        _hash := COALESCE(_raw->>'code_hash', '');
        IF _agent THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text, 'person_email.add: an agent can''t add addresses; its owner adds theirs'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _person IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'no_person'::text, 'person_email.add: your account has no person card'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _email = '' OR length(_email) > 320 OR NOT email_plain(_email) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'person_email.add: that isn''t an email address kitp can send to'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _hash !~ '^[0-9a-f]{64}$' THEN
            RETURN QUERY SELECT _idx, false, 'internal'::text, 'person_email.add: no code'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _sender IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'no_sender'::text, 'person_email.add: no mail account sends account emails; ask an admin to choose one'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF EXISTS (SELECT 1 FROM person_email WHERE email = _email AND person_card_id = _person AND verified_at IS NOT NULL) THEN
            RETURN QUERY SELECT _idx, false, 'already_verified'::text,
                'person_email.add: that address is already verified'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _taken := EXISTS (SELECT 1 FROM person_email WHERE email = _email AND verified_at IS NOT NULL);
        IF (SELECT count(*) FROM person_email WHERE person_card_id = _person) >= 20
           AND NOT EXISTS (SELECT 1 FROM person_email WHERE person_card_id = _person AND email = _email) THEN
            RETURN QUERY SELECT _idx, false, 'limit'::text, 'person_email.add: at most 20 addresses'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        -- The send log, not the address rows: re-adding one address, or
        -- adding and removing fresh ones, sent without limit (review
        -- 2026-11-06 #7). Earlier sub-requests of this batch count too.
        -- Person first, then address: every request locks in that order.
        PERFORM pg_advisory_xact_lock(hashtextextended('kitp.person_email_code.person:' || _person, 0));
        PERFORM pg_advisory_xact_lock(hashtextextended('kitp.person_email_code.email:' || _email, 0));
        IF (SELECT count(*) FROM person_email_code_sent
            WHERE person_card_id = _person AND sent_at > now() - interval '1 hour')
           + cardinality(_batch_emails) >= 5 THEN
            RETURN QUERY SELECT _idx, false, 'limit'::text, 'person_email.add: at most 5 codes an hour; try again later'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _email = ANY(_batch_emails) OR EXISTS (SELECT 1 FROM person_email_code_sent
                   WHERE email = _email AND sent_at > now() - interval '1 minute') THEN
            RETURN QUERY SELECT _idx, false, 'limit'::text, 'person_email.add: a code went to that address a moment ago; wait a minute'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF (SELECT count(*) FROM person_email_code_sent
            WHERE email = _email AND sent_at > now() - interval '1 day') >= 5 THEN
            RETURN QUERY SELECT _idx, false, 'limit'::text, 'person_email.add: at most 5 codes a day to one address; try again tomorrow'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        INSERT INTO person_email (person_card_id, email, source, verify_code_hash, verify_expires_at, verify_sent_at)
        VALUES (_person, _email, 'added', _hash, now() + interval '24 hours', now())
        ON CONFLICT (person_card_id, email) DO UPDATE
            SET verify_code_hash = EXCLUDED.verify_code_hash, verify_expires_at = EXCLUDED.verify_expires_at,
                verify_sent_at = EXCLUDED.verify_sent_at;
        -- Counted by the PostRun (personemail.recordCodeSend), on its own
        -- connection, as the mail goes: see above.
        _batch_emails := array_append(_batch_emails, _email);
        DELETE FROM person_email_code_sent WHERE sent_at < now() - interval '1 day';
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('email', _email, 'sender_channel_id', _sender::text, 'send', NOT _taken,
                               'person_card_id', _person::text);
    END LOOP;
END $$;

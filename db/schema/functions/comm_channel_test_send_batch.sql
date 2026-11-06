-- comm_channel.test_send — workspace admin: check a mail account's way out
-- by mailing the caller a short test message (the handler's PostRun sends
-- it, through the account's send method; docs/MAIL_INTAKE_AND_CALENDARS.md,
-- "Sending"). The SQL checks the account and finds where the message goes:
-- the caller's primary email. Refused: not a live mail account
-- (channel_not_found), no way out yet (cannot_send), the caller has no
-- email kitp can send to (no_email).
CREATE OR REPLACE FUNCTION comm_channel_test_send_batch(actor_id bigint, inputs jsonb)
RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx     int;
    _raw     jsonb;
    _channel bigint;
    _to      text;
BEGIN
    _to := lower(btrim(COALESCE((
        SELECT av.value #>> '{}' FROM attribute_value av
        JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'email'
        WHERE av.card_id = account_person(comm_channel_test_send_batch.actor_id)), '')));
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _channel := NULLIF(_raw->>'channel_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _channel := NULL;
        END;
        IF _channel IS NULL OR NOT EXISTS (
            SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'comm_channel'
            WHERE c.id = _channel AND c.deleted_at IS NULL) THEN
            RETURN QUERY SELECT _idx, false, 'channel_not_found'::text,
                'comm_channel.test_send: no such mail account'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT channel_can_send(_channel) THEN
            RETURN QUERY SELECT _idx, false, 'cannot_send'::text,
                'comm_channel.test_send: this mail account has no way out yet — choose how it sends, fill in what that needs and a From address, and save'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _to = '' OR NOT email_plain(_to) THEN
            RETURN QUERY SELECT _idx, false, 'no_email'::text,
                'comm_channel.test_send: your account has no email address to send the test to'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('channel_id', _channel::text, 'to', _to);
    END LOOP;
END $$;

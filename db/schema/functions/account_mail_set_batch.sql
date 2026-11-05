-- account_mail.set — admin: choose the mail account (a live comm_channel)
-- that sends account emails, or none (channel_id empty).
CREATE OR REPLACE FUNCTION account_mail_set_batch(actor_id bigint, inputs jsonb)
RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx     int;
    _raw     jsonb;
    _channel bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _channel := NULLIF(_raw->>'channel_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'account_mail.set: channel_id must be an id'::text, NULL::jsonb;
            CONTINUE;
        END;
        IF _channel IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _channel AND ct.name = 'comm_channel' AND c.deleted_at IS NULL) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'account_mail.set: no such mail account'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        INSERT INTO account_mail (singleton, channel_id, changed_at, changed_by)
        VALUES (true, _channel, now(), actor_id)
        ON CONFLICT (singleton) DO UPDATE
            SET channel_id = EXCLUDED.channel_id, changed_at = EXCLUDED.changed_at, changed_by = EXCLUDED.changed_by;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('channel_id', COALESCE(_channel::text, ''));
    END LOOP;
END $$;

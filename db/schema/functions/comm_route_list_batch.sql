-- comm_route.list — the inbound routes (POST URLs, SMTP addresses) of one
-- mail account, newest first, with what the Comm Channels page shows: the
-- comment, the token's first characters (the token itself is never stored),
-- the filters, and the last message / refusal. Admin only (the Go Authz).
-- docs/MAIL_INTAKE_AND_CALENDARS.md §5.
CREATE OR REPLACE FUNCTION comm_route_list_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _channel bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'channel_id', '') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'comm_route.list: channel_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _channel := (_raw->>'channel_id')::bigint;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('routes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', a.id::text,
                'channel_id', a.card_id::text,
                'purpose', a.purpose,
                'provider', a.provider,
                'comment', a.comment,
                'hint', a.hint,
                'policy', a.policy,
                'has_signing_key', a.signing_key IS NOT NULL,
                'created_at', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'last_used_at', COALESCE(to_char(a.last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
                'last_client', a.last_client,
                'last_error', a.last_error,
                'last_error_at', COALESCE(to_char(a.last_error_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
            ) ORDER BY a.id DESC)
            FROM card_access a
            WHERE a.card_id = _channel AND a.purpose IN ('inbound_post', 'inbound_smtp')
        ), '[]'::jsonb));
    END LOOP;
END;
$$;

-- oauth_client.list: the OAuth clients kitp trusts, and members' requests
-- for ones it doesn't (docs/MCP_OAUTH.md), for the admin MCP apps screen.
--
-- One input → one result row; every input gets the same snapshot.
--
-- A row is WAITING when it isn't allowed and a member asked after the last
-- admin decision on it. Waiting rows come first (newest request first),
-- then allowed ones, then the rest, each by client_id.
--
-- request_note is set only on a row that isn't allowed, and allowed_note
-- only on one that is: the screen pairs each with the button that flips
-- it (Allow / Stop allowing).
--
-- Authz (global admin) runs pre-tx in Go.
--
-- Result JSON shape matches `oauthclient.ListOutput`.
CREATE OR REPLACE FUNCTION oauth_client_list_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (
    idx int,
    ok boolean,
    code text,
    message text,
    result jsonb
) LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _payload jsonb;
BEGIN
    WITH c AS (
        SELECT oc.*,
               rq.display_name AS requested_by_name,
               dc.display_name AS decided_by_name,
               (NOT oc.allowed AND oc.requested_at IS NOT NULL
                AND (oc.decided_at IS NULL OR oc.requested_at > oc.decided_at)) AS waiting
        FROM oauth_client oc
        LEFT JOIN user_account rq ON rq.id = oc.requested_by
        LEFT JOIN user_account dc ON dc.id = oc.decided_by
    )
    SELECT jsonb_build_object('rows', COALESCE(jsonb_agg(
        jsonb_build_object(
            'id',                c.id::text,
            'client_id',         c.client_id,
            'covers',            CASE WHEN right(c.client_id, 1) = '/'
                                      THEN 'Every client published under this address'
                                      ELSE 'This client only' END,
            'allowed',           c.allowed,
            'waiting',           c.waiting,
            'status',            CASE WHEN c.allowed THEN 'Allowed'
                                      WHEN c.waiting THEN 'Waiting for an admin'
                                      ELSE 'Not allowed' END,
            'redirect_uri',      c.redirect_uri,
            'requested_by',      c.requested_by::text,
            'requested_by_name', COALESCE(c.requested_by_name, ''),
            'requested_at',      to_char(c.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'request_count',     c.request_count,
            'decided_by_name',   COALESCE(c.decided_by_name, ''),
            'decided_at',        to_char(c.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'request_note',      CASE
                WHEN c.allowed THEN ''
                WHEN c.waiting THEN format('Asked by %s on %s%s',
                    COALESCE(c.requested_by_name, 'a member who has since left'),
                    to_char(c.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
                    CASE WHEN c.request_count > 1 THEN format(' (%s times)', c.request_count) ELSE '' END)
                WHEN c.decided_at IS NOT NULL THEN format('Not allowed (by %s on %s)',
                    COALESCE(c.decided_by_name, 'an admin'),
                    to_char(c.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
                ELSE 'Not allowed'
                END,
            'allowed_note',      CASE
                WHEN NOT c.allowed THEN ''
                WHEN c.decided_at IS NULL THEN 'Allowed'
                ELSE format('Allowed by %s on %s', COALESCE(c.decided_by_name, 'an admin'),
                    to_char(c.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
                END
        ) ORDER BY NOT c.waiting, NOT c.allowed, c.requested_at DESC NULLS LAST, c.client_id
    ), '[]'::jsonb))
    INTO _payload
    FROM c;

    FOR _idx IN
        SELECT (r.ord - 1)::int
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

-- oauth_client.set: allow or disallow one OAuth client (docs/MCP_OAUTH.md).
-- The row is named by id (one the list returned: the MCP apps screen's
-- Allow / Stop allowing) or by client_id (the screen's "Allow a client"
-- form; one not yet listed is added). Either way the actor is recorded as
-- the one who decided.
--
-- client_id is what kitp compares with a client's published client_id:
-- an exact client_id, or a prefix ending in / that covers every client_id
-- under it. It must be https with a DNS host name (two or more labels, the
-- last starting with a letter: no IP literal, no localhost) and an optional
-- port, then a path; no query, fragment, user info, white space, ";",
-- empty segments, or dot segments (encoded or not). The scheme and host are lower-cased; the path
-- is kept as given. internal/auth/oauth normalises a presented client_id
-- the same way before comparing.
--
-- Authz (global admin) runs pre-tx in Go.
--
-- Result JSON shape matches `oauthclient.SetOutput`:
--   {"id": "<bigint>", "client_id": "...", "allowed": <bool>}
CREATE OR REPLACE FUNCTION oauth_client_set_batch(
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
    _raw jsonb;
    _id bigint;
    _cid text;
    _authority text;
    _path text;
    _allowed boolean;
    _out_id bigint;
    _out_cid text;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _id := NULLIF(_raw->>'id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'oauth_client.set: id must be a number'::text, NULL::jsonb;
            CONTINUE;
        END;
        IF jsonb_typeof(_raw->'allowed') IS DISTINCT FROM 'boolean' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'oauth_client.set: allowed (true or false) is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _allowed := (_raw->>'allowed')::boolean;

        IF _id IS NOT NULL THEN
            UPDATE oauth_client
            SET allowed = _allowed, decided_by = oauth_client_set_batch.actor_id, decided_at = now()
            WHERE id = _id
            RETURNING oauth_client.id, oauth_client.client_id INTO _out_id, _out_cid;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'not_found'::text,
                    format('oauth_client.set: client %s not found', _id), NULL::jsonb;
                CONTINUE;
            END IF;
        ELSE
            _cid := btrim(COALESCE(_raw->>'client_id', ''));
            IF _cid = '' THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'oauth_client.set: id or client_id is required'::text, NULL::jsonb;
                CONTINUE;
            END IF;
            _authority := lower(substring(_cid FROM '^([A-Za-z]+://[^/]*)'));
            _path := substring(_cid FROM '^[A-Za-z]+://[^/]*(/.*)$');
            IF length(_cid) > 2048 OR _authority IS NULL OR _path IS NULL
               OR _authority !~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?(:[0-9]{1,5})?$'
               OR _path ~ '[\s?#;\\]' OR _path ~* '%2e' OR _path ~ '//'
               OR _path ~ '(^|/)\.\.?(/|$)' THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('oauth_client.set: %L is not a client ID: give the https address the app publishes its details at (e.g. https://mcp.example.com/oauth/client.json), or one ending in / to trust every client under it', _cid),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            _cid := _authority || _path;
            INSERT INTO oauth_client (client_id, allowed, decided_by, decided_at)
            VALUES (_cid, _allowed, oauth_client_set_batch.actor_id, now())
            ON CONFLICT (client_id) DO UPDATE
                SET allowed = EXCLUDED.allowed, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at
            RETURNING oauth_client.id, oauth_client.client_id INTO _out_id, _out_cid;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('id', _out_id::text, 'client_id', _out_cid, 'allowed', _allowed);
    END LOOP;
END;
$$;

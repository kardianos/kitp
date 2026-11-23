-- oauth_client.delete: remove one OAuth client row by id
-- (docs/MCP_OAUTH.md). A removed client is no longer trusted, like a
-- disallowed one, and ends its connections at their next refresh; a member
-- who asks for it later records it again.
--
-- Authz (global admin) runs pre-tx in Go.
--
-- Result JSON shape matches `oauthclient.DeleteOutput`:
--   {"ok": <bool>, "deleted": <int>}
CREATE OR REPLACE FUNCTION oauth_client_delete_batch(
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
    _deleted int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _id := NULLIF(_raw->>'id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _id := NULL;
        END;
        IF _id IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'oauth_client.delete: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        WITH del AS (
            DELETE FROM oauth_client WHERE id = _id RETURNING id
        )
        SELECT count(*)::int INTO _deleted FROM del;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('ok', _deleted > 0, 'deleted', _deleted);
    END LOOP;
END;
$$;

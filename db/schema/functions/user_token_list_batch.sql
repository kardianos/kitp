-- user_token.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runList into one PL/pgSQL body.
--
-- One input → one result row. Lists every user_token row bound to
-- input.user_id (labels + timestamps ONLY — the secret value never
-- leaves the create path). Ordered by created_at DESC.
--
-- Authz (parent_user_id or global admin) runs pre-tx in Go.
--
-- Result JSON shape matches `usertoken.ListOutput`:
--   {"rows": [{"label": "...", "created_at": "<RFC3339>",
--             "last_used_at": "<RFC3339>",
--             "expires_at": "<RFC3339>"|null,
--             "revoked_at": "<RFC3339>"|null}]}
CREATE OR REPLACE FUNCTION user_token_list_batch(
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
    _user_id bigint;
    _payload jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _user_id := NULLIF(_raw->>'user_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _user_id := NULL;
        END;

        IF _user_id IS NULL OR _user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_token.list: user_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'label', ut.label,
                    'created_at',
                        to_char(ut.created_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'last_used_at',
                        to_char(ut.last_used_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'expires_at',
                        CASE WHEN ut.expires_at IS NULL THEN NULL::jsonb
                             ELSE to_jsonb(to_char(ut.expires_at AT TIME ZONE 'UTC',
                                                   'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                        END,
                    'revoked_at',
                        CASE WHEN ut.revoked_at IS NULL THEN NULL::jsonb
                             ELSE to_jsonb(to_char(ut.revoked_at AT TIME ZONE 'UTC',
                                                   'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                        END
                ) ORDER BY ut.created_at DESC, ut.label
            )
            FROM user_token ut
            WHERE ut.user_id = _user_id
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

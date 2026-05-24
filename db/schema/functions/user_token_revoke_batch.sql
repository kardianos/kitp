-- user_token.revoke handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runRevoke into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: user_id and label are required.
--   2. UPDATE user_token SET revoked_at = now() WHERE (user_id, label)
--      matches and revoked_at IS NULL. Idempotent: a row already
--      revoked or absent reports deleted=0 with no error.
--
-- Authz (parent_user_id or global admin) runs pre-tx in Go.
--
-- Result JSON shape matches `usertoken.RevokeOutput`:
--   {"ok": <bool>, "deleted": <0|1>}
CREATE OR REPLACE FUNCTION user_token_revoke_batch(
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
    _user_id bigint;
    _label text;
    _raw jsonb;
    _updated int;
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
        _label := _raw->>'label';

        IF _user_id IS NULL OR _user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_token.revoke: user_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _label IS NULL OR _label = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_token.revoke: label is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        WITH upd AS (
            UPDATE user_token SET revoked_at = now()
            WHERE user_id = _user_id
              AND label = _label
              AND revoked_at IS NULL
            RETURNING id
        )
        SELECT count(*)::int INTO _updated FROM upd;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', _updated > 0,
                'deleted', _updated
            );
    END LOOP;
END;
$$;

-- user_token.create handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runCreate into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: user_id and label are required. expires_at, when
--      present, must parse as an ISO-8601 / RFC3339 timestamp; an
--      invalid string surfaces 'validation'.
--   2. Mint the secret value: 32 random bytes (pgcrypto's
--      gen_random_bytes) base64url-encoded (rtrim '=' padding, then
--      '+' -> '-', '/' -> '_'). Shape matches Go-side
--      base64.RawURLEncoding.EncodeToString.
--   3. INSERT into user_token. The (user_id, label) unique constraint
--      catches duplicate labels per user; a 23505 conflict propagates
--      as the dispatcher's `conflict` code.
--
-- The secret value is surfaced in the result jsonb on this single call
-- only (the server cannot recover it later — same as the legacy Go
-- handler). list / revoke address rows by (user_id, label).
--
-- Authz (parent_user_id or global admin) runs pre-tx in Go.
--
-- Result JSON shape matches `usertoken.CreateOutput`:
--   {"token": "<opaque>", "label": "<echo>"}
CREATE OR REPLACE FUNCTION user_token_create_batch(
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
    _label text;
    _expires_raw text;
    _expires_at timestamptz;
    _token text;
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
        _expires_raw := _raw->>'expires_at';

        IF _user_id IS NULL OR _user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_token.create: user_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _label IS NULL OR _label = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_token.create: label is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        _expires_at := NULL;
        IF _expires_raw IS NOT NULL AND _expires_raw <> '' THEN
            BEGIN
                _expires_at := _expires_raw::timestamptz;
            EXCEPTION WHEN OTHERS THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('user_token.create: bad expires_at: %s', _expires_raw),
                    NULL::jsonb;
                CONTINUE;
            END;
        END IF;

        -- Mint 32 random bytes, base64url-encode (no padding,
        -- '+' -> '-', '/' -> '_'). Matches the Go-side
        -- base64.RawURLEncoding.EncodeToString surface.
        _token := translate(
            rtrim(encode(gen_random_bytes(32), 'base64'), '='),
            '+/', '-_');

        INSERT INTO user_token (id, user_id, label, expires_at)
        VALUES (_token, _user_id, _label, _expires_at);

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'token', _token,
                'label', _label
            );
    END LOOP;
END;
$$;

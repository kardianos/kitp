-- user.set_display_name handler. Bumps user_account.display_name for one
-- user_account row. The /auth/me probe reads display_name straight from this
-- column, so this is the column that powers the shell's signed-in user chip;
-- renaming the linked person card (attribute.update on title) does NOT
-- propagate here, which is why the People admin row's Name commit fires this
-- alongside the person-title update when the row is tier 'user'.
--
-- Per-row pipeline:
--   1. Validation: user_account_id required + non-zero; display_name
--      required + non-empty after trim (the column is NOT NULL).
--   2. UPDATE user_account.display_name; report whether anything changed
--      (the WHERE … AND display_name <> _new clause makes the update a
--      no-op when the value already matches, mirroring user.unlink_person's
--      idempotent "deleted=false" path).
--
-- Admin gate runs pre-tx via the dispatcher's AllowedRoles=['admin'].
--
-- Result JSON shape matches `user.SetDisplayNameOutput`:
--   {"updated": <bool>}
CREATE OR REPLACE FUNCTION user_set_display_name_batch(
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
    _new text;
    _updated int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _user_id := NULLIF(_raw->>'user_account_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _user_id := NULL;
        END;
        IF _user_id IS NULL OR _user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user.set_display_name: user_account_id is required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        _new := COALESCE(_raw->>'display_name', '');
        _new := btrim(_new);
        IF _new = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user.set_display_name: display_name is required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        WITH upd AS (
            UPDATE user_account
            SET display_name = _new
            WHERE id = _user_id
              AND display_name <> _new
            RETURNING id
        )
        SELECT count(*)::int INTO _updated FROM upd;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'updated', _updated > 0
            );
    END LOOP;
END;
$$;

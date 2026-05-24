-- user.unlink_person handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runUnlinkPerson into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: user_account_id is required.
--   2. DELETE FROM user_account_person WHERE user_account_id = _id.
--      Idempotent: an absent link reports deleted=false with no error
--      (matches the "Idempotent: deleting an absent link succeeds with
--      deleted=false" docstring).
--
-- Admin gate runs pre-tx via the dispatcher's AllowedRoles=['admin'].
--
-- Result JSON shape matches `user.UnlinkPersonOutput`:
--   {"deleted": <bool>}
CREATE OR REPLACE FUNCTION user_unlink_person_batch(
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
    _deleted int;
BEGIN
    FOR _idx, _user_id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'user_account_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _user_id IS NULL OR _user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user.unlink_person: user_account_id is required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        WITH del AS (
            DELETE FROM user_account_person
            WHERE user_account_id = _user_id
            RETURNING user_account_id
        )
        SELECT count(*)::int INTO _deleted FROM del;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'deleted', _deleted > 0
            );
    END LOOP;
END;
$$;

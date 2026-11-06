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

        -- The person's addresses go with the login: they are what its
        -- sign-ins brought and its owner verified. Kept, nobody could add
        -- them again — the person's next login included — and mail from
        -- them filed as this person (review 2026-11-06 L11). The card's
        -- email stays, as a contact's. Not while another live login is
        -- the same person's.
        DELETE FROM person_email pe
        WHERE pe.person_card_id = (SELECT uap.person_card_id FROM user_account_person uap
                                   WHERE uap.user_account_id = _user_id)
          AND NOT EXISTS (
              SELECT 1 FROM user_account_person o JOIN user_account ua ON ua.id = o.user_account_id
              WHERE o.person_card_id = pe.person_card_id AND o.user_account_id <> _user_id
                AND ua.deleted_at IS NULL AND ua.login_revoked_at IS NULL);

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

-- user.restore_login — let a revoked login sign in again (the Users
-- screen's "Allow sign-in again"; review 2026-11-03 round 4 #12). The
-- account was refused at sign-in since user.revoke_login; this clears that
-- and links it back to the person it was, when that person is live and has
-- no other login. Its roles, sessions and tokens stay gone: an admin grants
-- roles again. A login whose identity a later grant already moved to a new
-- login (login_unrevoke) has no sign-in left to restore: not_revoked.
--
-- Result JSON shape matches `user.RestoreLoginOutput`:
--   {"restored": true, "person_card_id": "<bigint>" | null}
CREATE OR REPLACE FUNCTION user_restore_login_batch(
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
    _person bigint;
    _linked bigint;
BEGIN
    FOR _idx, _user_id IN
        SELECT (r.ord - 1)::int,
               CASE WHEN (r.value->>'user_account_id') ~ '^[0-9]{1,18}$'
                    THEN (r.value->>'user_account_id')::bigint END
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _user_id IS NULL OR _user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user.restore_login: user_account_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT ua.revoked_person_card_id INTO _person
        FROM user_account ua
        WHERE ua.id = _user_id AND NOT ua.is_agent AND ua.login_revoked_at IS NOT NULL
          AND (ua.oidc_sub IS NOT NULL OR ua.email IS NOT NULL);
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_revoked'::text,
                format('user.restore_login: login %s isn''t a revoked login that can sign in again', _user_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        UPDATE user_account
           SET login_revoked_at = NULL, revoked_person_card_id = NULL
         WHERE id = _user_id;
        _linked := NULL;
        IF _person IS NOT NULL
           AND EXISTS (SELECT 1 FROM card c WHERE c.id = _person AND c.deleted_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM user_account_person uap WHERE uap.person_card_id = _person)
           AND NOT EXISTS (SELECT 1 FROM user_account_person uap WHERE uap.user_account_id = _user_id) THEN
            INSERT INTO user_account_person (user_account_id, person_card_id) VALUES (_user_id, _person);
            _linked := _person;
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('restored', true,
                               'person_card_id', CASE WHEN _linked IS NULL THEN NULL::jsonb ELSE to_jsonb(_linked::text) END);
    END LOOP;
END;
$$;

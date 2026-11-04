-- user.revoke_login — take a person's login away: what the People screen's
-- Remove and "no longer a user" mean (review 2026-11-03 round 2 #3). The
-- account loses every way in and everything it may do, and so do its agents:
--   - its roles and its agents' roles (user_role);
--   - its sessions and every token of it and its agents (revoked, so a
--     cookie or bearer token stops working on the next request);
--   - its sign-in: login_revoked_at is set and its oidc_sub and email are
--     kept, so a sign-in by that identity — the same IdP subject, or a
--     verified email equal to the account's — is refused (oidc.go,
--     ErrLoginRevoked). Before, the identity was forgotten, and the next
--     sign-in made a new account with the default role, linked back to the
--     same person card (review 2026-11-03 round 3 #3). An admin gives them a
--     login again with person.grant_account, which lifts the block for that
--     email (login_unrevoke);
--   - its person link (user_account_person).
-- The row itself stays, so the activity it wrote keeps its author.
--
-- Refused: the System user, an agent (agent.delete), and your own login (so
-- an admin can't lock themselves out by mistake). Admin-only (AllowedRoles).
--
-- Result JSON shape matches `user.RevokeLoginOutput`:
--   {"revoked": <bool>, "roles": N, "sessions": N, "tokens": N}
CREATE OR REPLACE FUNCTION user_revoke_login_batch(
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
    _ids bigint[];
    _roles int;
    _sessions int;
    _tokens int;
BEGIN
    FOR _idx, _user_id IN
        SELECT (r.ord - 1)::int,
               CASE WHEN (r.value->>'user_account_id') ~ '^[0-9]{1,18}$'
                    THEN (r.value->>'user_account_id')::bigint END
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _user_id IS NULL OR _user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user.revoke_login: user_account_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _user_id = 1 THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'user.revoke_login: the System user has no login to revoke'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _user_id = user_revoke_login_batch.actor_id THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'user.revoke_login: you can''t revoke your own login'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM user_account WHERE id = _user_id AND NOT is_agent) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                format('user.revoke_login: no login %s (an agent is removed with agent.delete)', _user_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        _ids := ARRAY(
            SELECT ua.id FROM user_account ua
            WHERE ua.id = _user_id OR (ua.is_agent AND ua.parent_user_id = _user_id));

        WITH d AS (DELETE FROM user_role WHERE user_id = ANY(_ids) RETURNING 1)
        SELECT count(*)::int INTO _roles FROM d;
        WITH u AS (
            UPDATE session SET revoked_at = now()
            WHERE user_id = ANY(_ids) AND revoked_at IS NULL RETURNING 1)
        SELECT count(*)::int INTO _sessions FROM u;
        WITH u AS (
            UPDATE user_token SET revoked_at = now()
            WHERE user_id = ANY(_ids) AND revoked_at IS NULL RETURNING 1)
        SELECT count(*)::int INTO _tokens FROM u;
        DELETE FROM user_account_person WHERE user_account_id = _user_id;
        UPDATE user_account SET login_revoked_at = now() WHERE id = _user_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('revoked', true, 'roles', _roles,
                               'sessions', _sessions, 'tokens', _tokens);
    END LOOP;
END;
$$;

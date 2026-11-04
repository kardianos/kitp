-- agent.delete — retire an agent (review 2026-11-03 round 2 #12).
--
-- The agent loses everything it may do and every way in: its roles
-- (user_role), its tokens and sessions (revoked), the cards it was set to
-- work on (user_card_agent) and its sort orders (user_card_sort). Its
-- user_account row stays, marked deleted_at, so what it did keeps its
-- author: its activity (comments included), the files it uploaded and the
-- imports it ran all still name it. A deleted agent is left out of
-- user.select, can't be given a role, a token or a card again, and its
-- name can be used for a new agent.
--
-- Deleting an agent again is a no-op that reports deleted=0, as is an id
-- that isn't an agent.
--
-- Authz (actor must be the target's parent_user_id or a global admin)
-- runs pre-tx in Go and is not duplicated here.
--
-- Result JSON shape matches `agent.DeleteOutput`:
--   {"ok": <bool>, "deleted": <0|1>}
CREATE OR REPLACE FUNCTION agent_delete_batch(
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
               NULLIF(r.value->>'user_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _user_id IS NULL OR _user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'agent.delete: user_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        WITH del AS (
            UPDATE user_account SET deleted_at = now()
            WHERE id = _user_id AND is_agent AND deleted_at IS NULL
            RETURNING id
        )
        SELECT count(*)::int INTO _deleted FROM del;

        IF _deleted > 0 THEN
            DELETE FROM user_role WHERE user_id = _user_id;
            UPDATE user_token SET revoked_at = now()
            WHERE user_id = _user_id AND revoked_at IS NULL;
            UPDATE session SET revoked_at = now()
            WHERE user_id = _user_id AND revoked_at IS NULL;
            DELETE FROM user_card_agent WHERE agent_user_id = _user_id;
            DELETE FROM user_card_sort WHERE user_id = _user_id;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', _deleted > 0,
                'deleted', _deleted
            );
    END LOOP;
END;
$$;

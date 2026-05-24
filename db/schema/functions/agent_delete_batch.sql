-- agent.delete handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runDelete into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: user_id is required.
--   2. Null any attribute_value.last_activity_id pointing at activity
--      rows we are about to remove (the column is nullable; losing the
--      last-actor pointer is a small price for being able to remove
--      the agent).
--   3. Delete activity rows where actor_id = the target. The column is
--      ON DELETE NO ACTION so leaving them in place blocks the
--      user_account delete.
--   4. Delete the user_account row, gated on is_agent=TRUE so a stray
--      id (non-agent or absent) reports deleted=0 cleanly.
--      user_account ON DELETE CASCADE wipes session, user_token,
--      user_card_agent, and user_card_sort rows automatically.
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

        -- Null any attribute_value.last_activity_id pointing at
        -- activity rows we are about to delete. Qualify activity.actor_id
        -- — the function's own actor_id parameter would otherwise shadow
        -- the column. (Same gotcha hit by comment.update during Phase 2.)
        UPDATE attribute_value SET last_activity_id = NULL
        WHERE last_activity_id IN (
            SELECT id FROM activity WHERE activity.actor_id = _user_id
        );

        -- Wipe activity rows where the agent was the actor.
        DELETE FROM activity WHERE activity.actor_id = _user_id;

        -- Delete the user_account row, gated on is_agent=TRUE. Cascade
        -- handles session / user_token / user_card_agent / user_card_sort.
        WITH del AS (
            DELETE FROM user_account
            WHERE id = _user_id AND is_agent = TRUE
            RETURNING id
        )
        SELECT count(*)::int INTO _deleted FROM del;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', _deleted > 0,
                'deleted', _deleted
            );
    END LOOP;
END;
$$;

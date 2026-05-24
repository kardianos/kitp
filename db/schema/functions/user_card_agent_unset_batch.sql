-- user_card_agent.clear handler (Phase 2 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runClear into one PL/pgSQL body.
--
-- The SQL function name is `user_card_agent_unset_batch` per the
-- Phase 2 task list; the Go-side action name stays `clear` to
-- preserve wire compatibility with existing clients
-- (handlers_admin.ts, integration tests).
--
-- user_id is implicit — we stamp it from actor_id; the caller
-- never supplies it. Idempotent: clearing a row that doesn't exist
-- returns ok=true with deleted=0, matching the legacy behaviour.
--
-- Per-row pipeline:
--   1. Validation: card_id is required.
--   2. DELETE WHERE (user_id, card_id) RETURNING — the row count
--      goes into ClearOutput.deleted. ok = (deleted > 0).
--
-- Result JSON shape matches `usercardagent.ClearOutput`:
--   {"ok": <bool>, "deleted": <0|1>}
-- ok is true iff a row was actually removed; the Go-side struct's
-- `json:"deleted"` field maps to deleted (plain int, no string cast).
CREATE OR REPLACE FUNCTION user_card_agent_unset_batch(
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
    _card_id bigint;
    _deleted int;
BEGIN
    FOR _idx, _card_id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'card_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_card_agent.clear: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        WITH del AS (
            DELETE FROM user_card_agent
            WHERE user_id = actor_id AND card_id = _card_id
            RETURNING 1
        )
        SELECT count(*)::int INTO _deleted FROM del;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('ok', _deleted > 0, 'deleted', _deleted);
    END LOOP;
END;
$$;

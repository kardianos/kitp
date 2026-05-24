-- flow_step.delete handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds
-- runStepDelete into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Presence check (flow_step_id required).
--   2. DELETE; emit ok=true with {ok, deleted}.
--
-- Result JSON shape matches `flow.StepDeleteOutput`:
--   {"ok": <bool>, "deleted": <int>}
--
-- Authz (admin gate) runs pre-tx in Go.
CREATE OR REPLACE FUNCTION flow_step_delete_batch(
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
    _flow_step_id bigint;
    _deleted int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _flow_step_id := COALESCE(NULLIF(_raw->>'flow_step_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _flow_step_id := 0;
        END;

        IF _flow_step_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow_step.delete: flow_step_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        WITH d AS (
            DELETE FROM flow_step WHERE id = _flow_step_id RETURNING id
        )
        SELECT count(*)::int INTO _deleted FROM d;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', _deleted > 0,
                'deleted', _deleted);
    END LOOP;
END;
$$;

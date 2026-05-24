-- flow.delete handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runFlowDelete into one PL/pgSQL body AND introduces
-- the blocker check the legacy path lacked: a flow is only removable
-- when no flow_step rows reference it.
--
-- The old behaviour (ON DELETE CASCADE drops every flow_step) silently
-- discarded transition edges; the new contract requires admins to
-- delete the steps first (or use flow.preview_delete + an explicit
-- step purge) so the destructive consequences are visible.
--
-- Per-row pipeline:
--   1. Presence check (flow_id required).
--   2. Probe for blocking flow_step rows; on hit, emit ok=false with
--      code='flow_disallowed' and a structured `result` payload:
--        {"blockers": [{"flow_step_id": "<id>", "label": "<lbl>"}, ...],
--         "count": <K>}
--      The dispatcher's runSQLFunc copies this into HandlerError.Detail
--      so the admin UI can render the blocker list verbatim.
--   3. DELETE; report ok=true with {ok, deleted} matching DeleteOutput.
--
-- Authz (admin gate) runs pre-tx in Go.
CREATE OR REPLACE FUNCTION flow_delete_batch(
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
    _flow_id bigint;
    _blockers jsonb;
    _blocker_count int;
    _deleted int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _flow_id := COALESCE(NULLIF(_raw->>'flow_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _flow_id := 0;
        END;

        IF _flow_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow.delete: flow_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- Blocker scan. ORDER BY (sort_order, label, id) so the admin
        -- UI sees a deterministic preview — same ordering flow_step.list
        -- uses for the editor.
        SELECT COALESCE(
                  jsonb_agg(jsonb_build_object(
                      'flow_step_id', fs.id::text,
                      'label', fs.label)
                      ORDER BY fs.sort_order, fs.label, fs.id),
                  '[]'::jsonb),
               COALESCE(count(*), 0)::int
          INTO _blockers, _blocker_count
        FROM flow_step fs
        WHERE fs.flow_id = _flow_id;

        IF _blocker_count > 0 THEN
            RETURN QUERY SELECT _idx, false, 'flow_disallowed'::text,
                format('flow.delete: %s flow_step row(s) still reference flow %s; remove them first',
                    _blocker_count, _flow_id),
                jsonb_build_object(
                    'blockers', _blockers,
                    'count', _blocker_count);
            CONTINUE;
        END IF;

        WITH d AS (
            DELETE FROM flow WHERE id = _flow_id RETURNING id
        )
        SELECT count(*)::int INTO _deleted FROM d;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', _deleted > 0,
                'deleted', _deleted);
    END LOOP;
END;
$$;

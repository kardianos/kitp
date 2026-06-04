-- flow_step.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runStepList into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Presence check (flow_id required).
--   2. Run the SELECT joined to role (LEFT) for the optional
--      requires_role name.
--
-- Authz (RoleAuthenticated) runs pre-tx in Go.
--
-- Result JSON shape matches `flow.StepListOutput`:
--   {"rows": [{"id": "<bigint>", "flow_id": "<bigint>",
--             "from_card_id": "<bigint>", "to_card_id": "<bigint>",
--             "label": "...", "requires_role_id": "<bigint>",
--             "requires_role_name": "...", "sort_order": <int>}]}
CREATE OR REPLACE FUNCTION flow_step_list_batch(
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
    _payload jsonb;
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
                'flow_step.list: flow_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',                 fs.id::text,
                    'flow_id',            fs.flow_id::text,
                    'from_card_id',       fs.from_card_id::text,
                    'to_card_id',         fs.to_card_id::text,
                    'label',              fs.label,
                    'requires_role_id',   COALESCE(fs.requires_role_id, 0)::text,
                    'requires_role_name', COALESCE(r.name, ''),
                    'sort_order',         fs.sort_order,
                    'standalone',         fs.standalone
                ) ORDER BY fs.sort_order, fs.label, fs.id
            )
            FROM flow_step fs
            LEFT JOIN role r ON r.id = fs.requires_role_id
            WHERE fs.flow_id = _flow_id
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

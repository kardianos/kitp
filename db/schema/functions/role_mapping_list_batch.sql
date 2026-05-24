-- role_mapping.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runList into one PL/pgSQL body.
--
-- One input → one result row. Role mappings are a global lookup table;
-- every input gets the same snapshot.
--
-- Authz (admin) runs pre-tx in Go.
--
-- Result JSON shape matches `rolemapping.ListOutput`:
--   {"rows": [{"claim_value": "...", "role_id": "<bigint>",
--             "role_name": "..."}]}
CREATE OR REPLACE FUNCTION role_mapping_list_batch(
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
    _payload jsonb;
BEGIN
    SELECT jsonb_build_object('rows', COALESCE((
        SELECT jsonb_agg(
            jsonb_build_object(
                'claim_value', rm.claim_value,
                'role_id',     r.id::text,
                'role_name',   r.name
            ) ORDER BY rm.claim_value
        )
        FROM role_mapping rm
        JOIN role r ON r.id = rm.role_id
    ), '[]'::jsonb))
    INTO _payload;

    FOR _idx IN
        SELECT (r.ord - 1)::int
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

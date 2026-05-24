-- role.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runList into one PL/pgSQL body.
--
-- One input → one result row. The role catalogue is global metadata, so
-- every input gets the same snapshot: every role + the (card_type,
-- process) pairs that role grants. Per-input filters are unused in v1
-- but the wrapper signature is preserved for uniformity (multi-input
-- batches return N identical result rows).
--
-- Authz (RoleAuthenticated) runs pre-tx in Go.
--
-- Result JSON shape matches `role.SelectOutput`:
--   {"rows": [{"id": "<bigint>", "name": "...", "doc": "...",
--             "grants": [{"card_type": "...", "process": "..."}]}]}
CREATE OR REPLACE FUNCTION role_list_batch(
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
    -- Hoist the single snapshot the every input shares.
    SELECT jsonb_build_object('rows', COALESCE((
        SELECT jsonb_agg(
            jsonb_build_object(
                'id',     r.id::text,
                'name',   r.name,
                'doc',    COALESCE(r.doc, ''),
                'grants', COALESCE((
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'card_type', ct.name,
                            'process',   p.name
                        ) ORDER BY ct.name, p.name
                    )
                    FROM role_grant rg
                    JOIN card_type ct ON ct.id = rg.card_type_id
                    JOIN process p   ON p.id  = rg.process_id
                    WHERE rg.role_id = r.id
                ), '[]'::jsonb)
            ) ORDER BY r.id
        )
        FROM role r
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

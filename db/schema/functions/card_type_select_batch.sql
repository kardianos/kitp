-- card_type.select handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side anonymous Run closure into one PL/pgSQL body.
--
-- One input → one result row. card_type is global reference data (every
-- row seeded by migration); no per-input filter today and no row-level
-- visibility filter applies. The snapshot is hoisted once and replicated
-- per input.
--
-- Authz (RoleAuthenticated) runs pre-tx in Go.
--
-- Result JSON shape matches `cardtype.SelectOutput`:
--   {"rows": [{"id": "<bigint>", "name": "...",
--             "parent_card_type_id": "<bigint>" | null,
--             "allow_self_parent": <bool>, "is_built_in": <bool>}]}
CREATE OR REPLACE FUNCTION card_type_select_batch(
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
                'id',                  ct.id::text,
                'name',                ct.name,
                'parent_card_type_id',
                    CASE WHEN ct.parent_card_type_id IS NULL THEN NULL
                         ELSE to_jsonb(ct.parent_card_type_id::text)
                    END,
                'allow_self_parent',   ct.allow_self_parent,
                'is_built_in',         ct.is_built_in,
                'uses_phase',          ct.uses_phase
            ) ORDER BY ct.id
        )
        FROM card_type ct
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

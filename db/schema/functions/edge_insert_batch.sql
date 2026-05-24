-- edge.insert handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runEdgeInsert into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: attribute_def_id and card_type_id are both required.
--   2. Idempotent INSERT: the (card_type_id, attribute_def_id) UNIQUE
--      constraint makes re-binding a no-op via ON CONFLICT DO NOTHING.
--      Matches the legacy Go runEdgeInsert behaviour — "idempotent" is
--      the documented contract.
--
-- Result JSON shape matches `attributedef.EdgeInsertOutput`:
--   {"ok": true}
CREATE OR REPLACE FUNCTION edge_insert_batch(
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
    _attr_def_id bigint;
    _card_type_id bigint;
    _is_required boolean;
    _ordering int;
    _raw jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _attr_def_id := NULLIF(_raw->>'attribute_def_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _attr_def_id := NULL;
        END;
        BEGIN
            _card_type_id := NULLIF(_raw->>'card_type_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _card_type_id := NULL;
        END;

        IF _attr_def_id IS NULL OR _attr_def_id = 0
           OR _card_type_id IS NULL OR _card_type_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'edge.insert: attribute_def_id and card_type_id are required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        _is_required := COALESCE((_raw->>'is_required')::boolean, false);
        _ordering := COALESCE(NULLIF(_raw->>'ordering', '')::int, 0);

        INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
        VALUES (_card_type_id, _attr_def_id, _is_required, _ordering)
        ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('ok', true);
    END LOOP;
END;
$$;

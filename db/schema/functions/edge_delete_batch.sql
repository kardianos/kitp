-- edge.delete handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runEdgeDelete into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: attribute_def_id and card_type_id are both required.
--   2. Existence lookup: both rows (attribute_def, card_type) must
--      exist; otherwise 'not_found'.
--   3. Built-in guard: when both the def and the card_type carry
--      is_built_in=true, refuse with code='built_in'. Migrations seed
--      those edges (e.g. the 'title' attribute on every built-in
--      card_type) and the admin path should not silently rewire the
--      schema — change the seed/migration instead.
--   4. Usage gate: count attribute_value rows that reference this
--      (card_type, def). If >0 the function emits a SUCCESS row
--      (ok=true) with `usage_count` set in the JSON payload. The Go
--      EdgeDeleteOutput struct's `ok` field is false in that case
--      (soft refusal) — the dispatcher treats it as a successful
--      response carrying advisory data, not an error. Matches the
--      legacy runEdgeDelete shape.
--   5. DELETE the edge. The output `ok` reflects whether a row was
--      actually deleted (the legacy code returned ct.RowsAffected()>0).
--
-- Result JSON shape matches `attributedef.EdgeDeleteOutput`:
--   {"ok": true}                  on a real delete
--   {"ok": false, "usage_count": N} when blocked by in-use values
CREATE OR REPLACE FUNCTION edge_delete_batch(
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
    _raw jsonb;
    _def_built_in boolean;
    _ct_built_in boolean;
    _usage int;
    _deleted int;
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
                'edge.delete: attribute_def_id and card_type_id are required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Existence + built-in flags in one shot.
        SELECT ad.is_built_in, ct.is_built_in
          INTO _def_built_in, _ct_built_in
        FROM attribute_def ad, card_type ct
        WHERE ad.id = _attr_def_id AND ct.id = _card_type_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                format('edge.delete: def %s or card_type %s not found',
                       _attr_def_id, _card_type_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Built-in guard.
        IF _def_built_in AND _ct_built_in THEN
            RETURN QUERY SELECT _idx, false, 'built_in'::text,
                'edge.delete: refusing to remove a built-in (def + card_type) edge — change the migration instead'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Usage gate.
        SELECT count(*)::int INTO _usage
        FROM attribute_value av
        JOIN card c ON c.id = av.card_id
        WHERE av.attribute_def_id = _attr_def_id
          AND c.card_type_id = _card_type_id;
        IF _usage > 0 THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('ok', false, 'usage_count', _usage);
            CONTINUE;
        END IF;

        -- 5. Delete (capture rows-affected via GET DIAGNOSTICS).
        DELETE FROM edge
        WHERE attribute_def_id = _attr_def_id
          AND card_type_id = _card_type_id;
        GET DIAGNOSTICS _deleted = ROW_COUNT;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('ok', _deleted > 0);
    END LOOP;
END;
$$;

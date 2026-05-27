-- attribute_def.insert handler (Phase 2 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runInsert (validate + INSERT def + seed
-- edges) into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: name and value_type required; if bind_to[] is
--      supplied each entry must carry a non-zero card_type_id. Matches
--      the legacy Go check.
--   2. Insert the attribute_def row with is_built_in=false. Only
--      migrations install built-in defs; the admin path always lands
--      a user-defined row.
--   3. Seed any bind_to[] edges. Idempotent — ON CONFLICT DO NOTHING
--      mirrors the legacy CTE so a duplicate (card_type, def) pair in
--      a batch is silently skipped rather than aborting the row.
--
-- Result JSON shape matches `attributedef.InsertOutput`:
--   {"id": "123"}
-- The 64-bit id is cast to text per the wire convention.
CREATE OR REPLACE FUNCTION attribute_def_insert_batch(
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
    _name text;
    _value_type text;
    _target_name text;
    _target_id bigint;
    _bind_to jsonb;
    _bind_el jsonb;
    _new_id bigint;
    _ct_id bigint;
    _bad boolean;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _name := _raw->>'name';
        _value_type := _raw->>'value_type';
        _target_name := _raw->>'target_card_type';
        _bind_to := _raw->'bind_to';

        IF _name IS NULL OR _name = '' OR _value_type IS NULL OR _value_type = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attribute_def.insert: name and value_type are required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- Resolve the picker target (card_ref value types only). An unknown
        -- target name leaves it NULL — a card_ref with no target is valid (it
        -- references any card), and scalar types never carry a target.
        _target_id := NULL;
        IF _value_type IN ('card_ref', 'card_ref[]')
           AND _target_name IS NOT NULL AND _target_name <> '' THEN
            SELECT id INTO _target_id FROM card_type WHERE name = _target_name;
        END IF;

        -- bind_to[] entries must each carry a non-zero card_type_id.
        -- Pre-flight the whole array so a bad entry aborts the row
        -- before we INSERT the def. Matches the legacy Go shape.
        _bad := false;
        IF _bind_to IS NOT NULL AND jsonb_typeof(_bind_to) = 'array' THEN
            FOR _bind_el IN SELECT e.v FROM jsonb_array_elements(_bind_to) AS e(v) LOOP
                BEGIN
                    _ct_id := NULLIF(_bind_el->>'card_type_id', '')::bigint;
                EXCEPTION WHEN invalid_text_representation THEN
                    _ct_id := NULL;
                END;
                IF _ct_id IS NULL OR _ct_id = 0 THEN
                    _bad := true;
                    EXIT;
                END IF;
            END LOOP;
        END IF;
        IF _bad THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attribute_def.insert: bind_to[].card_type_id is required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Insert the def row (with the resolved picker target, if any).
        INSERT INTO attribute_def (name, value_type, is_built_in, target_card_type_id)
        VALUES (_name, _value_type, false, _target_id)
        RETURNING id INTO _new_id;

        -- 3. Seed bind_to[] edges (if any).
        IF _bind_to IS NOT NULL AND jsonb_typeof(_bind_to) = 'array' THEN
            INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
            SELECT NULLIF(e.v->>'card_type_id', '')::bigint,
                   _new_id,
                   COALESCE((e.v->>'is_required')::boolean, false),
                   COALESCE(NULLIF(e.v->>'ordering', '')::int, 0)
            FROM jsonb_array_elements(_bind_to) AS e(v)
            ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('id', _new_id::text);
    END LOOP;
END;
$$;

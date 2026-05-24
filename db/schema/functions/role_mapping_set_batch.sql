-- role_mapping.set handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runSet into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: claim_value and role_name are required.
--   2. Resolve role_name -> role_id. Unknown role surfaces 'validation'.
--   3. Upsert role_mapping(claim_value, role_id) on the claim_value PK.
--
-- Authz (admin) runs pre-tx in Go.
--
-- Result JSON shape matches `rolemapping.SetOutput`:
--   {"ok": true}
CREATE OR REPLACE FUNCTION role_mapping_set_batch(
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
    _claim text;
    _role_name text;
    _role_id bigint;
BEGIN
    FOR _idx, _claim, _role_name IN
        SELECT (r.ord - 1)::int,
               r.value->>'claim_value',
               r.value->>'role_name'
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _claim IS NULL OR _claim = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'role_mapping.set: claim_value is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _role_name IS NULL OR _role_name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'role_mapping.set: role_name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT id INTO _role_id FROM role WHERE name = _role_name;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('role_mapping.set: role %L not found', _role_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        INSERT INTO role_mapping (claim_value, role_id)
        VALUES (_claim, _role_id)
        ON CONFLICT (claim_value) DO UPDATE SET role_id = EXCLUDED.role_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('ok', true);
    END LOOP;
END;
$$;

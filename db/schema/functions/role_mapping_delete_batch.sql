-- role_mapping.delete handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runDelete into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: claim_value is required.
--   2. DELETE FROM role_mapping WHERE claim_value = _claim. Each row
--      gets its own per-row deleted count (the legacy Go path used
--      ANY($1) and split a single total across slots — the unified
--      version reports accurately per-input, which is strictly better).
--
-- Authz (admin) runs pre-tx in Go.
--
-- Result JSON shape matches `rolemapping.DeleteOutput`:
--   {"ok": <bool>, "deleted": <int>}
CREATE OR REPLACE FUNCTION role_mapping_delete_batch(
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
    _deleted int;
BEGIN
    FOR _idx, _claim IN
        SELECT (r.ord - 1)::int,
               r.value->>'claim_value'
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _claim IS NULL OR _claim = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'role_mapping.delete: claim_value is required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        WITH del AS (
            DELETE FROM role_mapping WHERE claim_value = _claim
            RETURNING claim_value
        )
        SELECT count(*)::int INTO _deleted FROM del;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', _deleted > 0,
                'deleted', _deleted
            );
    END LOOP;
END;
$$;

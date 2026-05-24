-- project.import.set_mapping handler (Phase 4 of UNIFIED_HANDLER_PLAN.md).
--
-- Per-row pipeline:
--   1. Validate job_id is present.
--   2. UPDATE import_job — write the new mapping JSONB. Status
--      transitions from 'uploaded' to 'mapped' (idempotent: jobs
--      already in 'previewed'/'running'/'completed'/'failed' keep
--      their current status; only the mapping is rewritten).
--   3. Return ok + the new (post-update) status so the wizard can
--      route on it without a second roundtrip.
--
-- Result JSON shape matches `projectimport.SetMappingOutput`:
--   {"ok": true, "status": "mapped"}
CREATE OR REPLACE FUNCTION project_import_set_mapping_batch(
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
    _job_id bigint;
    _mapping jsonb;
    _new_status text;
    _affected int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _job_id := NULLIF(_raw->>'job_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _job_id := NULL;
        END;
        IF _job_id IS NULL OR _job_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'project.import.set_mapping: job_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        _mapping := COALESCE(_raw->'mapping', '{}'::jsonb);

        UPDATE import_job
           SET mapping = _mapping,
               status  = CASE WHEN status IN ('previewed','running','completed','failed')
                              THEN status ELSE 'mapped' END
         WHERE id = _job_id
        RETURNING status INTO _new_status;
        GET DIAGNOSTICS _affected = ROW_COUNT;
        IF _affected = 0 THEN
            RETURN QUERY SELECT _idx, false, 'job_not_found'::text,
                format('project.import.set_mapping: job %s not found', _job_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'status', _new_status
            );
    END LOOP;
END;
$$;

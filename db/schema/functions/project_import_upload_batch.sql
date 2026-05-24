-- project.import.upload handler (Phase 4 of UNIFIED_HANDLER_PLAN.md).
--
-- CSV parsing happens Go-side via a PreRun hook (the dispatcher's
-- pre-call hook with tx access) — encoding/csv handles quoting +
-- ragged rows + LazyQuotes cleanly, and porting that to PL/pgSQL
-- adds risk without benefit. By the time this function runs the
-- input JSON already carries `headers`, `preview_rows`, and
-- `row_count` alongside the original `project_id` + `file_id`.
--
-- Per-row pipeline:
--   1. Validate project_id + file_id presence.
--   2. Verify project exists and is of card_type='project'.
--   3. INSERT import_job (status='uploaded', mapping/resolution NULL).
--   4. Return the new job id alongside the prefetched header /
--      preview_rows / row_count.
--
-- Result JSON shape matches `projectimport.UploadOutput`:
--   {"job_id": "<bigint>", "headers": [...], "preview_rows": [[...]],
--    "row_count": <int>}
CREATE OR REPLACE FUNCTION project_import_upload_batch(
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
    _project_id bigint;
    _file_id bigint;
    _headers jsonb;
    _preview_rows jsonb;
    _row_count int;
    _new_job_id bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _project_id := NULLIF(_raw->>'project_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _project_id := NULL;
        END;
        BEGIN
            _file_id := NULLIF(_raw->>'file_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _file_id := NULL;
        END;
        IF _project_id IS NULL OR _project_id = 0
           OR _file_id IS NULL OR _file_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'project.import.upload: project_id and file_id are required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM card c
            JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
            WHERE c.id = _project_id
        ) THEN
            RETURN QUERY SELECT _idx, false, 'project_not_found'::text,
                format('project.import.upload: project %s not found', _project_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- The PreRun hook pre-parsed the CSV and stuffed the
        -- structured fields under these keys. Default to empty if a
        -- caller bypasses the hook (e.g. a direct SQL-function
        -- invocation in a unit test) so the function still runs.
        _headers := COALESCE(_raw->'_parsed_headers', '[]'::jsonb);
        _preview_rows := COALESCE(_raw->'_parsed_preview_rows', '[]'::jsonb);
        _row_count := COALESCE((_raw->>'_parsed_row_count')::int, 0);

        INSERT INTO import_job (project_id, file_id, status, created_by)
        VALUES (_project_id, _file_id, 'uploaded', actor_id)
        RETURNING id INTO _new_job_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'job_id', _new_job_id::text,
                'headers', _headers,
                'preview_rows', _preview_rows,
                'row_count', _row_count
            );
    END LOOP;
END;
$$;

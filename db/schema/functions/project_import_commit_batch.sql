-- project.import.commit handler (Phase 4 of UNIFIED_HANDLER_PLAN.md).
--
-- Heaviest of the project.import.* functions: applies mapping +
-- resolution to every CSV row, auto-creates persons / milestones /
-- components / tags as configured, then inserts every task. Returns
-- per-row counts + marks the job 'completed'.
--
-- Avoids re-implementing card.insert by calling card_insert_batch
-- internally — once per category (persons / milestones / components /
-- tags) and once more for all tasks. card_insert_batch handles edge
-- validation + scope check + template graph-copy uniformly so this
-- handler can stay focused on the per-row planning logic. Errors
-- from the inner call surface as RAISE EXCEPTION (caught by the
-- dispatcher's mapPGError) since the design contract says inner
-- card.insert failures during a commit abort the whole tx.
--
-- CSV parsing happens Go-side via the PreRun hook. By the time this
-- function runs, the input JSON carries `_parsed_header` +
-- `_parsed_rows`. Splitting the commit into separate "validate" and
-- "apply" PL/pgSQL functions adds round-trips without a real
-- benefit — the validation walk + apply walk can share state in
-- one DECLARE block, and the bug-finding signal "abort on first row
-- error" only needs one pass.
--
-- Per-row pipeline:
--   1. Validate job_id; load job + reject if status='completed'/'running'
--      (mirrors the Go handler's already_committed gate).
--   2. Reject jobs without a stored mapping.
--   3. Build per-project lookups (milestones / components / tags by
--      normalised key; persons by email globally).
--   4. Walk pre-parsed rows, build per-row task plans + auto-create
--      sets. Validate; abort the whole tx on any unresolved error.
--   5. Auto-create persons (parent NULL) / milestones / components
--      (parent = project) / tags (parent = project, path attribute).
--      Update the lookups with the new ids.
--   6. Pick a default status card for tasks (project-scoped Gate 6
--      requires the (task, status) edge to be present).
--   7. Build tasks input JSONB array, call card_insert_batch once.
--   8. Persist completion (status='completed', completed_at=now()).
--
-- Result JSON matches `projectimport.CommitOutput`:
--   {"created": {...}, "errors": [], "status": "completed",
--    "skipped_rows": N, "processed_rows": N}
CREATE OR REPLACE FUNCTION project_import_commit_batch(
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
    _job_status text;
    _project_id bigint;
    _mapping jsonb;
    _resolution jsonb;
    _r_persons text;
    _r_milestones text;
    _r_components text;
    _r_tags text;
    _header jsonb;
    _rows jsonb;
    -- column index lookups
    _col_idx_title int;
    _col_idx_milestone int;
    _col_idx_component int;
    _col_idx_tags int;
    _col_idx_assignee_email int;
    _col_idx_assignee_name int;
    _col_idx_description int;
    _col_idx_sort int;
    _allowed_targets text[] := ARRAY['id','title','assignee_email','assignee_name',
                                     'milestone','component','tags','description','sort_order'];
    _hdr_pos int;
    _header_name text;
    _target text;
    -- lookups
    _milestones jsonb;
    _components jsonb;
    _tags jsonb;
    _persons jsonb;
    _new_persons jsonb;     -- email -> name (for auto-create)
    _new_milestones jsonb;  -- norm -> raw title
    _new_components jsonb;
    _new_tags jsonb;        -- norm -> raw path
    -- per-row planning
    _tasks jsonb;
    _ri int;
    _row jsonb;
    _row_num int;
    _row_skip boolean;
    _cell text;
    _v text;
    _norm text;
    _name text;
    _processed int;
    _skipped int;
    _had_errors boolean;
    _first_err_msg text;
    _tag_part text;
    _tp_title text;
    _tp_description text;
    _tp_sort_order text;
    _tp_assignee_email text;
    _tp_assignee_name text;
    _tp_milestone_title text;
    _tp_component_title text;
    _tp_tag_paths text[];
    -- card.insert call buffers
    _insert_inputs jsonb;
    _insert_keys text[];
    _key text;
    _ci_idx int;
    _ci_ok boolean;
    _ci_code text;
    _ci_message text;
    _ci_result jsonb;
    _ci_id bigint;
    -- status pick
    _status_id bigint;
    -- task assembly
    _task_attrs jsonb;
    _tag_id_arr bigint[];
    _ml_id bigint;
    _co_id bigint;
    _pe_id bigint;
    _t_id bigint;
    _summary jsonb;
    _created_tasks int;
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
                'project.import.commit: job_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT j.status, j.project_id,
               COALESCE(j.mapping, 'null'::jsonb),
               COALESCE(j.resolution, '{}'::jsonb)
          INTO _job_status, _project_id, _mapping, _resolution
        FROM import_job j WHERE j.id = _job_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'job_not_found'::text,
                format('import_job %s not found', _job_id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _job_status = 'completed' THEN
            RETURN QUERY SELECT _idx, false, 'already_committed'::text,
                format('import_job %s is already completed; re-upload to re-run', _job_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _job_status = 'running' THEN
            RETURN QUERY SELECT _idx, false, 'already_committed'::text,
                format('import_job %s is already running (replay via Idempotency-Key if you intended a retry)', _job_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _mapping IS NULL OR jsonb_typeof(_mapping) = 'null' THEN
            RETURN QUERY SELECT _idx, false, 'no_mapping'::text,
                'project.import.commit: job has no mapping; call set_mapping first'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        _r_persons := COALESCE(_resolution->>'persons', '');
        _r_milestones := COALESCE(_resolution->>'milestones', '');
        _r_components := COALESCE(_resolution->>'components', '');
        _r_tags := COALESCE(_resolution->>'tags', '');

        _header := COALESCE(_raw->'_parsed_header', '[]'::jsonb);
        _rows := COALESCE(_raw->'_parsed_rows', '[]'::jsonb);

        -- Lookups (same as preview).
        SELECT COALESCE(jsonb_object_agg(lower(btrim(av.value #>> '{}')), c.id::text), '{}'::jsonb)
          INTO _milestones
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'milestone'
        JOIN attribute_value av ON av.card_id = c.id
        JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
        WHERE c.parent_card_id = _project_id AND c.deleted_at IS NULL
          AND (av.value #>> '{}') <> '';

        SELECT COALESCE(jsonb_object_agg(lower(btrim(av.value #>> '{}')), c.id::text), '{}'::jsonb)
          INTO _components
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'component'
        JOIN attribute_value av ON av.card_id = c.id
        JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
        WHERE c.parent_card_id = _project_id AND c.deleted_at IS NULL
          AND (av.value #>> '{}') <> '';

        SELECT COALESCE(jsonb_object_agg(lower(btrim(av.value #>> '{}')), c.id::text), '{}'::jsonb)
          INTO _tags
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'tag'
        JOIN attribute_value av ON av.card_id = c.id
        JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'path'
        WHERE c.parent_card_id = _project_id AND c.deleted_at IS NULL
          AND (av.value #>> '{}') <> '';

        SELECT COALESCE(jsonb_object_agg(lower(btrim(av.value #>> '{}')), c.id::text), '{}'::jsonb)
          INTO _persons
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'person'
        JOIN attribute_value av ON av.card_id = c.id
        JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'email'
        WHERE c.deleted_at IS NULL
          AND (av.value #>> '{}') <> '';

        -- Column index map.
        _col_idx_title := -1;
        _col_idx_milestone := -1;
        _col_idx_component := -1;
        _col_idx_tags := -1;
        _col_idx_assignee_email := -1;
        _col_idx_assignee_name := -1;
        _col_idx_description := -1;
        _col_idx_sort := -1;
        _hdr_pos := 0;
        FOR _header_name IN SELECT v #>> '{}' FROM jsonb_array_elements(_header) AS v
        LOOP
            _target := _mapping->>_header_name;
            IF _target IS NULL OR _target = '' OR _target = '_ignore_'
               OR NOT (_target = ANY(_allowed_targets)) THEN
                _hdr_pos := _hdr_pos + 1;
                CONTINUE;
            END IF;
            CASE _target
                WHEN 'title' THEN _col_idx_title := _hdr_pos;
                WHEN 'milestone' THEN _col_idx_milestone := _hdr_pos;
                WHEN 'component' THEN _col_idx_component := _hdr_pos;
                WHEN 'tags' THEN _col_idx_tags := _hdr_pos;
                WHEN 'assignee_email' THEN _col_idx_assignee_email := _hdr_pos;
                WHEN 'assignee_name' THEN _col_idx_assignee_name := _hdr_pos;
                WHEN 'description' THEN _col_idx_description := _hdr_pos;
                WHEN 'sort_order' THEN _col_idx_sort := _hdr_pos;
                ELSE NULL;
            END CASE;
            _hdr_pos := _hdr_pos + 1;
        END LOOP;

        _new_persons := '{}'::jsonb;
        _new_milestones := '{}'::jsonb;
        _new_components := '{}'::jsonb;
        _new_tags := '{}'::jsonb;
        _tasks := '[]'::jsonb;
        _processed := 0;
        _skipped := 0;
        _had_errors := false;
        _first_err_msg := NULL;

        -- Plan walk: build task plans + auto-create sets, abort on first error.
        _ri := 0;
        FOR _row IN SELECT v FROM jsonb_array_elements(_rows) AS v
        LOOP
            _row_num := _ri + 2;
            _row_skip := false;
            _tp_title := '';
            _tp_description := '';
            _tp_sort_order := '';
            _tp_assignee_email := '';
            _tp_assignee_name := '';
            _tp_milestone_title := '';
            _tp_component_title := '';
            _tp_tag_paths := ARRAY[]::text[];

            -- title
            IF _col_idx_title >= 0 THEN
                _tp_title := btrim(COALESCE(_row->>_col_idx_title, ''));
            END IF;
            IF _tp_title = '' THEN
                _had_errors := true;
                _first_err_msg := COALESCE(_first_err_msg, format('row %s: title is required', _row_num));
            END IF;

            -- milestone
            IF _col_idx_milestone >= 0 THEN
                _v := btrim(COALESCE(_row->>_col_idx_milestone, ''));
                IF _v <> '' THEN
                    _norm := lower(_v);
                    IF _milestones ? _norm THEN
                        _tp_milestone_title := _norm;
                    ELSE
                        IF _r_milestones = 'skip' THEN
                            _row_skip := true;
                        ELSIF _r_milestones = 'auto_create' THEN
                            _new_milestones := _new_milestones || jsonb_build_object(_norm, _v);
                            _tp_milestone_title := _norm;
                        ELSIF _r_milestones = 'leave_blank' THEN
                            NULL;
                        ELSE
                            _had_errors := true;
                            _first_err_msg := COALESCE(_first_err_msg,
                                format('row %s: unknown milestone "%s" (no resolution mode set)', _row_num, _v));
                        END IF;
                    END IF;
                END IF;
            END IF;

            -- component
            IF _col_idx_component >= 0 THEN
                _v := btrim(COALESCE(_row->>_col_idx_component, ''));
                IF _v <> '' THEN
                    _norm := lower(_v);
                    IF _components ? _norm THEN
                        _tp_component_title := _norm;
                    ELSE
                        IF _r_components = 'skip' THEN
                            _row_skip := true;
                        ELSIF _r_components = 'auto_create' THEN
                            _new_components := _new_components || jsonb_build_object(_norm, _v);
                            _tp_component_title := _norm;
                        ELSIF _r_components = 'leave_blank' THEN
                            NULL;
                        ELSE
                            _had_errors := true;
                            _first_err_msg := COALESCE(_first_err_msg,
                                format('row %s: unknown component "%s" (no resolution mode set)', _row_num, _v));
                        END IF;
                    END IF;
                END IF;
            END IF;

            -- tags (comma-separated)
            IF _col_idx_tags >= 0 THEN
                _cell := COALESCE(_row->>_col_idx_tags, '');
                FOREACH _tag_part IN ARRAY string_to_array(_cell, ',')
                LOOP
                    _v := btrim(_tag_part);
                    IF _v = '' THEN CONTINUE; END IF;
                    _norm := lower(_v);
                    IF _tags ? _norm THEN
                        _tp_tag_paths := array_append(_tp_tag_paths, _norm);
                    ELSE
                        IF _r_tags = 'skip' THEN
                            _row_skip := true;
                        ELSIF _r_tags = 'auto_create' THEN
                            _new_tags := _new_tags || jsonb_build_object(_norm, _v);
                            _tp_tag_paths := array_append(_tp_tag_paths, _norm);
                        ELSIF _r_tags = 'leave_blank' THEN
                            NULL;
                        ELSE
                            _had_errors := true;
                            _first_err_msg := COALESCE(_first_err_msg,
                                format('row %s: unknown tag "%s" (no resolution mode set)', _row_num, _v));
                        END IF;
                    END IF;
                END LOOP;
            END IF;

            -- assignee_email
            IF _col_idx_assignee_email >= 0 THEN
                _v := btrim(COALESCE(_row->>_col_idx_assignee_email, ''));
                IF _v <> '' THEN
                    _norm := lower(_v);
                    IF _persons ? _norm THEN
                        _tp_assignee_email := _norm;
                    ELSE
                        IF _r_persons = 'skip' THEN
                            _row_skip := true;
                        ELSIF _r_persons = 'auto_create' THEN
                            _name := '';
                            IF _col_idx_assignee_name >= 0 THEN
                                _name := btrim(COALESCE(_row->>_col_idx_assignee_name, ''));
                            END IF;
                            IF _name = '' THEN
                                -- local-part of email
                                IF position('@' IN _v) > 1 THEN
                                    _name := split_part(_v, '@', 1);
                                ELSE
                                    _name := _v;
                                END IF;
                            END IF;
                            _new_persons := _new_persons || jsonb_build_object(_norm, _name);
                            _tp_assignee_email := _norm;
                            _tp_assignee_name := _name;
                        ELSIF _r_persons = 'leave_blank' THEN
                            NULL;
                        ELSE
                            _had_errors := true;
                            _first_err_msg := COALESCE(_first_err_msg,
                                format('row %s: unknown person "%s" (no resolution mode set)', _row_num, _v));
                        END IF;
                    END IF;
                END IF;
            END IF;

            -- description
            IF _col_idx_description >= 0 THEN
                _tp_description := COALESCE(_row->>_col_idx_description, '');
            END IF;

            -- sort_order
            IF _col_idx_sort >= 0 THEN
                _v := btrim(COALESCE(_row->>_col_idx_sort, ''));
                IF _v <> '' THEN
                    BEGIN
                        PERFORM _v::numeric;
                        _tp_sort_order := _v;
                    EXCEPTION WHEN invalid_text_representation THEN
                        _had_errors := true;
                        _first_err_msg := COALESCE(_first_err_msg,
                            format('row %s: sort_order "%s" is not numeric', _row_num, _v));
                    END;
                END IF;
            END IF;

            IF _row_skip THEN
                _skipped := _skipped + 1;
            ELSE
                _processed := _processed + 1;
                _tasks := _tasks || jsonb_build_array(jsonb_build_object(
                    'title', _tp_title,
                    'description', _tp_description,
                    'sort_order', _tp_sort_order,
                    'assignee_email', _tp_assignee_email,
                    'assignee_name', _tp_assignee_name,
                    'milestone_title', _tp_milestone_title,
                    'component_title', _tp_component_title,
                    'tag_paths', to_jsonb(_tp_tag_paths)
                ));
            END IF;
            _ri := _ri + 1;
        END LOOP;

        IF _had_errors THEN
            -- Mirror Go's "import has N row errors; commit aborted"
            -- shape exactly enough that the existing test matches.
            RETURN QUERY SELECT _idx, false, 'import_validation'::text,
                format('import has row error(s); commit aborted (first: %s)', _first_err_msg),
                NULL::jsonb;
            CONTINUE;
        END IF;

        ---------------------------------------------------------------
        -- Auto-create cards via card_insert_batch (per category).
        ---------------------------------------------------------------

        -- Persons (global, no parent).
        IF jsonb_typeof(_new_persons) = 'object' AND _new_persons <> '{}'::jsonb THEN
            _insert_inputs := '[]'::jsonb;
            _insert_keys := ARRAY[]::text[];
            FOR _key, _name IN SELECT k, _new_persons->>k FROM jsonb_object_keys(_new_persons) AS k
            LOOP
                _insert_inputs := _insert_inputs || jsonb_build_array(jsonb_build_object(
                    'card_type_name', 'person',
                    'title', _name,
                    'attributes', jsonb_build_object('email', _key)
                ));
                _insert_keys := array_append(_insert_keys, _key);
            END LOOP;
            FOR _ci_idx, _ci_ok, _ci_code, _ci_message, _ci_result IN
                SELECT ci.idx, ci.ok, ci.code, ci.message, ci.result
                FROM card_insert_batch(actor_id, _insert_inputs) ci
                ORDER BY ci.idx
            LOOP
                IF NOT _ci_ok THEN
                    RAISE EXCEPTION 'project.import.commit: auto-create persons[%]: % %', _ci_idx, _ci_code, _ci_message;
                END IF;
                _ci_id := (_ci_result->>'id')::bigint;
                _persons := _persons || jsonb_build_object(_insert_keys[_ci_idx + 1], _ci_id::text);
            END LOOP;
        END IF;

        -- Milestones (parent=project, title only).
        IF jsonb_typeof(_new_milestones) = 'object' AND _new_milestones <> '{}'::jsonb THEN
            _insert_inputs := '[]'::jsonb;
            _insert_keys := ARRAY[]::text[];
            FOR _key, _name IN SELECT k, _new_milestones->>k FROM jsonb_object_keys(_new_milestones) AS k
            LOOP
                _insert_inputs := _insert_inputs || jsonb_build_array(jsonb_build_object(
                    'card_type_name', 'milestone',
                    'parent_card_id', _project_id::text,
                    'title', _name
                ));
                _insert_keys := array_append(_insert_keys, _key);
            END LOOP;
            FOR _ci_idx, _ci_ok, _ci_code, _ci_message, _ci_result IN
                SELECT ci.idx, ci.ok, ci.code, ci.message, ci.result
                FROM card_insert_batch(actor_id, _insert_inputs) ci
                ORDER BY ci.idx
            LOOP
                IF NOT _ci_ok THEN
                    RAISE EXCEPTION 'project.import.commit: auto-create milestones[%]: % %', _ci_idx, _ci_code, _ci_message;
                END IF;
                _ci_id := (_ci_result->>'id')::bigint;
                _milestones := _milestones || jsonb_build_object(_insert_keys[_ci_idx + 1], _ci_id::text);
            END LOOP;
        END IF;

        -- Components (parent=project, title only).
        IF jsonb_typeof(_new_components) = 'object' AND _new_components <> '{}'::jsonb THEN
            _insert_inputs := '[]'::jsonb;
            _insert_keys := ARRAY[]::text[];
            FOR _key, _name IN SELECT k, _new_components->>k FROM jsonb_object_keys(_new_components) AS k
            LOOP
                _insert_inputs := _insert_inputs || jsonb_build_array(jsonb_build_object(
                    'card_type_name', 'component',
                    'parent_card_id', _project_id::text,
                    'title', _name
                ));
                _insert_keys := array_append(_insert_keys, _key);
            END LOOP;
            FOR _ci_idx, _ci_ok, _ci_code, _ci_message, _ci_result IN
                SELECT ci.idx, ci.ok, ci.code, ci.message, ci.result
                FROM card_insert_batch(actor_id, _insert_inputs) ci
                ORDER BY ci.idx
            LOOP
                IF NOT _ci_ok THEN
                    RAISE EXCEPTION 'project.import.commit: auto-create components[%]: % %', _ci_idx, _ci_code, _ci_message;
                END IF;
                _ci_id := (_ci_result->>'id')::bigint;
                _components := _components || jsonb_build_object(_insert_keys[_ci_idx + 1], _ci_id::text);
            END LOOP;
        END IF;

        -- Tags (parent=project, path attribute).
        IF jsonb_typeof(_new_tags) = 'object' AND _new_tags <> '{}'::jsonb THEN
            _insert_inputs := '[]'::jsonb;
            _insert_keys := ARRAY[]::text[];
            FOR _key, _name IN SELECT k, _new_tags->>k FROM jsonb_object_keys(_new_tags) AS k
            LOOP
                _insert_inputs := _insert_inputs || jsonb_build_array(jsonb_build_object(
                    'card_type_name', 'tag',
                    'parent_card_id', _project_id::text,
                    'title', _name,
                    'attributes', jsonb_build_object('path', _name)
                ));
                _insert_keys := array_append(_insert_keys, _key);
            END LOOP;
            FOR _ci_idx, _ci_ok, _ci_code, _ci_message, _ci_result IN
                SELECT ci.idx, ci.ok, ci.code, ci.message, ci.result
                FROM card_insert_batch(actor_id, _insert_inputs) ci
                ORDER BY ci.idx
            LOOP
                IF NOT _ci_ok THEN
                    RAISE EXCEPTION 'project.import.commit: auto-create tags[%]: % %', _ci_idx, _ci_code, _ci_message;
                END IF;
                _ci_id := (_ci_result->>'id')::bigint;
                _tags := _tags || jsonb_build_object(_insert_keys[_ci_idx + 1], _ci_id::text);
            END LOOP;
        END IF;

        ---------------------------------------------------------------
        -- Pick a default status card for the project (Gate 6 - tasks
        -- require the (task, status) edge). Same priority chain as the
        -- legacy Go body: phase=triage first then phase=active, ordered
        -- by sort_order ASC then id ASC; status cards without sort_order
        -- sink to the back via the 2^31 default.
        ---------------------------------------------------------------
        IF jsonb_array_length(_tasks) > 0 THEN
            SELECT c.id INTO _status_id
            FROM card c
            JOIN card_type ct ON ct.id = c.card_type_id
            LEFT JOIN attribute_value av ON av.card_id = c.id
                 AND av.attribute_def_id = (SELECT id FROM attribute_def WHERE name='sort_order')
            WHERE ct.name = 'status'
              AND c.parent_card_id = _project_id
              AND c.deleted_at IS NULL
              AND c.phase IN ('triage', 'active')
            ORDER BY
                CASE c.phase WHEN 'triage' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                COALESCE(av.value::text::numeric, 2147483647::numeric),
                c.id
            LIMIT 1;
            IF _status_id IS NULL THEN
                RETURN QUERY SELECT _idx, false, 'flow_no_default'::text,
                    format('project.import: project %s has no usable starting status; add a status (phase=triage or active) before importing tasks', _project_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        ---------------------------------------------------------------
        -- Insert tasks via card_insert_batch (one batched call).
        ---------------------------------------------------------------
        _created_tasks := 0;
        IF jsonb_array_length(_tasks) > 0 THEN
            _insert_inputs := '[]'::jsonb;
            FOR _row IN SELECT v FROM jsonb_array_elements(_tasks) AS v
            LOOP
                _task_attrs := jsonb_build_object();
                IF (_row->>'description') <> '' THEN
                    _task_attrs := _task_attrs || jsonb_build_object('description', _row->>'description');
                END IF;
                IF (_row->>'sort_order') <> '' THEN
                    -- Cast string to JSON number directly.
                    _task_attrs := _task_attrs || jsonb_build_object('sort_order', (_row->>'sort_order')::numeric);
                END IF;
                IF (_row->>'milestone_title') <> '' THEN
                    _ml_id := (_milestones->>(_row->>'milestone_title'))::bigint;
                    IF _ml_id IS NOT NULL THEN
                        _task_attrs := _task_attrs || jsonb_build_object('milestone_ref', _ml_id);
                    END IF;
                END IF;
                IF (_row->>'component_title') <> '' THEN
                    _co_id := (_components->>(_row->>'component_title'))::bigint;
                    IF _co_id IS NOT NULL THEN
                        _task_attrs := _task_attrs || jsonb_build_object('component_ref', _co_id);
                    END IF;
                END IF;
                -- tag_paths
                _tag_id_arr := ARRAY[]::bigint[];
                FOR _v IN SELECT jsonb_array_elements_text(_row->'tag_paths')
                LOOP
                    _t_id := (_tags->>_v)::bigint;
                    IF _t_id IS NOT NULL THEN
                        _tag_id_arr := array_append(_tag_id_arr, _t_id);
                    END IF;
                END LOOP;
                IF array_length(_tag_id_arr, 1) IS NOT NULL THEN
                    _task_attrs := _task_attrs || jsonb_build_object('tags', to_jsonb(_tag_id_arr));
                END IF;
                IF (_row->>'assignee_email') <> '' THEN
                    _pe_id := (_persons->>(_row->>'assignee_email'))::bigint;
                    IF _pe_id IS NOT NULL THEN
                        _task_attrs := _task_attrs || jsonb_build_object('assignee', _pe_id);
                    END IF;
                END IF;
                _task_attrs := _task_attrs || jsonb_build_object('status', _status_id);
                _insert_inputs := _insert_inputs || jsonb_build_array(jsonb_build_object(
                    'card_type_name', 'task',
                    'parent_card_id', _project_id::text,
                    'title', _row->>'title',
                    'attributes', _task_attrs
                ));
            END LOOP;
            FOR _ci_idx, _ci_ok, _ci_code, _ci_message, _ci_result IN
                SELECT ci.idx, ci.ok, ci.code, ci.message, ci.result
                FROM card_insert_batch(actor_id, _insert_inputs) ci
                ORDER BY ci.idx
            LOOP
                IF NOT _ci_ok THEN
                    RAISE EXCEPTION 'project.import.commit: insert tasks[%]: % %', _ci_idx, _ci_code, _ci_message;
                END IF;
                _created_tasks := _created_tasks + 1;
            END LOOP;
        END IF;

        _summary := jsonb_build_object(
            'created', jsonb_build_object(
                'tasks', _created_tasks,
                'persons', (SELECT count(*) FROM jsonb_object_keys(_new_persons)),
                'milestones', (SELECT count(*) FROM jsonb_object_keys(_new_milestones)),
                'components', (SELECT count(*) FROM jsonb_object_keys(_new_components)),
                'tags', (SELECT count(*) FROM jsonb_object_keys(_new_tags))
            ),
            'errors', '[]'::jsonb,
            'status', 'completed',
            'skipped_rows', _skipped,
            'processed_rows', _processed
        );

        UPDATE import_job
           SET status = 'completed',
               summary = _summary,
               completed_at = now()
         WHERE id = _job_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _summary;
    END LOOP;
END;
$$;

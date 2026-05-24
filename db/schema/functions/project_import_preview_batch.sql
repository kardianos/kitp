-- project.import.preview handler (Phase 4 of UNIFIED_HANDLER_PLAN.md).
--
-- Dry-run pass: applies mapping + resolution to every row, returns
-- would_create counts + per-row error log. Persists the resolution +
-- summary on import_job so the wizard can resume.
--
-- CSV parsing runs Go-side via the PreRun hook — by the time this
-- function executes, the input JSON carries `_parsed_header` and
-- `_parsed_rows` alongside the original `job_id` / `resolution`.
-- This keeps the SQL function pure-walk over JSON arrays (cheap;
-- the JSON encoding cost is bounded by the CSV size we already
-- accepted at upload time).
--
-- Per-row pipeline:
--   1. Validate job_id + resolution modes.
--   2. Load job (status, mapping); reject if mapping is unset.
--   3. Pull pre-parsed header + rows out of the input JSON.
--   4. Build per-project lookups (milestonesByTitle, componentsByTitle,
--      tagsByPath via existing card + attribute_value rows; personsByEmail
--      is global across the install).
--   5. Walk rows: per cell, mirror the Go dryRun decision tree —
--      title required; milestone / component lookup with skip /
--      auto_create / leave_blank; tags split by comma; assignee_email
--      lookup; sort_order numeric check; flag unknown mapping targets
--      once at the top of the error log.
--   6. UPDATE import_job — write resolution + summary; advance status
--      to 'previewed'.
--
-- Result JSON matches `projectimport.PreviewOutput`:
--   {"would_create": {...}, "errors": [...], "skipped_rows": N,
--    "processed_rows": N, "status": "previewed"}
CREATE OR REPLACE FUNCTION project_import_preview_batch(
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
    _resolution jsonb;
    _r_persons text;
    _r_milestones text;
    _r_components text;
    _r_tags text;
    _job_status text;
    _project_id bigint;
    _mapping jsonb;
    _header jsonb;
    _rows jsonb;
    _summary jsonb;
    _processed int;
    _skipped int;
    _tasks_kept int;
    -- Per-row state.
    _ri int;
    _row jsonb;
    _row_num int;
    _row_skip boolean;
    _row_errors jsonb;
    _cell text;
    _v text;
    _norm text;
    _col_idx int;
    _col_idx_title int;
    _col_idx_milestone int;
    _col_idx_component int;
    _col_idx_tags int;
    _col_idx_assignee int;
    _col_idx_sort int;
    _header_name text;
    _target text;
    _hdr_pos int;
    _errors jsonb;
    _unknown_targets jsonb;
    -- Lookup maps stored as jsonb objects (normalised_value -> id).
    _milestones jsonb;
    _components jsonb;
    _tags jsonb;
    _persons jsonb;
    -- Auto-create dedup sets.
    _new_persons jsonb;
    _new_milestones jsonb;
    _new_components jsonb;
    _new_tags jsonb;
    _allowed_targets text[] := ARRAY['id','title','assignee_email','assignee_name',
                                     'milestone','component','tags','description','sort_order'];
    _ref_skip boolean;
    _ref_error_msg text;
    _tag_part text;
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
                'project.import.preview: job_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        _resolution := COALESCE(_raw->'resolution', '{}'::jsonb);
        _r_persons := COALESCE(_resolution->>'persons', '');
        _r_milestones := COALESCE(_resolution->>'milestones', '');
        _r_components := COALESCE(_resolution->>'components', '');
        _r_tags := COALESCE(_resolution->>'tags', '');

        -- Resolution mode validation. Empty = default (match_existing).
        IF _r_persons NOT IN ('', 'match_existing','auto_create','skip','leave_blank') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('project.import.preview: resolution.persons: %L not allowed', _r_persons),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _r_milestones NOT IN ('', 'match_existing','auto_create','skip','leave_blank') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('project.import.preview: resolution.milestones: %L not allowed', _r_milestones),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _r_components NOT IN ('', 'match_existing','auto_create','skip','leave_blank') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('project.import.preview: resolution.components: %L not allowed', _r_components),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _r_tags NOT IN ('', 'match_existing','auto_create','skip','leave_blank') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('project.import.preview: resolution.tags: %L not allowed', _r_tags),
                NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT j.status, j.project_id, COALESCE(j.mapping, 'null'::jsonb)
          INTO _job_status, _project_id, _mapping
        FROM import_job j WHERE j.id = _job_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'job_not_found'::text,
                format('project.import.preview: job %s not found', _job_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _mapping IS NULL OR jsonb_typeof(_mapping) = 'null' THEN
            RETURN QUERY SELECT _idx, false, 'no_mapping'::text,
                'project.import.preview: job has no mapping; call set_mapping first'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        _header := COALESCE(_raw->'_parsed_header', '[]'::jsonb);
        _rows := COALESCE(_raw->'_parsed_rows', '[]'::jsonb);

        -- Build lookup tables. Each is a jsonb object: normalised_value -> id.
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

        -- Build colIdxByAttr from header + mapping, flag unknown targets.
        _col_idx_title := -1;
        _col_idx_milestone := -1;
        _col_idx_component := -1;
        _col_idx_tags := -1;
        _col_idx_assignee := -1;
        _col_idx_sort := -1;
        _unknown_targets := '{}'::jsonb;
        _hdr_pos := 0;
        FOR _header_name IN SELECT v #>> '{}' FROM jsonb_array_elements(_header) AS v
        LOOP
            _target := _mapping->>_header_name;
            IF _target IS NULL OR _target = '' OR _target = '_ignore_' THEN
                _hdr_pos := _hdr_pos + 1;
                CONTINUE;
            END IF;
            IF NOT (_target = ANY(_allowed_targets)) THEN
                _unknown_targets := _unknown_targets || jsonb_build_object(_target, true);
                _hdr_pos := _hdr_pos + 1;
                CONTINUE;
            END IF;
            CASE _target
                WHEN 'title' THEN _col_idx_title := _hdr_pos;
                WHEN 'milestone' THEN _col_idx_milestone := _hdr_pos;
                WHEN 'component' THEN _col_idx_component := _hdr_pos;
                WHEN 'tags' THEN _col_idx_tags := _hdr_pos;
                WHEN 'assignee_email' THEN _col_idx_assignee := _hdr_pos;
                WHEN 'sort_order' THEN _col_idx_sort := _hdr_pos;
                ELSE NULL;
            END CASE;
            _hdr_pos := _hdr_pos + 1;
        END LOOP;

        _errors := '[]'::jsonb;
        FOR _target IN SELECT k FROM jsonb_object_keys(_unknown_targets) AS k
        LOOP
            _errors := _errors || jsonb_build_array(
                jsonb_build_object(
                    'row', 0,
                    'column', _target,
                    'message', format('mapping target "%s" is not a known task column', _target)
                ));
        END LOOP;

        _new_persons := '{}'::jsonb;
        _new_milestones := '{}'::jsonb;
        _new_components := '{}'::jsonb;
        _new_tags := '{}'::jsonb;
        _processed := 0;
        _skipped := 0;
        _tasks_kept := 0;

        _ri := 0;
        FOR _row IN SELECT v FROM jsonb_array_elements(_rows) AS v
        LOOP
            _row_num := _ri + 2; -- header is row 1
            _row_skip := false;
            _row_errors := '[]'::jsonb;

            -- title required (if mapped).
            IF _col_idx_title >= 0 THEN
                _cell := COALESCE(_row->>_col_idx_title, '');
                IF _cell = '' THEN
                    _row_errors := _row_errors || jsonb_build_array(
                        jsonb_build_object('row', _row_num, 'column', 'title',
                            'message', 'title is required'));
                END IF;
            END IF;

            -- milestone
            IF _col_idx_milestone >= 0 THEN
                _cell := COALESCE(_row->>_col_idx_milestone, '');
                _v := btrim(_cell);
                IF _v <> '' THEN
                    _norm := lower(_v);
                    IF NOT (_milestones ? _norm) THEN
                        -- decideRefMode
                        _ref_skip := false;
                        _ref_error_msg := NULL;
                        IF _r_milestones = 'skip' THEN
                            _ref_skip := true;
                        ELSIF _r_milestones IN ('auto_create','leave_blank') THEN
                            -- accept
                            NULL;
                        ELSE
                            _ref_error_msg := format('unknown milestone "%s" (no resolution mode set)', _v);
                        END IF;
                        IF _ref_skip THEN _row_skip := true; END IF;
                        IF _ref_error_msg IS NOT NULL THEN
                            _row_errors := _row_errors || jsonb_build_array(
                                jsonb_build_object('row', _row_num, 'column', 'milestone',
                                    'message', _ref_error_msg));
                        ELSIF _r_milestones = 'auto_create' THEN
                            _new_milestones := _new_milestones || jsonb_build_object(_norm, _v);
                        END IF;
                    END IF;
                END IF;
            END IF;

            -- component
            IF _col_idx_component >= 0 THEN
                _cell := COALESCE(_row->>_col_idx_component, '');
                _v := btrim(_cell);
                IF _v <> '' THEN
                    _norm := lower(_v);
                    IF NOT (_components ? _norm) THEN
                        _ref_skip := false;
                        _ref_error_msg := NULL;
                        IF _r_components = 'skip' THEN
                            _ref_skip := true;
                        ELSIF _r_components IN ('auto_create','leave_blank') THEN
                            NULL;
                        ELSE
                            _ref_error_msg := format('unknown component "%s" (no resolution mode set)', _v);
                        END IF;
                        IF _ref_skip THEN _row_skip := true; END IF;
                        IF _ref_error_msg IS NOT NULL THEN
                            _row_errors := _row_errors || jsonb_build_array(
                                jsonb_build_object('row', _row_num, 'column', 'component',
                                    'message', _ref_error_msg));
                        ELSIF _r_components = 'auto_create' THEN
                            _new_components := _new_components || jsonb_build_object(_norm, _v);
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
                    IF NOT (_tags ? _norm) THEN
                        _ref_skip := false;
                        _ref_error_msg := NULL;
                        IF _r_tags = 'skip' THEN
                            _ref_skip := true;
                        ELSIF _r_tags IN ('auto_create','leave_blank') THEN
                            NULL;
                        ELSE
                            _ref_error_msg := format('unknown tag "%s" (no resolution mode set)', _v);
                        END IF;
                        IF _ref_skip THEN _row_skip := true; END IF;
                        IF _ref_error_msg IS NOT NULL THEN
                            _row_errors := _row_errors || jsonb_build_array(
                                jsonb_build_object('row', _row_num, 'column', 'tag',
                                    'message', _ref_error_msg));
                        ELSIF _r_tags = 'auto_create' THEN
                            _new_tags := _new_tags || jsonb_build_object(_norm, _v);
                        END IF;
                    END IF;
                END LOOP;
            END IF;

            -- assignee_email
            IF _col_idx_assignee >= 0 THEN
                _cell := COALESCE(_row->>_col_idx_assignee, '');
                _v := btrim(_cell);
                IF _v <> '' THEN
                    _norm := lower(_v);
                    IF NOT (_persons ? _norm) THEN
                        _ref_skip := false;
                        _ref_error_msg := NULL;
                        IF _r_persons = 'skip' THEN
                            _ref_skip := true;
                        ELSIF _r_persons IN ('auto_create','leave_blank') THEN
                            NULL;
                        ELSE
                            _ref_error_msg := format('unknown person "%s" (no resolution mode set)', _v);
                        END IF;
                        IF _ref_skip THEN _row_skip := true; END IF;
                        IF _ref_error_msg IS NOT NULL THEN
                            _row_errors := _row_errors || jsonb_build_array(
                                jsonb_build_object('row', _row_num, 'column', 'person',
                                    'message', _ref_error_msg));
                        ELSIF _r_persons = 'auto_create' THEN
                            _new_persons := _new_persons || jsonb_build_object(_norm, _v);
                        END IF;
                    END IF;
                END IF;
            END IF;

            -- sort_order numeric
            IF _col_idx_sort >= 0 THEN
                _cell := COALESCE(_row->>_col_idx_sort, '');
                _v := btrim(_cell);
                IF _v <> '' THEN
                    BEGIN
                        PERFORM _v::numeric;
                    EXCEPTION WHEN invalid_text_representation THEN
                        _row_errors := _row_errors || jsonb_build_array(
                            jsonb_build_object('row', _row_num, 'column', 'sort_order',
                                'message', format('sort_order "%s" is not numeric', _v)));
                    END;
                END IF;
            END IF;

            IF _row_skip THEN
                _skipped := _skipped + 1;
            ELSE
                _errors := _errors || _row_errors;
                IF jsonb_array_length(_row_errors) = 0 THEN
                    _tasks_kept := _tasks_kept + 1;
                END IF;
                _processed := _processed + 1;
            END IF;
            _ri := _ri + 1;
        END LOOP;

        _summary := jsonb_build_object(
            'would_create', jsonb_build_object(
                'tasks', _tasks_kept,
                'persons', (SELECT count(*) FROM jsonb_object_keys(_new_persons)),
                'milestones', (SELECT count(*) FROM jsonb_object_keys(_new_milestones)),
                'components', (SELECT count(*) FROM jsonb_object_keys(_new_components)),
                'tags', (SELECT count(*) FROM jsonb_object_keys(_new_tags))
            ),
            'errors', _errors,
            'skipped_rows', _skipped,
            'processed_rows', _processed,
            'status', 'previewed'
        );

        UPDATE import_job
           SET resolution = _resolution,
               summary    = _summary,
               status     = 'previewed'
         WHERE id = _job_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _summary;
    END LOOP;
END;
$$;

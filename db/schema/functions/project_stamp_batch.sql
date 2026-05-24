-- project.stamp handler (Phase 4 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runStamp / stampOne / loadDescendants / copyFlows /
-- copyFlowSteps / copyAttributeValues into a one-line wrapper around
-- the shared copy_project_template helper.
--
-- Per-row pipeline:
--   1. Validate (template_project_id + name required).
--   2. Verify template exists and is a project card.
--   3. INSERT the new project card (no parent) + card_create activity.
--   4. Write the project's `title` attribute_value (from input).
--   5. Write the project's `is_template` attribute_value = FALSE so the
--      stamp output is not itself flagged as a template.
--   6. PERFORM copy_project_template(template_id, new_project_id, actor_id)
--      to graph-copy the full descendant set (status / milestone / screen /
--      filter / predicate_snippet cards + flows + flow_steps + their
--      attribute_values, with ID remap).
--   7. Compute V24 warnings (`template_empty` / `template_no_flows`) by
--      querying the new project's children after the helper returns.
--
-- Result JSON shape matches `projectstamp.StampOutput`:
--   {"new_project_id": "<bigint>", "warnings": [...]}
-- The bigint id is cast to text (Go's `json:",string"` tag).
CREATE OR REPLACE FUNCTION project_stamp_batch(
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
    _template_id bigint;
    _name text;
    _project_ct_id bigint;
    _template_ct_id bigint;
    _new_project_id bigint;
    _title_def_id bigint;
    _is_template_def_id bigint;
    _activity_id bigint;
    _descendant_count int;
    _flow_count int;
    _warnings jsonb;
BEGIN
    -- Hoist the project card_type id (single global value).
    SELECT id INTO _project_ct_id FROM card_type WHERE name = 'project';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'project.stamp: card_type ''project'' missing';
    END IF;

    -- Hoist the title + is_template attribute_def ids.
    SELECT id INTO _title_def_id FROM attribute_def WHERE name = 'title';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'project.stamp: attribute_def ''title'' missing';
    END IF;
    SELECT id INTO _is_template_def_id FROM attribute_def WHERE name = 'is_template';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'project.stamp: attribute_def ''is_template'' missing';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode + validate.
        BEGIN
            _template_id := NULLIF(_raw->>'template_project_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _template_id := NULL;
        END;
        _name := _raw->>'name';

        IF _template_id IS NULL OR _template_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'project.stamp: template_project_id is required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _name IS NULL OR _name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'project.stamp: name is required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Verify template exists and is a project card.
        SELECT card_type_id INTO _template_ct_id
        FROM card
        WHERE id = _template_id AND deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'template_not_found'::text,
                format('project.stamp: template project %s not found', _template_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _template_ct_id <> _project_ct_id THEN
            RETURN QUERY SELECT _idx, false, 'template_not_project'::text,
                format('project.stamp: card %s is not a project', _template_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. INSERT the new project card (no parent). Phase defaults to
        --    'triage' via the card table's default. card_create activity
        --    matches the audit-trail shape of card.insert.
        INSERT INTO card (card_type_id) VALUES (_project_ct_id)
        RETURNING id INTO _new_project_id;

        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_new_project_id, 'card_create', actor_id);

        -- 4. Write the project's title attribute_value (attr_update activity +
        --    upsert; same shape as card.insert's title write).
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_new_project_id, 'attr_update', _title_def_id, NULL, to_jsonb(_name), actor_id)
        RETURNING id INTO _activity_id;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_new_project_id, _title_def_id, to_jsonb(_name), _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- 5. Write the project's is_template = FALSE attribute_value. This
        --    is what distinguishes a stamped project from its template — the
        --    template carries is_template=TRUE; the stamp output must NOT,
        --    or it would itself be picked up as a stamp source. The
        --    template's own is_template attribute_value is filtered out by
        --    copy_project_template (the `av.card_id <> template_id` clause),
        --    so writing here is safe — the helper won't overwrite it.
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_new_project_id, 'attr_update', _is_template_def_id, NULL, to_jsonb(FALSE), actor_id)
        RETURNING id INTO _activity_id;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_new_project_id, _is_template_def_id, to_jsonb(FALSE), _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- 6. Graph-copy the template's descendant structure via the shared
        --    helper. This is the same helper card.insert(project) calls
        --    after the bare project row lands — one source of truth.
        PERFORM copy_project_template(_template_id, _new_project_id, actor_id);

        -- 7. Compute V24 warnings. `template_empty` fires when the new
        --    project has no descendants (no value cards / screens / filters
        --    were copied). `template_no_flows` fires when the new project
        --    has descendants but no flow rows (usable but probably an
        --    oversight). Mirrors projectstamp.stampOne's warning logic.
        SELECT count(*) INTO _descendant_count
        FROM card WHERE parent_card_id = _new_project_id AND deleted_at IS NULL;
        SELECT count(*) INTO _flow_count
        FROM flow WHERE scope_card_id = _new_project_id;

        _warnings := '[]'::jsonb;
        IF _descendant_count = 0 THEN
            _warnings := _warnings || to_jsonb(
                'template_empty: no value cards, screens, or filter cards were copied (V24)'::text);
        END IF;
        IF _flow_count = 0 AND _descendant_count > 0 THEN
            _warnings := _warnings || to_jsonb(
                'template_no_flows: template carried no flow rows; new project has no transition gating'::text);
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'new_project_id', _new_project_id::text,
                'warnings', _warnings
            );
    END LOOP;
END;
$$;

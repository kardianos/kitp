-- project.compose handler — create a project from feature bundles instead
-- of copying one template: the new-project dialog's preset path.
--
-- Input:
--   {"name": "…", "description": "…"?,          -- title / description
--    "preset": "<preset key>"?,                  -- its features, in order
--    "features": ["<feature key>", …]?,          -- added after the preset's
--    "areas_off": ["<area key>", …]?}            -- areas switched off from
--                                                    the start (docs/AREAS.md)
-- At least one feature must result. Duplicates collapse (first wins).
--
-- Writes the project card + title (+ description) + is_template=false the
-- way project.stamp does, WITHOUT card.insert's auto-stamp of the standard
-- template, then bundle_apply()s each feature in order. Any conflict or
-- unknown key fails the row (and rolls the batch back), so a project is
-- never left half-composed.
--
-- Result: {"new_project_id": "<id>", "features": ["tracker", …]}
--
-- Authz: same as project.stamp — a brand-new project has no scope to check
-- (GlobalScope), and only worker / manager / admin may call it.
CREATE OR REPLACE FUNCTION project_compose_batch(
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
    _project_ct_id bigint;
    _title_def_id bigint;
    _is_template_def_id bigint;
    _description_def_id bigint;
    _idx int;
    _raw jsonb;
    _name text;
    _description text;
    _preset text;
    _features text[];
    _extra text;
    _key text;
    _new_project_id bigint;
    _activity_id bigint;
    _r jsonb;
    _failed jsonb;
BEGIN
    SELECT id INTO _project_ct_id FROM card_type WHERE name = 'project';
    SELECT id INTO _title_def_id FROM attribute_def WHERE name = 'title';
    SELECT id INTO _is_template_def_id FROM attribute_def WHERE name = 'is_template';
    SELECT id INTO _description_def_id FROM attribute_def WHERE name = 'description';
    IF _project_ct_id IS NULL OR _title_def_id IS NULL OR _is_template_def_id IS NULL THEN
        RAISE EXCEPTION 'project.compose: project card_type / title / is_template missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- A new project is a workspace-wide act: it needs a workspace-wide
        -- grant to create projects, as card.insert {project} does. A role
        -- scoped to one project doesn't make projects (review 2026-11-03
        -- round 2 #14).
        IF NOT user_has_grant(project_compose_batch.actor_id, 'project', 'card.create', NULL::bigint) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'project.compose: creating a project needs a workspace-wide role that may create projects'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _name := btrim(COALESCE(_raw->>'name', ''));
        _description := _raw->>'description';
        _preset := NULLIF(btrim(COALESCE(_raw->>'preset', '')), '');
        IF _name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'project.compose: name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 1. Resolve the feature list: the preset's, then the extras.
        _features := ARRAY[]::text[];
        IF _preset IS NOT NULL THEN
            SELECT ARRAY(SELECT jsonb_array_elements_text(b.features))
              INTO _features
            FROM bundle b WHERE b.key = _preset AND b.kind = 'preset';
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'bundle_unknown'::text,
                    format('project.compose: no preset %L', _preset), NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;
        IF jsonb_typeof(_raw->'features') = 'array' THEN
            FOR _extra IN SELECT jsonb_array_elements_text(_raw->'features')
            LOOP
                IF NOT (_extra = ANY(_features)) THEN
                    _features := _features || _extra;
                END IF;
            END LOOP;
        END IF;
        IF cardinality(_features) = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'project.compose: choose a preset or at least one feature'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. The bare project (project.stamp's shape, minus the template).
        INSERT INTO card (card_type_id) VALUES (_project_ct_id)
        RETURNING id INTO _new_project_id;
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_new_project_id, 'card_create', actor_id);

        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_new_project_id, 'attr_update', _title_def_id, NULL, to_jsonb(_name), actor_id)
        RETURNING id INTO _activity_id;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_new_project_id, _title_def_id, to_jsonb(_name), _activity_id);

        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_new_project_id, 'attr_update', _is_template_def_id, NULL, to_jsonb(false), actor_id)
        RETURNING id INTO _activity_id;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_new_project_id, _is_template_def_id, to_jsonb(false), _activity_id);

        IF _description IS NOT NULL AND _description <> '' AND _description_def_id IS NOT NULL THEN
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (_new_project_id, 'attr_update', _description_def_id, NULL, to_jsonb(_description), actor_id)
            RETURNING id INTO _activity_id;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (_new_project_id, _description_def_id, to_jsonb(_description), _activity_id);
        END IF;

        -- 3. The features, in order. A failure aborts the whole request
        --    (the dispatcher rolls the batch back on a failed row).
        _failed := NULL;
        FOREACH _key IN ARRAY _features
        LOOP
            _r := bundle_apply(_new_project_id, _key, actor_id);
            IF _r->>'status' IN ('conflict', 'unknown') THEN
                _failed := _r;
                EXIT;
            END IF;
        END LOOP;
        IF _failed IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false,
                CASE WHEN _failed->>'status' = 'conflict' THEN 'bundle_conflict' ELSE 'bundle_unknown' END,
                format('project.compose: %s', _failed->>'message'), NULL::jsonb;
            CONTINUE;
        END IF;

        -- The areas the dialog left unticked start off. A key that isn't a
        -- project area fails the row (nothing is half-made: the batch
        -- rolls back).
        IF jsonb_typeof(_raw->'areas_off') = 'array' THEN
            FOR _extra IN SELECT jsonb_array_elements_text(_raw->'areas_off')
            LOOP
                IF NOT EXISTS (SELECT 1 FROM area WHERE key = _extra AND scope = 'project') THEN
                    RAISE EXCEPTION 'project.compose: % isn''t a project area', _extra USING ERRCODE = 'P0001';
                END IF;
                INSERT INTO project_area (project_id, area_key, state, changed_at, changed_by)
                VALUES (_new_project_id, _extra, 'off', now(), actor_id)
                ON CONFLICT (project_id, area_key) DO UPDATE SET state = 'off';
            END LOOP;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'new_project_id', _new_project_id::text,
                'features', to_jsonb(_features));
    END LOOP;
END;
$$;

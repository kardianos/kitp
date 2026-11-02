-- area.set handler — switch an area on or off (docs/AREAS.md).
--
-- Input:  {"project_id"?, "key", "on": bool, "start"?}
--         project_id for a project area; none for a workspace area (Sites).
--         start: the starting point (a feature bundle of the area) to add
--         when turning on an area that never had one; default = its first.
-- Result: {"key", "state": "on" | "off", "applied": [bundle key…]}
--
-- Rules:
--   - Turning ON exposes what the area holds, so it is admin-only (an
--     admin role that is global or scoped to the project). It turns on
--     the areas it depends on as well, and adds a starting point to any
--     of them the project doesn't have yet (area_present: a project with
--     the area's own flow or items, e.g. one from a template or from
--     before areas, gets none).
--   - Turning OFF needs a manager or admin; a workspace area needs an
--     admin. It is refused while an area that depends on this one is on
--     ('area_needed').
--   - A change writes project_area / workspace_area and an 'area_set'
--     activity row on the project, and rebuilds the portals holding the
--     project's pages (their pages come off or go back on).
CREATE OR REPLACE FUNCTION area_set_batch(
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
    _project bigint;
    _key text;
    _on boolean;
    _start text;
    _area area%ROWTYPE;
    _admin boolean;
    _manager boolean;
    _turn text[];
    _k text;
    _a area%ROWTYPE;
    _st text;
    _applied text[];
    _r jsonb;
    _blocker text;
    _portal bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _project := COALESCE(NULLIF(_raw->>'project_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'area.set: project_id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END;
        _key := _raw->>'key';
        _on := CASE WHEN jsonb_typeof(_raw->'on') = 'boolean' THEN (_raw->>'on')::boolean END;
        _start := NULLIF(_raw->>'start', '');
        IF _key IS NULL OR _on IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'area.set: key and on are required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT * INTO _area FROM area WHERE key = _key;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                format('area.set: there is no area %L', _key), NULL::jsonb;
            CONTINUE;
        END IF;
        IF (_area.scope = 'project') <> (_project <> 0) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                CASE WHEN _area.scope = 'project'
                     THEN format('area.set: %s is switched per project; give project_id', _area.title)
                     ELSE format('area.set: %s is switched for the whole workspace; give no project_id', _area.title)
                END, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _project <> 0 AND NOT EXISTS (
            SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
            WHERE c.id = _project AND c.deleted_at IS NULL) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                format('area.set: project %s not found', _project), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _start IS NOT NULL AND NOT _area.starts ? _start THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('area.set: %L isn''t a starting point of %s', _start, _area.title), NULL::jsonb;
            CONTINUE;
        END IF;

        -- Who: admins turn on (and switch workspace areas); managers can
        -- also turn a project area off.
        SELECT
            bool_or(r.name = 'admin'),
            bool_or(r.name IN ('admin', 'manager'))
          INTO _admin, _manager
        FROM user_account caller
        CROSS JOIN LATERAL user_role_effective(caller.id) ur
        JOIN role r ON r.id = ur.role_id
        WHERE caller.id = area_set_batch.actor_id
          AND (ur.scope_card_id IS NULL OR (_project <> 0 AND ur.scope_card_id = _project));
        IF NOT COALESCE(CASE WHEN _on OR _project = 0 THEN _admin ELSE _manager END, false) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                CASE WHEN _on THEN format('area.set: only an admin can switch %s on', _area.title)
                     ELSE format('area.set: only a manager or admin can switch %s off', _area.title) END,
                NULL::jsonb;
            CONTINUE;
        END IF;

        _applied := ARRAY[]::text[];
        IF _on THEN
            -- This area and, first, every area it needs (one level; the
            -- catalog's dependencies are one level deep).
            _turn := ARRAY(SELECT jsonb_array_elements_text(_area.depends_on)) || ARRAY[_key];
            FOREACH _k IN ARRAY _turn LOOP
                SELECT * INTO _a FROM area WHERE key = _k;
                -- A starting point, if the project doesn't have the area yet.
                IF jsonb_array_length(_a.starts) > 0 AND _project <> 0 AND NOT area_present(_project, _k) THEN
                    _st := CASE WHEN _k = _key AND _start IS NOT NULL THEN _start ELSE _a.starts->>0 END;
                    _r := bundle_apply(_project, _st, area_set_batch.actor_id);
                    IF _r->>'status' NOT IN ('applied', 'updated') THEN
                        RAISE EXCEPTION 'area.set: % couldn''t start from %: %', _a.title, _st, COALESCE(_r->>'message', _r->>'status')
                            USING ERRCODE = 'P0001';
                    END IF;
                    _applied := _applied || _st;
                END IF;
                IF _project = 0 THEN
                    INSERT INTO workspace_area (area_key, state, changed_at, changed_by)
                    VALUES (_k, 'on', now(), area_set_batch.actor_id)
                    ON CONFLICT (area_key) DO UPDATE SET state = 'on', changed_at = now(), changed_by = EXCLUDED.changed_by;
                ELSE
                    INSERT INTO project_area (project_id, area_key, state, changed_at, changed_by)
                    VALUES (_project, _k, 'on', now(), area_set_batch.actor_id)
                    ON CONFLICT (project_id, area_key) DO UPDATE SET state = 'on', changed_at = now(), changed_by = EXCLUDED.changed_by;
                END IF;
            END LOOP;
        ELSE
            -- Not while an area that needs this one is on.
            SELECT d.title INTO _blocker
            FROM area d
            WHERE d.depends_on ? _key AND area_state(_project, d.key) = 'on'
            ORDER BY d.sort_order LIMIT 1;
            IF _blocker IS NOT NULL THEN
                RETURN QUERY SELECT _idx, false, 'area_needed'::text,
                    format('area.set: %s uses %s; switch %s off first', _blocker, _area.title, _blocker), NULL::jsonb;
                CONTINUE;
            END IF;
            IF _project = 0 THEN
                INSERT INTO workspace_area (area_key, state, changed_at, changed_by)
                VALUES (_key, 'off', now(), area_set_batch.actor_id)
                ON CONFLICT (area_key) DO UPDATE SET state = 'off', changed_at = now(), changed_by = EXCLUDED.changed_by;
            ELSE
                INSERT INTO project_area (project_id, area_key, state, changed_at, changed_by)
                VALUES (_project, _key, 'off', now(), area_set_batch.actor_id)
                ON CONFLICT (project_id, area_key) DO UPDATE SET state = 'off', changed_at = now(), changed_by = EXCLUDED.changed_by;
            END IF;
        END IF;

        IF _project <> 0 THEN
            INSERT INTO activity (card_id, kind, value_new, actor_id)
            VALUES (_project, 'area_set',
                    jsonb_build_object('area', _key, 'state', CASE WHEN _on THEN 'on' ELSE 'off' END,
                                       'applied', to_jsonb(_applied)),
                    area_set_batch.actor_id);
            -- The project's pages come off (or go back on) its portals.
            FOR _portal IN
                SELECT DISTINCT p.portal_id FROM publication p
                WHERE card_enclosing_project(p.card_id) = _project
            LOOP
                PERFORM portal_mark_dirty(_portal);
            END LOOP;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('key', _key, 'state', CASE WHEN _on THEN 'on' ELSE 'off' END,
                               'applied', to_jsonb(_applied));
    END LOOP;
END;
$$;

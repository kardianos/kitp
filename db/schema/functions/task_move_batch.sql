-- task.move handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side executeTaskMove (and its helpers
-- resolveIntakeStatusID / validateUnderProject /
-- descendantsByParentTask / clearParentTaskOnDirectChildren /
-- insertAttrValue) into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: card_id + new_project_id required; subtask_strategy
--      defaults to 'cascade' and must be 'cascade' | 'break'.
--   2. Moved card: must be a `task`, exist (not deleted). The
--      current project is the task's parent_card_id (or 0).
--   3. Destination project: must exist + be card_type 'project' +
--      distinct from current project.
--   4. Resolve destination status when omitted: pick the lowest-
--      sort-order status under the destination project, preferring
--      triage > active > anything; falls back through phases. If
--      the destination has no status cards → 'no_intake_status'.
--   5. validateUnderProject for each of status / milestone / component
--      / tags — every supplied id must be of the right card_type and
--      parented to the destination project. Otherwise per-attribute
--      code ('bad_status' / 'bad_milestone' / 'bad_component' / 'bad_tag').
--   6. Cascade subtree: in cascade mode, walk `parent_task`
--      attribute recursively; in break mode the moved set is the
--      task alone, and direct children get their parent_task
--      cleared after the move.
--   7. For every moved card: UPDATE parent_card_id, DELETE the four
--      per-project attribute_value rows (status / milestone_ref /
--      component_ref / tags), INSERT the chosen new values, INSERT
--      audit activity 'task_move'.
--   8. In break mode, DELETE parent_task / parent_relationship on
--      every direct child of the root task that DIDN'T ride along.
--
-- Result JSON shape matches `card.TaskMoveOutput`:
--   {
--     "moved_card_ids": [<bigint>...],
--     "broken_child_ids": [<bigint>...],         -- omit/empty when not break
--     "resolved_status_id": "<bigint>"
--   }
-- moved_card_ids and broken_child_ids are arrays of *integers* — the
-- Go struct's `[]int64` decodes JSON numbers, no `,string` tag. Only
-- `resolved_status_id` carries the `,string` tag and is emitted as a
-- string.
CREATE OR REPLACE FUNCTION task_move_batch(
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
    _card_id bigint;
    _new_project_id bigint;
    _new_status_id bigint;
    _new_milestone_id bigint;
    _new_component_id bigint;
    _new_tag_ids bigint[];
    _strategy text;
    _moved_type_id bigint;
    _current_project_id bigint;
    _dest_type_name text;
    _resolved_status bigint;
    _validate_err text;
    _moved_ids bigint[];
    _desc bigint[];
    _status_def_id bigint;
    _milestone_def_id bigint;
    _component_def_id bigint;
    _tags_def_id bigint;
    _parent_task_def_id bigint;
    _parent_relationship_def_id bigint;
    _m bigint;
    _tag bigint;
    _broken_ids bigint[];
    _tag_el jsonb;
    _value_card_type_name text;
    _value_parent bigint;
    _value_card_exists boolean;
BEGIN
    -- Hoist common attribute_def ids (they're shared across every input).
    SELECT id INTO _status_def_id FROM attribute_def WHERE name = 'status';
    SELECT id INTO _milestone_def_id FROM attribute_def WHERE name = 'milestone_ref';
    SELECT id INTO _component_def_id FROM attribute_def WHERE name = 'component_ref';
    SELECT id INTO _tags_def_id FROM attribute_def WHERE name = 'tags';
    SELECT id INTO _parent_task_def_id FROM attribute_def WHERE name = 'parent_task';
    SELECT id INTO _parent_relationship_def_id FROM attribute_def WHERE name = 'parent_relationship';

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode.
        BEGIN
            _card_id := NULLIF(_raw->>'card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN _card_id := NULL;
        END;
        BEGIN
            _new_project_id := NULLIF(_raw->>'new_project_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN _new_project_id := NULL;
        END;
        BEGIN
            _new_status_id := NULLIF(_raw->>'new_status_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN _new_status_id := NULL;
        END;
        BEGIN
            _new_milestone_id := NULLIF(_raw->>'new_milestone_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN _new_milestone_id := NULL;
        END;
        BEGIN
            _new_component_id := NULLIF(_raw->>'new_component_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN _new_component_id := NULL;
        END;
        _new_status_id := COALESCE(_new_status_id, 0);
        _new_milestone_id := COALESCE(_new_milestone_id, 0);
        _new_component_id := COALESCE(_new_component_id, 0);

        _new_tag_ids := ARRAY[]::bigint[];
        IF jsonb_typeof(_raw->'new_tag_ids') = 'array' THEN
            FOR _tag_el IN SELECT e.v FROM jsonb_array_elements(_raw->'new_tag_ids') AS e(v) LOOP
                IF jsonb_typeof(_tag_el) = 'number' THEN
                    _new_tag_ids := array_append(_new_tag_ids, (_tag_el)::text::bigint);
                ELSIF jsonb_typeof(_tag_el) = 'string'
                      AND (_tag_el #>> '{}') ~ '^-?\d+$' THEN
                    _new_tag_ids := array_append(_new_tag_ids, ((_tag_el #>> '{}')::bigint));
                END IF;
            END LOOP;
        END IF;

        _strategy := COALESCE(NULLIF(_raw->>'subtask_strategy', ''), 'cascade');

        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'task.move: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _new_project_id IS NULL OR _new_project_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'task.move: new_project_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _strategy NOT IN ('cascade', 'break') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('task.move: subtask_strategy must be ''cascade'' or ''break'' (got %L)', _strategy),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Moved card must exist + be a task.
        SELECT c.card_type_id, COALESCE(c.parent_card_id, 0)
          INTO _moved_type_id, _current_project_id
        FROM card c
        WHERE c.id = _card_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('task.move: card %s not found', _card_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        PERFORM 1 FROM card_type WHERE id = _moved_type_id AND name = 'task';
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'wrong_card_type'::text,
                format('task.move: card %s is not a task', _card_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Destination project: exists, type='project', distinct.
        IF _new_project_id = _current_project_id THEN
            RETURN QUERY SELECT _idx, false, 'same_project'::text,
                'task.move: source and destination project are the same'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT ct.name INTO _dest_type_name
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _new_project_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'project_not_found'::text,
                format('task.move: new_project_id %s not found', _new_project_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _dest_type_name <> 'project' THEN
            RETURN QUERY SELECT _idx, false, 'wrong_destination_type'::text,
                format('task.move: new_project_id %s is %L, not project',
                    _new_project_id, _dest_type_name),
                NULL::jsonb;
            CONTINUE;
        END IF;
        -- Cycle guard (A1 / SEC-1): never re-parent a task under itself
        -- or under a card inside its own subtree. A well-formed project
        -- can't be a descendant of a task, but guarding here keeps the
        -- invariant explicit and matches card.move. card_ancestors carries
        -- the depth cap.
        IF _new_project_id = _card_id
           OR EXISTS (SELECT 1 FROM card_ancestors(_new_project_id) a WHERE a.id = _card_id) THEN
            RETURN QUERY SELECT _idx, false, 'cycle'::text,
                format('task.move: cannot move card %s under itself or its own descendant %s',
                    _card_id, _new_project_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Resolve destination status if omitted.
        IF _new_status_id = 0 THEN
            SELECT c.id INTO _resolved_status
            FROM card c
            JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'status'
            LEFT JOIN attribute_value av ON av.card_id = c.id
                AND av.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'sort_order')
            WHERE c.parent_card_id = _new_project_id AND c.deleted_at IS NULL
            ORDER BY
                CASE c.phase WHEN 'triage' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                COALESCE((av.value)::text::numeric, 9223372036854775807),
                c.id
            LIMIT 1;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'no_intake_status'::text,
                    format('task.move: destination project %s has no status — pick new_status_id explicitly',
                        _new_project_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        ELSE
            _resolved_status := _new_status_id;
        END IF;

        -- 5. Validate every classification id is under the destination project.
        _validate_err := NULL;
        -- status.
        SELECT ct.name, COALESCE(c.parent_card_id, 0)
          INTO _value_card_type_name, _value_parent
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _resolved_status AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'bad_status'::text,
                format('status id %s not found', _resolved_status),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _value_card_type_name <> 'status' THEN
            RETURN QUERY SELECT _idx, false, 'bad_status'::text,
                format('status id %s is a %s, expected status', _resolved_status, _value_card_type_name),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _value_parent <> _new_project_id THEN
            RETURN QUERY SELECT _idx, false, 'bad_status'::text,
                format('status id %s does not belong to destination project', _resolved_status),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _new_milestone_id <> 0 THEN
            SELECT ct.name, COALESCE(c.parent_card_id, 0)
              INTO _value_card_type_name, _value_parent
            FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _new_milestone_id AND c.deleted_at IS NULL;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'bad_milestone'::text,
                    format('milestone id %s not found', _new_milestone_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _value_card_type_name <> 'milestone' OR _value_parent <> _new_project_id THEN
                RETURN QUERY SELECT _idx, false, 'bad_milestone'::text,
                    format('milestone id %s is a %s or does not belong to destination project',
                        _new_milestone_id, _value_card_type_name),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;
        IF _new_component_id <> 0 THEN
            SELECT ct.name, COALESCE(c.parent_card_id, 0)
              INTO _value_card_type_name, _value_parent
            FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _new_component_id AND c.deleted_at IS NULL;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'bad_component'::text,
                    format('component id %s not found', _new_component_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _value_card_type_name <> 'component' OR _value_parent <> _new_project_id THEN
                RETURN QUERY SELECT _idx, false, 'bad_component'::text,
                    format('component id %s is a %s or does not belong to destination project',
                        _new_component_id, _value_card_type_name),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;
        FOREACH _tag IN ARRAY _new_tag_ids LOOP
            SELECT ct.name, COALESCE(c.parent_card_id, 0)
              INTO _value_card_type_name, _value_parent
            FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _tag AND c.deleted_at IS NULL;
            IF NOT FOUND THEN
                _validate_err := format('tag id %s not found', _tag);
                EXIT;
            END IF;
            IF _value_card_type_name <> 'tag' OR _value_parent <> _new_project_id THEN
                _validate_err := format('tag id %s is a %s or does not belong to destination project',
                    _tag, _value_card_type_name);
                EXIT;
            END IF;
        END LOOP;
        IF _validate_err IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false, 'bad_tag'::text, _validate_err, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 6. Build moved set. The cascade walk follows the `parent_task`
        --    attribute (a card_ref self-reference, distinct from
        --    parent_card_id). UNION already dedups, but a parent_task
        --    cycle would still loop forever without a cap — carry
        --    depth < 16 to match the CLAUDE.md card-tree cap (A1).
        _moved_ids := ARRAY[_card_id];
        IF _strategy = 'cascade' THEN
            WITH RECURSIVE descendants AS (
                SELECT c.id, 0 AS depth
                FROM card c
                JOIN attribute_value av ON av.card_id = c.id
                JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'parent_task'
                WHERE c.deleted_at IS NULL
                  AND jsonb_typeof(av.value) = 'number'
                  AND (av.value)::text::bigint = _card_id
                UNION
                SELECT c.id, d.depth + 1
                FROM card c
                JOIN attribute_value av ON av.card_id = c.id
                JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'parent_task'
                JOIN descendants d
                  ON jsonb_typeof(av.value) = 'number'
                 AND (av.value)::text::bigint = d.id
                WHERE c.deleted_at IS NULL
                  AND d.depth < 16
            )
            SELECT COALESCE(array_agg(DISTINCT id ORDER BY id), ARRAY[]::bigint[])
              INTO _desc FROM descendants;
            _moved_ids := _moved_ids || _desc;
        END IF;

        -- 7. Apply.
        FOREACH _m IN ARRAY _moved_ids LOOP
            UPDATE card SET parent_card_id = _new_project_id WHERE id = _m;
            DELETE FROM attribute_value
            WHERE card_id = _m
              AND attribute_def_id = ANY(ARRAY[
                  _status_def_id, _milestone_def_id,
                  _component_def_id, _tags_def_id]);
            INSERT INTO attribute_value (card_id, attribute_def_id, value)
            VALUES (_m, _status_def_id, to_jsonb(_resolved_status));
            IF _new_milestone_id <> 0 THEN
                INSERT INTO attribute_value (card_id, attribute_def_id, value)
                VALUES (_m, _milestone_def_id, to_jsonb(_new_milestone_id));
            END IF;
            IF _new_component_id <> 0 THEN
                INSERT INTO attribute_value (card_id, attribute_def_id, value)
                VALUES (_m, _component_def_id, to_jsonb(_new_component_id));
            END IF;
            IF array_length(_new_tag_ids, 1) IS NOT NULL THEN
                INSERT INTO attribute_value (card_id, attribute_def_id, value)
                VALUES (_m, _tags_def_id, to_jsonb(_new_tag_ids));
            END IF;
            INSERT INTO activity (card_id, kind, value_new, actor_id)
            VALUES (_m, 'task_move',
                    jsonb_build_object(
                        'old_project_id', _current_project_id,
                        'new_project_id', _new_project_id,
                        'root_task_id', _card_id),
                    actor_id);
        END LOOP;

        -- 8. Break mode: clear parent_task on direct children that
        --    didn't ride along.
        _broken_ids := ARRAY[]::bigint[];
        IF _strategy = 'break' THEN
            WITH targets AS (
                SELECT av.card_id
                FROM attribute_value av
                JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'parent_task'
                JOIN card c ON c.id = av.card_id AND c.deleted_at IS NULL
                WHERE jsonb_typeof(av.value) = 'number'
                  AND (av.value)::text::bigint = _card_id
            ),
            del AS (
                DELETE FROM attribute_value
                WHERE card_id = ANY(SELECT card_id FROM targets)
                  AND attribute_def_id = ANY(ARRAY[
                      _parent_task_def_id, _parent_relationship_def_id])
                RETURNING card_id
            )
            SELECT COALESCE(array_agg(DISTINCT card_id ORDER BY card_id), ARRAY[]::bigint[])
              INTO _broken_ids FROM del;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'moved_card_ids', to_jsonb(_moved_ids),
                'broken_child_ids', to_jsonb(_broken_ids),
                'resolved_status_id', _resolved_status::text
            );
    END LOOP;
END;
$$;

-- comm.attach handler: move a thread (comm card) onto a task, or back into
-- its project as a thread on its own (docs/CONVERSATIONS.md).
--
-- A comm's card_type names task as its parent, so card.move refuses a comm
-- under a project; this handler is the one path that moves a thread between
-- the two shapes, keeping the task's `comms` card_ref[] in step.
--
-- Per-row pipeline:
--   1. Decode: comm_id required; task_id optional (0 / absent = detach).
--   2. The comm must exist and be a comm card; its project is
--      card_enclosing_project(comm).
--   3. Attach: the task must exist, be a task, sit in the same project
--      ('same_project'), not be hidden by an area that is off ('area_off' —
--      Tasks switched off), and the caller must hold card.update on task in
--      the project (the task's comms list changes; the dispatcher only
--      gated the comm itself).
--   4. Already there → ok, no writes.
--   5. Leave the old task: drop the comm from its `comms` list (attr_update
--      activity on that task).
--   6. UPDATE card.parent_card_id + a 'card_move' activity on the comm (the
--      same shape card.move writes).
--   7. Join the new task: append the comm to its `comms` list, and move the
--      thread's own attachments (inbound mail on a thread on its own lands
--      on the comm, imap.go attachmentHost) onto the task, where a task's
--      threads keep theirs. Detaching leaves attachments on the old task;
--      the messages still link them (reply_body_attachment).
--
-- Result JSON shape matches `comm.CommAttachOutput`:
--   {"comm_id": "<bigint>", "parent_id": "<bigint>", "task_id": "<bigint>"}
CREATE OR REPLACE FUNCTION comm_attach_batch(
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
    _comm_id bigint;
    _task_id bigint;
    _ct_name text;
    _old_parent bigint;
    _old_parent_type text;
    _project_id bigint;
    _task_type text;
    _task_project bigint;
    _target bigint;
    _comms_def bigint;
    _old_comms jsonb;
    _new_comms jsonb;
    _activity_id bigint;
BEGIN
    SELECT id INTO _comms_def FROM attribute_def WHERE name = 'comms';
    IF _comms_def IS NULL THEN
        RAISE EXCEPTION 'comm.attach: missing attribute_def comms';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _comm_id := NULLIF(_raw->>'comm_id', '')::bigint;
            _task_id := COALESCE(NULLIF(_raw->>'task_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm.attach: comm_id and task_id must be ids'::text, NULL::jsonb;
            CONTINUE;
        END;
        IF _comm_id IS NULL OR _comm_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm.attach: comm_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. The comm.
        SELECT ct.name, COALESCE(c.parent_card_id, 0), COALESCE(pct.name, '')
          INTO _ct_name, _old_parent, _old_parent_type
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id
        LEFT JOIN card p ON p.id = c.parent_card_id
        LEFT JOIN card_type pct ON pct.id = p.card_type_id
        WHERE c.id = _comm_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'comm_not_found'::text,
                format('comm.attach: comm %s not found', _comm_id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ct_name <> 'comm' THEN
            RETURN QUERY SELECT _idx, false, 'comm_wrong_type'::text,
                format('comm.attach: card %s is %L, not comm', _comm_id, _ct_name), NULL::jsonb;
            CONTINUE;
        END IF;
        _project_id := card_enclosing_project(_comm_id);
        IF _project_id IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm.attach: comm %s is not in a project', _comm_id), NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. The target: the task, or the project (detach).
        IF _task_id <> 0 THEN
            SELECT ct.name INTO _task_type
            FROM card t JOIN card_type ct ON ct.id = t.card_type_id
            WHERE t.id = _task_id AND t.deleted_at IS NULL;
            IF NOT FOUND OR NOT card_visible_to(comm_attach_batch.actor_id, _task_id) THEN
                RETURN QUERY SELECT _idx, false, 'task_not_found'::text,
                    format('comm.attach: task %s not found', _task_id), NULL::jsonb;
                CONTINUE;
            END IF;
            IF _task_type <> 'task' THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('comm.attach: card %s is %L, not a task', _task_id, _task_type), NULL::jsonb;
                CONTINUE;
            END IF;
            _task_project := card_enclosing_project(_task_id);
            IF _task_project IS DISTINCT FROM _project_id THEN
                RETURN QUERY SELECT _idx, false, 'same_project'::text,
                    'comm.attach: the task is in another project'::text, NULL::jsonb;
                CONTINUE;
            END IF;
            IF card_in_off_area(_task_id) THEN
                RETURN QUERY SELECT _idx, false, 'area_off'::text,
                    'comm.attach: Tasks is switched off in this project'::text, NULL::jsonb;
                CONTINUE;
            END IF;
            IF NOT user_has_grant(comm_attach_batch.actor_id, 'task', 'card.update', _project_id) THEN
                RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                    'comm.attach: you cannot change tasks in this project'::text, NULL::jsonb;
                CONTINUE;
            END IF;
            _target := _task_id;
        ELSE
            _target := _project_id;
        END IF;

        -- 4. Already there.
        IF _old_parent = _target THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('comm_id', _comm_id::text, 'parent_id', _target::text,
                                   'task_id', _task_id::text);
            CONTINUE;
        END IF;

        -- 5. Leave the old task's comms list.
        IF _old_parent_type = 'task' THEN
            SELECT av.value INTO _old_comms
            FROM attribute_value av
            WHERE av.card_id = _old_parent AND av.attribute_def_id = _comms_def;
            IF _old_comms IS NOT NULL AND jsonb_typeof(_old_comms) = 'array' THEN
                SELECT COALESCE(jsonb_agg(e.v ORDER BY e.ord), '[]'::jsonb)
                  INTO _new_comms
                FROM jsonb_array_elements(_old_comms) WITH ORDINALITY AS e(v, ord)
                WHERE (e.v #>> '{}') IS DISTINCT FROM _comm_id::text;
                IF _new_comms <> _old_comms THEN
                    INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                    VALUES (_old_parent, 'attr_update', _comms_def, _old_comms, _new_comms,
                            comm_attach_batch.actor_id)
                    RETURNING id INTO _activity_id;
                    UPDATE attribute_value
                       SET value = _new_comms, last_activity_id = _activity_id
                     WHERE card_id = _old_parent AND attribute_def_id = _comms_def;
                END IF;
            END IF;
        END IF;

        -- 6. Move + activity.
        UPDATE card SET parent_card_id = _target WHERE id = _comm_id;
        INSERT INTO activity (card_id, kind, value_old, value_new, actor_id)
        VALUES (_comm_id, 'card_move', to_jsonb(_old_parent), to_jsonb(_target),
                comm_attach_batch.actor_id);

        -- 7. Join the new task.
        IF _task_id <> 0 THEN
            SELECT av.value INTO _old_comms
            FROM attribute_value av
            WHERE av.card_id = _task_id AND av.attribute_def_id = _comms_def;
            IF _old_comms IS NULL OR jsonb_typeof(_old_comms) <> 'array' THEN
                _new_comms := jsonb_build_array(to_jsonb(_comm_id));
            ELSE
                SELECT COALESCE(jsonb_agg(
                           CASE
                             WHEN jsonb_typeof(e.v) = 'string'
                                  AND (e.v #>> '{}') ~ '^-?\d+$'
                               THEN to_jsonb(((e.v #>> '{}')::bigint))
                             ELSE e.v
                           END
                           ORDER BY e.ord), '[]'::jsonb)
                  INTO _new_comms
                FROM jsonb_array_elements(_old_comms) WITH ORDINALITY AS e(v, ord)
                WHERE (e.v #>> '{}') IS DISTINCT FROM _comm_id::text;
                _new_comms := _new_comms || jsonb_build_array(to_jsonb(_comm_id));
            END IF;
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (_task_id, 'attr_update', _comms_def, _old_comms, _new_comms,
                    comm_attach_batch.actor_id)
            RETURNING id INTO _activity_id;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (_task_id, _comms_def, _new_comms, _activity_id)
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value,
                    last_activity_id = EXCLUDED.last_activity_id;

            UPDATE attachment SET card_id = _task_id
             WHERE card_id = _comm_id AND deleted_at IS NULL;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('comm_id', _comm_id::text, 'parent_id', _target::text,
                               'task_id', _task_id::text);
    END LOOP;
END;
$$;

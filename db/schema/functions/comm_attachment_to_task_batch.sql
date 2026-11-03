-- comm.attachment_to_task handler — "Add to task": move a file that came
-- by email onto the thread's task (docs/MAIL_INTAKE_AND_CALENDARS.md,
-- "Files from email").
--
-- Files on incoming mail live on the thread (the comm card; imap.go
-- ingestInboundAttachments), never on its task. This moves one: the
-- attachment row's card becomes the task, so the file shows in the task's
-- Attachments, and the messages that carried it keep their link
-- (reply_body_attachment). Nothing is copied. When the task already holds
-- the same bytes (sha256), the messages are pointed at the task's file
-- instead and the thread's row is soft-deleted, so the task never has the
-- same file twice.
--
-- Per-row pipeline:
--   1. Decode: comm_id + attachment_id required.
--   2. The comm must exist, be visible, be a comm and sit on a task
--      ('not_on_task'); Tasks must be on ('area_off'); the caller must hold
--      card.update on task in the project ('forbidden') — the task's files
--      change. The dispatcher already gated (comm, card.update).
--   3. The attachment must be live and on this thread ('not_on_thread'); on
--      the task already → ok, no writes.
--   4. Merge into the task's copy, or move; an attachment_create activity
--      on the task ("attached invoice.pdf") either way, with from_comm_id.
--
-- Result JSON shape matches `comm.CommAttachmentToTaskOutput`:
--   {"attachment_id": "<bigint>", "task_id": "<bigint>"} — the task's file.
CREATE OR REPLACE FUNCTION comm_attachment_to_task_batch(
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
    _att_id bigint;
    _ct_name text;
    _task_id bigint;
    _task_type text;
    _project_id bigint;
    _att_card bigint;
    _file_id bigint;
    _sha text;
    _filename text;
    _same bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode.
        BEGIN
            _comm_id := NULLIF(_raw->>'comm_id', '')::bigint;
            _att_id := NULLIF(_raw->>'attachment_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _comm_id := NULL;
            _att_id := NULL;
        END;
        IF _comm_id IS NULL OR _comm_id = 0 OR _att_id IS NULL OR _att_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm.attachment_to_task: comm_id and attachment_id are required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. The thread and its task.
        SELECT ct.name, p.id, pct.name
          INTO _ct_name, _task_id, _task_type
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id
        LEFT JOIN card p ON p.id = c.parent_card_id AND p.deleted_at IS NULL
        LEFT JOIN card_type pct ON pct.id = p.card_type_id
        WHERE c.id = _comm_id AND c.deleted_at IS NULL;
        IF NOT FOUND OR NOT card_visible_to(comm_attachment_to_task_batch.actor_id, _comm_id) THEN
            RETURN QUERY SELECT _idx, false, 'comm_not_found'::text,
                format('comm.attachment_to_task: comm %s not found', _comm_id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ct_name <> 'comm' THEN
            RETURN QUERY SELECT _idx, false, 'comm_wrong_type'::text,
                format('comm.attachment_to_task: card %s is %L, not comm', _comm_id, _ct_name), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _task_type IS DISTINCT FROM 'task' THEN
            RETURN QUERY SELECT _idx, false, 'not_on_task'::text,
                'comm.attachment_to_task: the thread is not on a task'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF card_in_off_area(_task_id) THEN
            RETURN QUERY SELECT _idx, false, 'area_off'::text,
                'comm.attachment_to_task: Tasks is switched off in this project'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _project_id := card_enclosing_project(_comm_id);
        IF NOT user_has_grant(comm_attachment_to_task_batch.actor_id, 'task', 'card.update', _project_id) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'comm.attachment_to_task: you cannot change tasks in this project'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. The file, locked while it moves.
        SELECT a.card_id, a.file_id, f.sha256, f.filename
          INTO _att_card, _file_id, _sha, _filename
        FROM attachment a
        JOIN file f ON f.id = a.file_id
        WHERE a.id = _att_id AND a.deleted_at IS NULL
        FOR UPDATE OF a;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'attachment_not_found'::text,
                format('comm.attachment_to_task: attachment %s not found', _att_id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _att_card = _task_id THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('attachment_id', _att_id::text, 'task_id', _task_id::text);
            CONTINUE;
        END IF;
        IF _att_card <> _comm_id THEN
            RETURN QUERY SELECT _idx, false, 'not_on_thread'::text,
                format('comm.attachment_to_task: attachment %s is not on thread %s', _att_id, _comm_id), NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. The task may hold these bytes already.
        _same := NULL;
        IF _sha IS NOT NULL AND _sha <> '' THEN
            SELECT a.id INTO _same
            FROM attachment a
            JOIN file f ON f.id = a.file_id
            WHERE a.card_id = _task_id AND a.deleted_at IS NULL AND f.sha256 = _sha
            ORDER BY a.id
            LIMIT 1;
        END IF;

        IF _same IS NOT NULL THEN
            INSERT INTO reply_body_attachment (reply_body_id, attachment_id)
            SELECT rba.reply_body_id, _same
            FROM reply_body_attachment rba
            WHERE rba.attachment_id = _att_id
            ON CONFLICT DO NOTHING;
            DELETE FROM reply_body_attachment WHERE attachment_id = _att_id;
            UPDATE attachment SET deleted_at = now() WHERE id = _att_id;
            INSERT INTO activity (card_id, kind, value_old, actor_id)
            VALUES (_comm_id, 'attachment_delete',
                    jsonb_build_object('attachment_id', _att_id, 'file_id', _file_id,
                                       'filename', _filename, 'merged_into', _same),
                    comm_attachment_to_task_batch.actor_id);
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('attachment_id', _same::text, 'task_id', _task_id::text);
            CONTINUE;
        END IF;

        UPDATE attachment SET card_id = _task_id WHERE id = _att_id;
        INSERT INTO activity (card_id, kind, value_new, actor_id)
        VALUES (_task_id, 'attachment_create',
                jsonb_build_object('attachment_id', _att_id, 'file_id', _file_id,
                                   'filename', _filename, 'from_comm_id', _comm_id),
                comm_attachment_to_task_batch.actor_id);
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('attachment_id', _att_id::text, 'task_id', _task_id::text);
    END LOOP;
END;
$$;

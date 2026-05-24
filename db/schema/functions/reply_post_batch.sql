-- reply.post handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runReplyPost into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Decode + cheap presence checks (comm_id + body required).
--   2. Resolve the target comm: must exist, be a comm card, and
--      surface its channel_ref (for reply_from), parent_card_id (for
--      task title -> subject), and thread_id (subject prefix).
--   3. Recipients: join comm.comm_recipients -> person.email and
--      assemble the comma-joined To: snapshot. Empty list rejects
--      ('no_recipients') so the SMTP sender never queues a hopeless
--      row.
--   4. Channel: optional from_address attribute on the referenced
--      channel becomes the reply_from snapshot.
--   5. Insert reply_body card (global; no parent) + card_create
--      activity.
--   6. Write the five reply_body attributes (reply_to / reply_from /
--      reply_subject / reply_body_text / delivery_status='pending').
--      Uses an ordinality-join pattern: a single jsonb_array_elements
--      iteration emits one activity row per attribute and zips the
--      returned activity ids back through unnest WITH ORDINALITY for
--      the paired attribute_value upserts. This collapses the 10
--      round-trips the Go path used (5 attrs * 2 statements each) into
--      2 set-based statements.
--   7. Append the new reply_body id to comm.replies — read current
--      list, decode (tolerating string + numeric forms), append, and
--      write back with one activity + upsert.
--   8. Optional attachment linking: validate every supplied
--      attachment_id belongs to the comm's parent task, then bulk
--      insert into reply_body_attachment.
--
-- Result JSON shape matches `comm.ReplyPostOutput`:
--   {"reply_id": "<bigint>"}
-- The bigint id is cast to text per the wire convention.
CREATE OR REPLACE FUNCTION reply_post_batch(
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
    _body text;
    _attachment_ids jsonb;
    _att_ids bigint[];
    _ct_name text;
    _channel_ref bigint;
    _parent_task_id bigint;
    _thread_id text;
    _recipients text[];
    _to_snapshot text;
    _task_title text;
    _subject_snapshot text;
    _from_address text;
    _reply_ct_id bigint;
    _reply_id bigint;
    _activity_id bigint;
    _reply_to_def bigint;
    _reply_from_def bigint;
    _reply_subject_def bigint;
    _reply_body_text_def bigint;
    _delivery_status_def bigint;
    _replies_def bigint;
    _old_replies jsonb;
    _new_replies jsonb;
    _replies_activity bigint;
    _att_valid_count int;
    _bad_msg text;
BEGIN
    -- Hoist constants used every row.
    SELECT id INTO _reply_ct_id FROM card_type WHERE name = 'reply_body';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'reply.post: card_type reply_body missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _reply_to_def         FROM attribute_def WHERE name = 'reply_to';
    SELECT id INTO _reply_from_def       FROM attribute_def WHERE name = 'reply_from';
    SELECT id INTO _reply_subject_def    FROM attribute_def WHERE name = 'reply_subject';
    SELECT id INTO _reply_body_text_def  FROM attribute_def WHERE name = 'reply_body_text';
    SELECT id INTO _delivery_status_def  FROM attribute_def WHERE name = 'delivery_status';
    SELECT id INTO _replies_def          FROM attribute_def WHERE name = 'replies';
    IF _reply_to_def IS NULL OR _reply_from_def IS NULL OR _reply_subject_def IS NULL
       OR _reply_body_text_def IS NULL OR _delivery_status_def IS NULL
       OR _replies_def IS NULL THEN
        RAISE EXCEPTION 'reply.post: one of reply_body / replies attribute_defs missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode + presence.
        BEGIN
            _comm_id := NULLIF(_raw->>'comm_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _comm_id := NULL;
        END;
        _body := _raw->>'body';
        _attachment_ids := _raw->'attachment_ids';

        IF _comm_id IS NULL OR _comm_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'reply.post: comm_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _body IS NULL OR _body = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'reply.post: body is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Comm lookup. channel_ref + thread_id come from
        --    attribute_value; parent_card_id is on card itself.
        SELECT ct.name,
               COALESCE((SELECT (av.value)::text::bigint
                         FROM attribute_value av
                         JOIN attribute_def ad ON ad.id = av.attribute_def_id
                         WHERE av.card_id = c.id AND ad.name = 'channel_ref'
                           AND jsonb_typeof(av.value) = 'number'), 0),
               COALESCE(c.parent_card_id, 0),
               COALESCE((SELECT av.value #>> '{}'
                         FROM attribute_value av
                         JOIN attribute_def ad ON ad.id = av.attribute_def_id
                         WHERE av.card_id = c.id AND ad.name = 'thread_id'), '')
          INTO _ct_name, _channel_ref, _parent_task_id, _thread_id
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _comm_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'comm_not_found'::text,
                format('reply.post: comm %s not found', _comm_id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ct_name <> 'comm' THEN
            RETURN QUERY SELECT _idx, false, 'comm_wrong_type'::text,
                format('reply.post: card %s is %L, not comm', _comm_id, _ct_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Recipient emails from comm_recipients -> person.email.
        --    Preserve recipient-list order (matches the Go loop) by
        --    joining via WITH ORDINALITY on the stored array elements.
        --    Skip persons missing an email so we degrade gracefully
        --    (same best-effort semantics as loadCommRecipientEmails).
        WITH rec AS (
            SELECT (e.v)::text::bigint AS person_id, e.ord
            FROM attribute_value av
            JOIN attribute_def ad ON ad.id = av.attribute_def_id,
                 LATERAL jsonb_array_elements(av.value) WITH ORDINALITY AS e(v, ord)
            WHERE av.card_id = _comm_id
              AND ad.name = 'comm_recipients'
              AND jsonb_typeof(av.value) = 'array'
              AND jsonb_typeof(e.v) = 'number'
        )
        SELECT array_agg(em.email ORDER BY rec.ord)
          INTO _recipients
        FROM rec
        JOIN attribute_value pav ON pav.card_id = rec.person_id
        JOIN attribute_def pad  ON pad.id = pav.attribute_def_id AND pad.name = 'email',
             LATERAL (SELECT pav.value #>> '{}' AS email) em
        WHERE em.email IS NOT NULL AND em.email <> '';

        IF _recipients IS NULL OR array_length(_recipients, 1) IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'no_recipients'::text,
                format('reply.post: comm %s has no recipients; set them via comm.set_recipients before replying',
                       _comm_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        _to_snapshot := array_to_string(_recipients, ', ');

        -- Subject snapshot = "{thread_id} {task.title}" (or just
        -- thread_id when the task has no title — defensive, the task
        -- card_type has title as a required edge).
        _task_title := '';
        IF _parent_task_id <> 0 THEN
            SELECT COALESCE(av.value #>> '{}', '')
              INTO _task_title
            FROM attribute_value av
            JOIN attribute_def ad ON ad.id = av.attribute_def_id
            WHERE av.card_id = _parent_task_id AND ad.name = 'title';
            IF _task_title IS NULL THEN
                _task_title := '';
            END IF;
        END IF;
        IF _task_title = '' THEN
            _subject_snapshot := _thread_id;
        ELSE
            _subject_snapshot := _thread_id || ' ' || _task_title;
        END IF;

        -- 4. Channel from_address (best-effort).
        _from_address := '';
        IF _channel_ref <> 0 THEN
            SELECT COALESCE(av.value #>> '{}', '')
              INTO _from_address
            FROM attribute_value av
            JOIN attribute_def ad ON ad.id = av.attribute_def_id
            WHERE av.card_id = _channel_ref AND ad.name = 'from_address';
            IF _from_address IS NULL THEN
                _from_address := '';
            END IF;
        END IF;

        -- 5. Insert reply_body card + card_create activity.
        INSERT INTO card (card_type_id) VALUES (_reply_ct_id)
        RETURNING id INTO _reply_id;
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_reply_id, 'card_create', reply_post_batch.actor_id);

        -- 6. Set-based write of the five reply_body attributes. The
        --    ordinality-join pattern from attribute_update_batch lets us
        --    emit all five activity rows in one statement and zip the
        --    returned ids back to the corresponding attribute_value
        --    upserts in a single ON CONFLICT block.
        WITH writes(ord, attr_def_id, value) AS (
            VALUES
                (1, _reply_to_def,         to_jsonb(_to_snapshot)),
                (2, _reply_from_def,       to_jsonb(_from_address)),
                (3, _reply_subject_def,    to_jsonb(_subject_snapshot)),
                (4, _reply_body_text_def,  to_jsonb(_body)),
                (5, _delivery_status_def,  to_jsonb('pending'::text))
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _reply_id, 'attr_update', w.attr_def_id, NULL, w.value,
                   reply_post_batch.actor_id
            FROM writes w
            ORDER BY w.ord
            RETURNING id, attribute_def_id, value_new
        )
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        SELECT _reply_id, ia.attribute_def_id, ia.value_new, ia.id
        FROM ins_activity ia
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- 7. Append _reply_id to comm.replies. Tolerate both string and
        --    numeric stored forms (legacy seeds), then canonicalise to
        --    numbers on write.
        SELECT av.value INTO _old_replies
        FROM attribute_value av
        JOIN attribute_def ad ON ad.id = av.attribute_def_id
        WHERE av.card_id = _comm_id AND ad.name = 'replies';

        IF _old_replies IS NULL OR jsonb_typeof(_old_replies) <> 'array' THEN
            _new_replies := jsonb_build_array(to_jsonb(_reply_id));
        ELSE
            SELECT jsonb_agg(
                       CASE
                         WHEN jsonb_typeof(e.v) = 'string'
                              AND (e.v #>> '{}') ~ '^-?\d+$'
                           THEN to_jsonb(((e.v #>> '{}')::bigint))
                         ELSE e.v
                       END
                       ORDER BY e.ord)
              INTO _new_replies
            FROM jsonb_array_elements(_old_replies) WITH ORDINALITY AS e(v, ord);
            _new_replies := COALESCE(_new_replies, '[]'::jsonb)
                         || jsonb_build_array(to_jsonb(_reply_id));
        END IF;

        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_comm_id, 'attr_update', _replies_def, NULL, _new_replies,
                reply_post_batch.actor_id)
        RETURNING id INTO _replies_activity;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_comm_id, _replies_def, _new_replies, _replies_activity)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- 8. Optional attachment linking.
        _att_ids := ARRAY[]::bigint[];
        IF _attachment_ids IS NOT NULL AND jsonb_typeof(_attachment_ids) = 'array'
           AND jsonb_array_length(_attachment_ids) > 0 THEN
            _bad_msg := NULL;
            DECLARE
                _el jsonb;
            BEGIN
                FOR _el IN SELECT e.v
                           FROM jsonb_array_elements(_attachment_ids) WITH ORDINALITY AS e(v, ord)
                           ORDER BY ord
                LOOP
                    IF jsonb_typeof(_el) = 'number' THEN
                        _att_ids := array_append(_att_ids, (_el)::text::bigint);
                    ELSIF jsonb_typeof(_el) = 'string'
                          AND (_el #>> '{}') ~ '^-?\d+$' THEN
                        _att_ids := array_append(_att_ids, ((_el #>> '{}')::bigint));
                    ELSE
                        _bad_msg := format(
                            'reply.post: attachment_id not a number or numeric string: %s',
                            _el::text);
                        EXIT;
                    END IF;
                END LOOP;
            END;
            IF _bad_msg IS NOT NULL THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text, _bad_msg, NULL::jsonb;
                CONTINUE;
            END IF;

            IF _parent_task_id = 0 THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'reply.post: comm has no parent task; cannot attach'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;

            SELECT count(*) INTO _att_valid_count
            FROM attachment a
            WHERE a.id = ANY(_att_ids)
              AND a.card_id = _parent_task_id
              AND a.deleted_at IS NULL;
            IF _att_valid_count <> array_length(_att_ids, 1) THEN
                RETURN QUERY SELECT _idx, false, 'attachment_not_on_task'::text,
                    'reply.post: one or more attachment_ids do not belong to this comm''s parent task'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;

            INSERT INTO reply_body_attachment (reply_body_id, attachment_id)
            SELECT _reply_id, x FROM unnest(_att_ids) AS x
            ON CONFLICT DO NOTHING;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'reply_id', _reply_id::text
            );
    END LOOP;
END;
$$;

-- comm.create handler (Phase 4 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runCommCreate + helpers (loadTaskAndChannel,
-- commFlowDefaultStatus, uniqueThreadID, appendCardRefList,
-- insertReceivedReply, writeCommRecipients) into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Decode + cheap presence (task_id, channel_id).
--   2. Task: exists + card_type='task' + capture title (for default
--      subject).
--   3. Channel: exists + card_type='comm_channel'.
--   4. Enclosing project resolution (shared capped card_enclosing_project
--      helper) for task + channel; must be non-zero and equal.
--   5. Resolve comm_status default from the project's comm flow.
--   6. Mint a unique 10-char alphanumeric thread_id via gen_random_bytes
--      (retry on the astronomically rare collision). The Go path used
--      crypto/rand + a base62 alphabet; the PL/pgSQL substitute uses
--      a base64-url encode of 8 random bytes truncated to 10 chars and
--      then mapped to base62 by stripping '-' / '_'. The legacy regex
--      `^[0-9A-Za-z]{10}$` is satisfied — the IMAP parser's matcher
--      only checks the alphanumeric character class.
--   7. INSERT comm card under the task + card_create activity.
--   8. Set-based multi-attribute write (title, channel_ref, thread_id,
--      comm_status) via the ordinality-join idiom.
--   9. Optional recipients: validate every supplied person_id is a
--      person card, dedup (first-seen order), write comm_recipients
--      attribute_value as a canonical numeric jsonb array.
--   10. Append the new comm_id to the parent task's `comms` card_ref[]
--       attribute (tolerating string + numeric stored forms in legacy
--       data, then canonicalising to numbers on write).
--   11. Optional initial_message: INSERT a reply_body card with
--       delivery_status='received' + the five reply_body attributes,
--       then append its id to comm.replies.
--
-- Result JSON shape matches `comm.CommCreateOutput`:
--   {"comm_id": "<bigint>", "thread_id": "<10-char alphanumeric>"}
CREATE OR REPLACE FUNCTION comm_create_batch(
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
    _task_id bigint;
    _channel_id bigint;
    _subject text;
    _initial_message text;
    _recipients_raw jsonb;
    _task_kind text;
    _task_title text;
    _channel_kind text;
    _task_project bigint;
    _channel_project bigint;
    _default_status_id bigint;
    _candidate text;
    _attempts int;
    _thread_id text;
    _alpha_re constant text := '^[0-9A-Za-z]{10}$';
    _comm_ct_id bigint;
    _reply_ct_id bigint;
    _comm_id bigint;
    _reply_id bigint;
    _title_def bigint;
    _channel_ref_def bigint;
    _thread_id_def bigint;
    _comm_status_def bigint;
    _comm_recipients_def bigint;
    _comms_def bigint;
    _replies_def bigint;
    _reply_to_def bigint;
    _reply_from_def bigint;
    _reply_subject_def bigint;
    _reply_body_text_def bigint;
    _delivery_status_def bigint;
    _ids bigint[];
    _bad_msg text;
    _bad_id bigint;
    _bad_name text;
    _missing_id bigint;
    _recipients_norm jsonb;
    _old_comms jsonb;
    _new_comms jsonb;
    _activity_id bigint;
BEGIN
    -- Hoist constants.
    SELECT id INTO _comm_ct_id  FROM card_type WHERE name = 'comm';
    SELECT id INTO _reply_ct_id FROM card_type WHERE name = 'reply_body';
    IF _comm_ct_id IS NULL OR _reply_ct_id IS NULL THEN
        RAISE EXCEPTION 'comm.create: card_type comm or reply_body missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _title_def           FROM attribute_def WHERE name = 'title';
    SELECT id INTO _channel_ref_def     FROM attribute_def WHERE name = 'channel_ref';
    SELECT id INTO _thread_id_def       FROM attribute_def WHERE name = 'thread_id';
    SELECT id INTO _comm_status_def     FROM attribute_def WHERE name = 'comm_status';
    SELECT id INTO _comm_recipients_def FROM attribute_def WHERE name = 'comm_recipients';
    SELECT id INTO _comms_def           FROM attribute_def WHERE name = 'comms';
    SELECT id INTO _replies_def         FROM attribute_def WHERE name = 'replies';
    SELECT id INTO _reply_to_def        FROM attribute_def WHERE name = 'reply_to';
    SELECT id INTO _reply_from_def      FROM attribute_def WHERE name = 'reply_from';
    SELECT id INTO _reply_subject_def   FROM attribute_def WHERE name = 'reply_subject';
    SELECT id INTO _reply_body_text_def FROM attribute_def WHERE name = 'reply_body_text';
    SELECT id INTO _delivery_status_def FROM attribute_def WHERE name = 'delivery_status';
    IF _title_def IS NULL OR _channel_ref_def IS NULL OR _thread_id_def IS NULL
       OR _comm_status_def IS NULL OR _comm_recipients_def IS NULL
       OR _comms_def IS NULL OR _replies_def IS NULL
       OR _reply_to_def IS NULL OR _reply_from_def IS NULL OR _reply_subject_def IS NULL
       OR _reply_body_text_def IS NULL OR _delivery_status_def IS NULL THEN
        RAISE EXCEPTION 'comm.create: required attribute_defs missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode + presence.
        BEGIN
            _task_id := NULLIF(_raw->>'task_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _task_id := NULL;
        END;
        BEGIN
            _channel_id := NULLIF(_raw->>'channel_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _channel_id := NULL;
        END;
        _subject         := COALESCE(_raw->>'subject', '');
        _initial_message := COALESCE(_raw->>'initial_message', '');
        _recipients_raw  := _raw->'recipient_person_ids';

        IF _task_id IS NULL OR _task_id = 0
           OR _channel_id IS NULL OR _channel_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm.create: task_id and channel_id are required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Task lookup.
        SELECT ct.name,
               COALESCE((SELECT av.value #>> '{}'
                         FROM attribute_value av
                         JOIN attribute_def ad ON ad.id = av.attribute_def_id
                         WHERE av.card_id = c.id AND ad.name = 'title'), '')
          INTO _task_kind, _task_title
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _task_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'task_not_found'::text,
                format('comm.create: task %s not found', _task_id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _task_kind <> 'task' THEN
            RETURN QUERY SELECT _idx, false, 'task_wrong_type'::text,
                format('comm.create: card %s is %L, not task', _task_id, _task_kind),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Channel lookup.
        SELECT ct.name INTO _channel_kind
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _channel_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'channel_not_found'::text,
                format('comm.create: channel %s not found', _channel_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _channel_kind <> 'comm_channel' THEN
            RETURN QUERY SELECT _idx, false, 'channel_wrong_type'::text,
                format('comm.create: card %s is %L, not comm_channel', _channel_id, _channel_kind),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Enclosing project resolution for task + channel via the
        --    shared capped card_enclosing_project helper (A1/A10).
        _task_project := COALESCE(card_enclosing_project(_task_id), 0);

        IF _task_project = 0 THEN
            RETURN QUERY SELECT _idx, false, 'task_no_project'::text,
                format('comm.create: task %s has no enclosing project', _task_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        _channel_project := COALESCE(card_enclosing_project(_channel_id), 0);

        IF _task_project <> _channel_project THEN
            RETURN QUERY SELECT _idx, false, 'project_mismatch'::text,
                format('comm.create: task %s (project %s) and channel %s (project %s) are not in the same project',
                       _task_id, _task_project, _channel_id, _channel_project),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 5. comm_status default from the project's comm flow.
        SELECT COALESCE(default_create_status_id, 0)
          INTO _default_status_id
        FROM flow
        WHERE scope_card_id = _task_project AND attribute_def_id = _comm_status_def
        LIMIT 1;
        IF NOT FOUND OR _default_status_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'no_comm_flow'::text,
                format('comm.create: project %s has no comm flow / default_create_status_id; seed a comm flow first',
                       _task_project),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 6. Mint a unique 10-char alphanumeric thread_id.
        --    encode(gen_random_bytes(N), 'base64') uses [A-Za-z0-9+/=].
        --    Stripping `+/=` leaves the same character class the legacy
        --    base62 emitted. We grab a generous 24 bytes (~32 base64
        --    chars), translate, take the first 10. Loop until the
        --    candidate matches the alpha regex (rejecting any rare
        --    truncated form that lost too many chars to the strip) and
        --    is not already in use under any comm thread_id attribute.
        _thread_id := NULL;
        FOR _attempts IN 1..10 LOOP
            _candidate := substring(
                translate(encode(gen_random_bytes(24), 'base64'), '+/=', '') from 1 for 10);
            IF length(_candidate) <> 10 OR _candidate !~ _alpha_re THEN
                CONTINUE;
            END IF;
            PERFORM 1 FROM attribute_value av
                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                WHERE ad.id = _thread_id_def AND av.value = to_jsonb(_candidate);
            IF NOT FOUND THEN
                _thread_id := _candidate;
                EXIT;
            END IF;
        END LOOP;
        IF _thread_id IS NULL THEN
            RAISE EXCEPTION 'comm.create: failed to mint unique thread_id after 10 attempts'
                USING ERRCODE = 'P0001';
        END IF;

        -- Default subject = task title when caller omits one.
        IF _subject = '' THEN
            _subject := _task_title;
        END IF;

        -- 7. Insert comm card under the task + card_create activity.
        INSERT INTO card (card_type_id, parent_card_id) VALUES (_comm_ct_id, _task_id)
        RETURNING id INTO _comm_id;
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_comm_id, 'card_create', comm_create_batch.actor_id);

        -- 8. Set-based write of the four initial attributes via the
        --    ordinality-join idiom.
        WITH writes(ord, attr_def_id, value) AS (
            VALUES
                (1, _title_def,        to_jsonb(_subject)),
                (2, _channel_ref_def,  to_jsonb(_channel_id)),
                (3, _thread_id_def,    to_jsonb(_thread_id)),
                (4, _comm_status_def,  to_jsonb(_default_status_id))
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _comm_id, 'attr_update', w.attr_def_id, NULL, w.value,
                   comm_create_batch.actor_id
            FROM writes w
            ORDER BY w.ord
            RETURNING id, attribute_def_id, value_new
        )
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        SELECT _comm_id, ia.attribute_def_id, ia.value_new, ia.id
        FROM ins_activity ia
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- 9. Optional recipients. Decode + dedup (preserve first-seen
        --    order via ORDINALITY), then bulk-validate every id is a
        --    person card; one malformed / bad id fails the row with
        --    code='invalid_recipient' (matches the legacy contract).
        IF _recipients_raw IS NOT NULL
           AND jsonb_typeof(_recipients_raw) = 'array'
           AND jsonb_array_length(_recipients_raw) > 0 THEN
            _bad_msg := NULL;
            DECLARE
                _el jsonb;
                _id bigint;
            BEGIN
                _ids := ARRAY[]::bigint[];
                FOR _el IN SELECT e.v
                           FROM jsonb_array_elements(_recipients_raw) WITH ORDINALITY AS e(v, ord)
                           ORDER BY ord
                LOOP
                    IF jsonb_typeof(_el) = 'number' THEN
                        _id := (_el)::text::bigint;
                    ELSIF jsonb_typeof(_el) = 'string'
                          AND (_el #>> '{}') ~ '^-?\d+$' THEN
                        _id := ((_el #>> '{}')::bigint);
                    ELSE
                        _bad_msg := format(
                            'comm.create: recipient id not a number or numeric string: %s',
                            _el::text);
                        EXIT;
                    END IF;
                    IF NOT (_id = ANY(_ids)) THEN
                        _ids := array_append(_ids, _id);
                    END IF;
                END LOOP;
            END;
            IF _bad_msg IS NOT NULL THEN
                RETURN QUERY SELECT _idx, false, 'invalid_recipient'::text, _bad_msg, NULL::jsonb;
                CONTINUE;
            END IF;

            -- Bulk validate against person cards.
            _missing_id := NULL;
            _bad_id := NULL;
            _bad_name := NULL;
            SELECT m.want, c.id, ct.name
              INTO _missing_id, _bad_id, _bad_name
            FROM unnest(_ids) AS m(want)
            LEFT JOIN card c ON c.id = m.want AND c.deleted_at IS NULL
            LEFT JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id IS NULL OR ct.name <> 'person'
            ORDER BY m.want
            LIMIT 1;
            IF FOUND THEN
                IF _bad_id IS NULL THEN
                    RETURN QUERY SELECT _idx, false, 'invalid_recipient'::text,
                        format('comm.create: person %s not found', _missing_id),
                        NULL::jsonb;
                ELSE
                    RETURN QUERY SELECT _idx, false, 'invalid_recipient'::text,
                        format('comm.create: card %s is %L, not person', _bad_id, _bad_name),
                        NULL::jsonb;
                END IF;
                CONTINUE;
            END IF;

            -- Canonical numeric jsonb array, write activity + upsert.
            SELECT jsonb_agg(to_jsonb(v) ORDER BY ord)
              INTO _recipients_norm
            FROM unnest(_ids) WITH ORDINALITY AS t(v, ord);

            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (_comm_id, 'attr_update', _comm_recipients_def, NULL, _recipients_norm,
                    comm_create_batch.actor_id)
            RETURNING id INTO _activity_id;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (_comm_id, _comm_recipients_def, _recipients_norm, _activity_id)
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value,
                    last_activity_id = EXCLUDED.last_activity_id;
        END IF;

        -- 10. Append _comm_id to task.comms. Tolerate legacy
        --     string-form ids in the stored array and canonicalise to
        --     numbers on write (same pattern reply_post_batch uses).
        SELECT av.value INTO _old_comms
        FROM attribute_value av
        JOIN attribute_def ad ON ad.id = av.attribute_def_id
        WHERE av.card_id = _task_id AND ad.name = 'comms';
        IF _old_comms IS NULL OR jsonb_typeof(_old_comms) <> 'array' THEN
            _new_comms := jsonb_build_array(to_jsonb(_comm_id));
        ELSE
            SELECT jsonb_agg(
                       CASE
                         WHEN jsonb_typeof(e.v) = 'string'
                              AND (e.v #>> '{}') ~ '^-?\d+$'
                           THEN to_jsonb(((e.v #>> '{}')::bigint))
                         ELSE e.v
                       END
                       ORDER BY e.ord)
              INTO _new_comms
            FROM jsonb_array_elements(_old_comms) WITH ORDINALITY AS e(v, ord);
            _new_comms := COALESCE(_new_comms, '[]'::jsonb)
                       || jsonb_build_array(to_jsonb(_comm_id));
        END IF;
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_task_id, 'attr_update', _comms_def, NULL, _new_comms,
                comm_create_batch.actor_id)
        RETURNING id INTO _activity_id;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_task_id, _comms_def, _new_comms, _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- 11. Optional initial inbound message → reply_body card with
        --     delivery_status='received'. Five attribute writes via the
        --     ordinality-join idiom, then append the id to comm.replies.
        IF _initial_message <> '' THEN
            INSERT INTO card (card_type_id) VALUES (_reply_ct_id)
            RETURNING id INTO _reply_id;
            INSERT INTO activity (card_id, kind, actor_id)
            VALUES (_reply_id, 'card_create', comm_create_batch.actor_id);

            WITH writes(ord, attr_def_id, value) AS (
                VALUES
                    (1, _reply_to_def,        to_jsonb(''::text)),
                    (2, _reply_from_def,      to_jsonb(''::text)),
                    (3, _reply_subject_def,   to_jsonb(_subject)),
                    (4, _reply_body_text_def, to_jsonb(_initial_message)),
                    (5, _delivery_status_def, to_jsonb('received'::text))
            ),
            ins_activity AS (
                INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                SELECT _reply_id, 'attr_update', w.attr_def_id, NULL, w.value,
                       comm_create_batch.actor_id
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

            -- Append _reply_id to comm.replies (fresh comm, no prior list).
            _new_comms := jsonb_build_array(to_jsonb(_reply_id));
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (_comm_id, 'attr_update', _replies_def, NULL, _new_comms,
                    comm_create_batch.actor_id)
            RETURNING id INTO _activity_id;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (_comm_id, _replies_def, _new_comms, _activity_id)
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value,
                    last_activity_id = EXCLUDED.last_activity_id;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'comm_id', _comm_id::text,
                'thread_id', _thread_id
            );
    END LOOP;
END;
$$;

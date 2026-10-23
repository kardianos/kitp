-- approval.set handler — ask people to approve (or reject) one of a task's
-- status actions, or change who is asked.
--
-- An approval REQUEST is documentation, never a gate: nothing here or in
-- attribute.update blocks or advances a status change. It is an `approval`
-- card parented under the task, carrying:
--   title           — "<action>: <from> → <to>" (what the request reads as)
--   approval_from   — the status the action starts from (card_ref)
--   approval_to     — the status it leads to (card_ref)
--   approval_action — the action's label when asked ("Approve")
--   approvers       — the people asked (card_ref[] → person)
--   approval_note   — an optional message to them
-- The decisions themselves are approval_decision activity rows on the task
-- (approval.decide), so removing a request never erases one.
--
-- Create (no id): task_id, from_status_id, to_status_id and approver_ids
-- are required; from → to must be a step of the task's status flow
-- (task_status_action), whose label is snapshotted. Update (id): PATCHes
-- approver_ids and / or note; the action is fixed (remove and request again
-- to change it). Each person asked must be a live person with a login who
-- can see the task's project — someone who could never sign in to decide
-- would leave the request hanging. Only attributes that change write
-- activity rows (with value_old), which is the request's audit trail.
--
-- Authz: the dispatcher gates on card.update of the task (like link.set),
-- so anyone who can edit the task can ask for approval.
--
-- Result JSON shape matches `approval.SetOutput`:
--   {"approval_id": "<bigint>", "created": bool, "changed": bool}
CREATE OR REPLACE FUNCTION approval_set_batch(
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
    _approval_ct bigint;
    _title_def bigint;
    _from_def bigint;
    _to_def bigint;
    _action_def bigint;
    _approvers_def bigint;
    _note_def bigint;
    _idx int;
    _raw jsonb;
    _id bigint;
    _task_id bigint;
    _project_id bigint;
    _from_id bigint;
    _to_id bigint;
    _label text;
    _approvers bigint[];
    _approvers_present boolean;
    _bad text;
    _note text;
    _note_present boolean;
    _created boolean;
    _writes int;
BEGIN
    SELECT id INTO _approval_ct FROM card_type WHERE name = 'approval';
    SELECT id INTO _title_def     FROM attribute_def WHERE name = 'title';
    SELECT id INTO _from_def      FROM attribute_def WHERE name = 'approval_from';
    SELECT id INTO _to_def        FROM attribute_def WHERE name = 'approval_to';
    SELECT id INTO _action_def    FROM attribute_def WHERE name = 'approval_action';
    SELECT id INTO _approvers_def FROM attribute_def WHERE name = 'approvers';
    SELECT id INTO _note_def      FROM attribute_def WHERE name = 'approval_note';
    IF _approval_ct IS NULL OR _title_def IS NULL OR _from_def IS NULL OR _to_def IS NULL
       OR _action_def IS NULL OR _approvers_def IS NULL OR _note_def IS NULL THEN
        RAISE EXCEPTION 'approval.set: the approval card_type or one of its attribute_defs is missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode + shape validation.
        BEGIN
            _id      := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
            _task_id := COALESCE(NULLIF(_raw->>'task_id', '')::bigint, 0);
            _from_id := COALESCE(NULLIF(_raw->>'from_status_id', '')::bigint, 0);
            _to_id   := COALESCE(NULLIF(_raw->>'to_status_id', '')::bigint, 0);
            -- Deduplicated and sorted, so re-sending the same people in
            -- another order is no change.
            _approvers := ARRAY(
                SELECT DISTINCT e::bigint
                FROM jsonb_array_elements_text(
                    CASE jsonb_typeof(_raw->'approver_ids') WHEN 'array' THEN _raw->'approver_ids' ELSE '[]'::jsonb END
                ) AS e
                ORDER BY 1
            );
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.set: ids must be card ids'::text, NULL::jsonb;
            CONTINUE;
        END;
        _approvers_present := COALESCE(jsonb_typeof(_raw->'approver_ids') = 'array', false);
        _note_present := (_raw ? 'note') AND jsonb_typeof(_raw->'note') <> 'null';
        _note := btrim(COALESCE(_raw->>'note', ''));
        IF _task_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.set: task_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF length(_note) > 2000 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.set: note must be at most 2000 characters'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _approvers_present AND cardinality(_approvers) = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.set: ask at least one person'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF cardinality(_approvers) > 20 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.set: ask at most 20 people'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. The task must be a live task; an update's request must hang off it.
        IF NOT EXISTS (
            SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _task_id AND c.deleted_at IS NULL AND ct.name = 'task'
        ) THEN
            RETURN QUERY SELECT _idx, false, 'task_not_found'::text,
                format('approval.set: task %s not found', _task_id), NULL::jsonb;
            CONTINUE;
        END IF;
        _project_id := card_enclosing_project(_task_id);

        IF _id <> 0 THEN
            IF NOT EXISTS (
                SELECT 1 FROM card c
                WHERE c.id = _id AND c.card_type_id = _approval_ct
                  AND c.parent_card_id = _task_id AND c.deleted_at IS NULL
            ) THEN
                RETURN QUERY SELECT _idx, false, 'approval_not_found'::text,
                    format('approval.set: approval %s not found on task %s', _id, _task_id), NULL::jsonb;
                CONTINUE;
            END IF;
            IF (_from_id <> 0 AND _from_id IS DISTINCT FROM (
                    SELECT (av.value)::text::bigint FROM attribute_value av
                    WHERE av.card_id = _id AND av.attribute_def_id = _from_def))
               OR (_to_id <> 0 AND _to_id IS DISTINCT FROM (
                    SELECT (av.value)::text::bigint FROM attribute_value av
                    WHERE av.card_id = _id AND av.attribute_def_id = _to_def)) THEN
                RETURN QUERY SELECT _idx, false, 'approval_action_fixed'::text,
                    'approval.set: a request''s action can''t change; remove it and ask again'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
        ELSE
            IF _from_id = 0 OR _to_id = 0 THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'approval.set: from_status_id and to_status_id are required'::text, NULL::jsonb;
                CONTINUE;
            END IF;
            IF NOT _approvers_present THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'approval.set: approver_ids is required'::text, NULL::jsonb;
                CONTINUE;
            END IF;
            SELECT sa.label INTO _label FROM task_status_action(_task_id, _from_id, _to_id) sa;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'approval_no_such_action'::text,
                    format('approval.set: no status action leads from %s to %s in this task''s flow',
                           _from_id, _to_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 3. Everyone asked must be a live person with a login who can see
        --    the project.
        SELECT string_agg(p::text, ', ') INTO _bad
        FROM unnest(_approvers) AS p
        WHERE NOT EXISTS (
            SELECT 1
            FROM card pc
            JOIN card_type pct ON pct.id = pc.card_type_id AND pct.name = 'person'
            JOIN user_account_person uap ON uap.person_card_id = pc.id
            WHERE pc.id = p AND pc.deleted_at IS NULL
              AND user_sees_project(uap.user_account_id, _project_id)
        );
        IF _bad IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false, 'approver_invalid'::text,
                format('approval.set: person %s can''t be asked: not a person with a login who can see this project', _bad),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Create the card (its card_create row records who asked, and when).
        _created := _id = 0;
        IF _created THEN
            INSERT INTO card (card_type_id, parent_card_id)
            VALUES (_approval_ct, _task_id)
            RETURNING id INTO _id;
            INSERT INTO activity (card_id, kind, actor_id)
            VALUES (_id, 'card_create', approval_set_batch.actor_id);
        END IF;

        -- 5. Set-based write of the CHANGED attributes only (value_old
        --    carried so the activity stream renders "old → new").
        WITH want(ord, attr_def_id, value) AS (
            SELECT row_number() OVER () AS ord, attr_def_id, value
            FROM (
                SELECT _title_def AS attr_def_id,
                       to_jsonb(format('%s: %s → %s', _label, card_label(_from_id), card_label(_to_id))) AS value
                WHERE _created
                UNION ALL
                SELECT _from_def, to_jsonb(_from_id) WHERE _created
                UNION ALL
                SELECT _to_def, to_jsonb(_to_id) WHERE _created
                UNION ALL
                SELECT _action_def, to_jsonb(_label) WHERE _created
                UNION ALL
                SELECT _approvers_def, to_jsonb(_approvers) WHERE _approvers_present
                UNION ALL
                SELECT _note_def, to_jsonb(_note) WHERE _note_present
            ) AS w
        ),
        changed AS (
            SELECT w.ord, w.attr_def_id, w.value, cur.value AS old_value
            FROM want w
            LEFT JOIN attribute_value cur
              ON cur.card_id = _id AND cur.attribute_def_id = w.attr_def_id
            WHERE cur.value IS DISTINCT FROM w.value
              -- A blank note on a request that never had one is no change.
              AND NOT (cur.value IS NULL AND w.value = to_jsonb(''::text))
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _id, 'attr_update', c.attr_def_id, c.old_value, c.value,
                   approval_set_batch.actor_id
            FROM changed c
            ORDER BY c.ord
            RETURNING id, attribute_def_id, value_new
        ),
        upsert AS (
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            SELECT _id, ia.attribute_def_id, ia.value_new, ia.id
            FROM ins_activity ia
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value,
                    last_activity_id = EXCLUDED.last_activity_id
            RETURNING 1
        )
        SELECT count(*)::int INTO _writes FROM upsert;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'approval_id', _id::text,
                'created', _created,
                'changed', _created OR _writes > 0
            );
    END LOOP;
END;
$$;

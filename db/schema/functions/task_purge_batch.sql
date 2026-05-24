-- task.purge handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side executeTaskPurge + helpers (loadChildCommIDs /
-- loadReplyBodiesForComms / flowStepBlockers) into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: card_id required.
--   2. Card exists + is a task (allow soft-deleted — purge is permanent).
--   3. flow_step reference guard → 'value_referenced_by_flow'.
--   4. Live sub-tasks via `parent_task` → 'has_live_subtasks'.
--   5. Live non-comm children parented to the task → 'has_live_children'.
--   6. Resolve child comm card ids; resolve reply_body card ids
--      referenced from each comm's `replies` array attribute.
--   7. Hard delete: reply_body cards (attribute_value / activity / card),
--      then comm cards likewise, then the task's attachments + its own
--      attribute_value / activity / card row.
--
-- Result JSON shape matches `card.TaskPurgeOutput`:
--   {
--     "ok": true,
--     "purged_card_ids": [<bigint>...],
--     "purged_reply_body_ids": [<bigint>...]  -- omit when empty
--   }
-- IDs are emitted as JSON numbers; the Go struct uses `[]int64`
-- without `,string` so this matches.
CREATE OR REPLACE FUNCTION task_purge_batch(
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
    _card_id bigint;
    _type_name text;
    _blocker_count int;
    _blockers jsonb;
    _subtask_count int;
    _noncomm_count int;
    _comm_ids bigint[];
    _reply_ids bigint[];
    _purged_ids bigint[];
BEGIN
    FOR _idx, _card_id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'card_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'task.purge: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Card exists + is a task. Allow soft-deleted rows — purge is
        --    permanent.
        SELECT ct.name INTO _type_name
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _card_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('task.purge: card %s not found', _card_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _type_name <> 'task' THEN
            RETURN QUERY SELECT _idx, false, 'wrong_card_type'::text,
                format('task.purge: card %s is not a task', _card_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. flow_step reference guard.
        SELECT count(*) INTO _blocker_count
        FROM flow_step fs
        WHERE fs.from_card_id = _card_id OR fs.to_card_id = _card_id;
        IF _blocker_count > 0 THEN
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'flow_step_id', fs.id::text,
                'flow_id', fs.flow_id::text,
                'flow_name', f.name,
                'role', CASE WHEN fs.from_card_id = _card_id THEN 'from' ELSE 'to' END,
                'from_label', COALESCE(av_from.value #>> '{}', ''),
                'to_label', COALESCE(av_to.value #>> '{}', ''),
                'step_label', fs.label
            ) ORDER BY fs.id), '[]'::jsonb)
              INTO _blockers
            FROM flow_step fs
            JOIN flow f ON f.id = fs.flow_id
            LEFT JOIN attribute_def ad_title ON ad_title.name = 'title'
            LEFT JOIN attribute_value av_from
              ON av_from.card_id = fs.from_card_id
             AND av_from.attribute_def_id = ad_title.id
            LEFT JOIN attribute_value av_to
              ON av_to.card_id = fs.to_card_id
             AND av_to.attribute_def_id = ad_title.id
            WHERE fs.from_card_id = _card_id OR fs.to_card_id = _card_id;
            RETURN QUERY SELECT _idx, false, 'value_referenced_by_flow'::text,
                format('task.purge: card %s is referenced by %s flow_step row(s); remove the steps first',
                    _card_id, _blocker_count),
                jsonb_build_object('blocked_by', _blockers);
            CONTINUE;
        END IF;

        -- 4. Live sub-tasks via parent_task.
        SELECT count(*) INTO _subtask_count
        FROM attribute_value av
        JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'parent_task'
        JOIN card c ON c.id = av.card_id AND c.deleted_at IS NULL
        WHERE jsonb_typeof(av.value) = 'number'
          AND (av.value)::text::bigint = _card_id;
        IF _subtask_count > 0 THEN
            RETURN QUERY SELECT _idx, false, 'has_live_subtasks'::text,
                format('task.purge: card %s has %s live sub-task(s); purge or re-parent them first',
                    _card_id, _subtask_count),
                jsonb_build_object('live_subtask_count', _subtask_count);
            CONTINUE;
        END IF;

        -- 5. Live non-comm children.
        SELECT count(*) INTO _noncomm_count
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.parent_card_id = _card_id
          AND c.deleted_at IS NULL
          AND ct.name <> 'comm';
        IF _noncomm_count > 0 THEN
            RETURN QUERY SELECT _idx, false, 'has_live_children'::text,
                format('task.purge: card %s has %s live non-comm child card(s); detach or delete them first',
                    _card_id, _noncomm_count),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 6. Resolve child comm + reply_body ids.
        SELECT COALESCE(array_agg(c.id ORDER BY c.id), ARRAY[]::bigint[])
          INTO _comm_ids
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'comm'
        WHERE c.parent_card_id = _card_id;

        IF array_length(_comm_ids, 1) IS NOT NULL THEN
            SELECT COALESCE(array_agg(DISTINCT reply_id ORDER BY reply_id), ARRAY[]::bigint[])
              INTO _reply_ids
            FROM (
                SELECT (e.value)::text::bigint AS reply_id
                FROM attribute_value av
                JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'replies'
                CROSS JOIN LATERAL jsonb_array_elements(av.value) AS e(value)
                JOIN card c ON c.id = (e.value)::text::bigint
                JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'reply_body'
                WHERE av.card_id = ANY(_comm_ids)
                  AND jsonb_typeof(av.value) = 'array'
                  AND jsonb_typeof(e.value) = 'number'
            ) s;
        ELSE
            _reply_ids := ARRAY[]::bigint[];
        END IF;

        _purged_ids := ARRAY[]::bigint[];

        -- 7. Hard delete in dependency order.
        IF array_length(_reply_ids, 1) IS NOT NULL THEN
            DELETE FROM attribute_value WHERE card_id = ANY(_reply_ids);
            DELETE FROM activity WHERE card_id = ANY(_reply_ids);
            DELETE FROM card WHERE id = ANY(_reply_ids);
            _purged_ids := _purged_ids || _reply_ids;
        END IF;

        IF array_length(_comm_ids, 1) IS NOT NULL THEN
            DELETE FROM attribute_value WHERE card_id = ANY(_comm_ids);
            DELETE FROM activity WHERE card_id = ANY(_comm_ids);
            DELETE FROM card WHERE id = ANY(_comm_ids);
            _purged_ids := _purged_ids || _comm_ids;
        END IF;

        DELETE FROM attachment WHERE card_id = _card_id;
        DELETE FROM attribute_value WHERE card_id = _card_id;
        DELETE FROM activity WHERE card_id = _card_id;
        DELETE FROM card WHERE id = _card_id;
        _purged_ids := array_append(_purged_ids, _card_id);

        IF array_length(_reply_ids, 1) IS NOT NULL THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object(
                    'ok', true,
                    'purged_card_ids', to_jsonb(_purged_ids),
                    'purged_reply_body_ids', to_jsonb(_reply_ids)
                );
        ELSE
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object(
                    'ok', true,
                    'purged_card_ids', to_jsonb(_purged_ids)
                );
        END IF;
    END LOOP;
END;
$$;

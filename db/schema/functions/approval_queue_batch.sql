-- approval.queue handler — "Waiting on you": the open approval requests
-- that name the caller and that they haven't decided yet, oldest first,
-- across every project they can see (or one, with project_id).
--
-- A request is open while its task is live, not in a terminal status
-- (done / cancelled), and hasn't reached the edge's target since it was
-- asked (approval_round_start). The caller is named through their linked
-- person card(s); a vote of theirs on the edge in its current round —
-- approve or reject, asked or before anyone asked — takes it off the queue
-- (they can still change it on the task).
--
-- Each row carries what the queue shows: the task and its project, its
-- current status, the action asked about (from → label → to), the note,
-- who asked and when, and the tally so far (approval_tally).
--
-- Result JSON shape matches `approval.QueueOutput`.
CREATE OR REPLACE FUNCTION approval_queue_batch(
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
    _status_def bigint;
    _idx int;
    _raw jsonb;
    _project_id bigint;
BEGIN
    SELECT id INTO _approval_ct FROM card_type WHERE name = 'approval';
    SELECT id INTO _status_def FROM attribute_def WHERE name = 'status';

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _project_id := NULLIF(NULLIF(_raw->>'project_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.queue: project_id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END;

        RETURN QUERY
        WITH me AS (
            SELECT uap.person_card_id AS person_id
            FROM user_account_person uap
            WHERE uap.user_account_id = approval_queue_batch.actor_id
        ),
        req AS (
            SELECT ap.id, ap.parent_card_id AS task_id, ap.created_at,
                   fl.from_id, fl.to_id, fl.action, fl.note, fl.approvers,
                   card_enclosing_project(ap.parent_card_id) AS project_id
            FROM card ap
            JOIN card task ON task.id = ap.parent_card_id AND task.deleted_at IS NULL
            CROSS JOIN LATERAL approval_fields(ap.id) fl
            WHERE ap.card_type_id = _approval_ct
              AND ap.deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM me WHERE fl.approvers @> to_jsonb(me.person_id))
        ),
        open_req AS (
            SELECT r.*, sc.id AS status_id
            FROM req r
            LEFT JOIN attribute_value cur
              ON cur.card_id = r.task_id AND cur.attribute_def_id = _status_def
            LEFT JOIN card sc
              ON sc.id = CASE WHEN jsonb_typeof(cur.value) = 'number' THEN (cur.value)::text::bigint END
            WHERE (_project_id IS NULL OR r.project_id = _project_id)
              AND r.project_id IS NOT NULL
              AND user_sees_project(approval_queue_batch.actor_id, r.project_id)
              AND COALESCE(sc.phase, '') <> 'terminal'
              AND COALESCE(approval_round_start(r.task_id, r.to_id), '-infinity'::timestamptz) < r.created_at
              AND NOT EXISTS (
                  SELECT 1 FROM activity d
                  WHERE d.card_id = r.task_id
                    AND d.kind = 'approval_decision'
                    AND d.actor_id = approval_queue_batch.actor_id
                    AND d.value_new->>'from_id' = r.from_id::text
                    AND d.value_new->>'to_id' = r.to_id::text
                    AND d.created_at > COALESCE(approval_round_start(r.task_id, r.to_id), '-infinity'::timestamptz)
              )
        )
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'approval_id', o.id::text,
                           'task_id', o.task_id::text,
                           'task_title', COALESCE(card_label(o.task_id), ''),
                           'project_id', o.project_id::text,
                           'project_title', COALESCE(card_label(o.project_id), ''),
                           'status', status_ref_json(o.status_id),
                           'from', status_ref_json(o.from_id),
                           'to', status_ref_json(o.to_id),
                           'action', o.action,
                           'note', o.note,
                           'requested_by', COALESCE(user_label(cr.actor_id), ''),
                           'requested_at', o.created_at,
                           'asked', tl.asked,
                           'approved', tl.approved,
                           'rejected', tl.rejected)
                       ORDER BY o.created_at, o.id)
                FROM open_req o
                LEFT JOIN LATERAL (
                    SELECT a.actor_id FROM activity a
                    WHERE a.card_id = o.id AND a.kind = 'card_create'
                    ORDER BY a.id LIMIT 1
                ) cr ON TRUE
                CROSS JOIN LATERAL approval_tally(o.task_id, o.from_id, o.to_id, o.approvers) tl
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

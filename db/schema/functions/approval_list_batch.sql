-- approval.list handler — everything the task page's Approvals section
-- shows, in one read:
--   status    — the task's current status ({id, label, phase})
--   actions   — every step of the task's status flow ({from, to, label}),
--               the choices for a new request or an unasked decision
--   requests  — the live approval cards: the edge, the note, who asked and
--               when (the card's card_create row), the people asked,
--               reached_at — when the task got to the edge's target after
--               the request (settling it); NULL while open — and comm, the
--               email thread the request started ({id, subject, messages};
--               NULL when it didn't or the thread is gone)
--   decisions — every approval_decision (vote) on the task, newest first:
--               who, approve / reject, the edge, the task's status at the
--               time, the reason, `settled` — cast before the task last
--               reached the edge's target (approval_round_start), so it
--               belongs to a finished round — and `stale` — the task has
--               since moved to a status other than the edge's target (sent
--               back for rework after the vote)
-- Grouping votes by edge, latest per person, and the people asked vs
-- others, is the caller's: it is presentation over these rows.
--
-- Visibility: the caller must see the task's project (DI-6), else
-- task_not_found.
--
-- Result JSON shape matches `approval.ListOutput`.
CREATE OR REPLACE FUNCTION approval_list_batch(
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
    _task_id bigint;
    _project_id bigint;
BEGIN
    SELECT id INTO _approval_ct FROM card_type WHERE name = 'approval';
    SELECT id INTO _status_def FROM attribute_def WHERE name = 'status';

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _task_id := COALESCE(NULLIF(_raw->>'task_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            _task_id := 0;
        END;
        IF _task_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.list: task_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _project_id := card_enclosing_project(_task_id);
        IF _project_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM card WHERE id = _task_id AND deleted_at IS NULL)
           OR NOT user_sees_project(approval_list_batch.actor_id, _project_id) THEN
            RETURN QUERY SELECT _idx, false, 'task_not_found'::text,
                format('approval.list: task %s not found', _task_id), NULL::jsonb;
            CONTINUE;
        END IF;

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'status', (
                    SELECT status_ref_json((av.value)::text::bigint)
                    FROM attribute_value av
                    WHERE av.card_id = _task_id AND av.attribute_def_id = _status_def
                      AND jsonb_typeof(av.value) = 'number'
                ),
                'actions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                               'from', status_ref_json(fs.from_card_id),
                               'to', status_ref_json(fs.to_card_id),
                               'label', fs.label)
                           ORDER BY COALESCE((
                               SELECT (so.value #>> '{}')::numeric
                               FROM attribute_value so
                               JOIN attribute_def sd ON sd.id = so.attribute_def_id AND sd.name = 'sort_order'
                               WHERE so.card_id = fs.from_card_id AND jsonb_typeof(so.value) = 'number'
                           ), 0), fs.from_card_id, fs.sort_order, fs.id)
                    FROM flow f
                    JOIN flow_step fs ON fs.flow_id = f.id
                    WHERE f.attribute_def_id = _status_def AND f.scope_card_id = _project_id
                ), '[]'::jsonb),
                'requests', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                               'id', ap.id::text,
                               'from', status_ref_json(fl.from_id),
                               'to', status_ref_json(fl.to_id),
                               'action', fl.action,
                               'note', fl.note,
                               'requested_by_id', COALESCE(cr.actor_id, 0)::text,
                               'requested_by', COALESCE(user_label(cr.actor_id), ''),
                               'requested_at', ap.created_at,
                               'reached_at', (
                                   SELECT rs FROM approval_round_start(_task_id, fl.to_id) AS rs
                                   WHERE rs >= ap.created_at),
                               'approvers', COALESCE((
                                   SELECT jsonb_agg(jsonb_build_object(
                                              'person_id', (e #>> '{}'),
                                              'name', COALESCE(card_label((e #>> '{}')::bigint), ''))
                                          ORDER BY ord)
                                   FROM jsonb_array_elements(fl.approvers) WITH ORDINALITY AS x(e, ord)
                               ), '[]'::jsonb),
                               'comm', (
                                   SELECT jsonb_build_object(
                                              'id', cm.id::text,
                                              'subject', COALESCE(card_label(cm.id), ''),
                                              'messages', COALESCE((
                                                  SELECT CASE WHEN jsonb_typeof(rv.value) = 'array'
                                                              THEN jsonb_array_length(rv.value) END
                                                  FROM attribute_value rv
                                                  JOIN attribute_def rd ON rd.id = rv.attribute_def_id
                                                  WHERE rv.card_id = cm.id AND rd.name = 'replies'
                                              ), 0))
                                   FROM card cm
                                   WHERE cm.id = fl.comm_id AND cm.deleted_at IS NULL))
                           ORDER BY ap.created_at, ap.id)
                    FROM card ap
                    CROSS JOIN LATERAL approval_fields(ap.id) fl
                    LEFT JOIN LATERAL (
                        SELECT a.actor_id FROM activity a
                        WHERE a.card_id = ap.id AND a.kind = 'card_create'
                        ORDER BY a.id LIMIT 1
                    ) cr ON TRUE
                    WHERE ap.parent_card_id = _task_id
                      AND ap.card_type_id = _approval_ct
                      AND ap.deleted_at IS NULL
                ), '[]'::jsonb),
                'decisions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                               'id', d.id::text,
                               'by_id', d.actor_id::text,
                               'by', COALESCE(user_label(d.actor_id), ''),
                               'person_id', COALESCE(d.value_new->>'person_id', ''),
                               'decision', d.value_new->>'decision',
                               'from_id', d.value_new->>'from_id',
                               'to_id', d.value_new->>'to_id',
                               'action', COALESCE(d.value_new->>'action', ''),
                               'settled', d.created_at <= COALESCE(
                                   approval_round_start(_task_id, (d.value_new->>'to_id')::bigint),
                                   '-infinity'::timestamptz),
                               'status', status_ref_json(NULLIF(d.value_new->>'status_id', '')::bigint),
                               'reason', COALESCE(cb.body, ''),
                               'at', d.created_at,
                               'stale', EXISTS (
                                   SELECT 1 FROM activity s
                                   WHERE s.card_id = _task_id
                                     AND s.kind = 'attr_update'
                                     AND s.attribute_def_id = _status_def
                                     AND s.id > d.id
                                     AND (s.value_new #>> '{}') IS DISTINCT FROM (d.value_new->>'to_id')
                               ))
                           ORDER BY d.id DESC)
                    FROM activity d
                    LEFT JOIN comment_body cb ON cb.id = (d.value_new->>'comment_body_id')::bigint
                    WHERE d.card_id = _task_id AND d.kind = 'approval_decision'
                ), '[]'::jsonb)
            );
    END LOOP;
END;
$$;

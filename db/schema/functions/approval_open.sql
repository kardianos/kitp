-- approval_open — a task's open approval requests: its live approval
-- cards whose step's target status the task hasn't reached since they
-- were asked (approval_round_start before created_at), while the task
-- itself isn't in a terminal status (done / cancelled).
--
-- The one definition of "open" behind the task's approval properties
-- (approval_summary, approval_state, approval_waiting_on,
-- approval_asked_at), so the list column, the filters and the sort can't
-- disagree. A task without requests costs one index probe on
-- card.parent_card_id.
CREATE OR REPLACE FUNCTION approval_open(p_task_id bigint)
RETURNS TABLE (id bigint, from_id bigint, to_id bigint, approvers jsonb, created_at timestamptz)
LANGUAGE sql STABLE AS $$
    SELECT ap.id, fl.from_id, fl.to_id, fl.approvers, ap.created_at
    FROM card ap
    JOIN card_type ct ON ct.id = ap.card_type_id AND ct.name = 'approval'
    CROSS JOIN LATERAL approval_fields(ap.id) fl
    WHERE ap.parent_card_id = p_task_id
      AND ap.deleted_at IS NULL
      AND COALESCE(approval_round_start(p_task_id, fl.to_id), '-infinity'::timestamptz) < ap.created_at
      AND NOT EXISTS (
          SELECT 1
          FROM attribute_value cur
          JOIN attribute_def sd ON sd.id = cur.attribute_def_id AND sd.name = 'status'
          JOIN card sc ON sc.id = CASE WHEN jsonb_typeof(cur.value) = 'number'
                                       THEN (cur.value)::text::bigint END
          WHERE cur.card_id = p_task_id
            AND sc.phase = 'terminal')
$$;

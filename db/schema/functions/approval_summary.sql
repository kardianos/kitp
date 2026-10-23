-- approval_summary — a task's approval badge for list rows: over its live
-- requests still open (the task hasn't reached the edge's target since it
-- was asked), {asked, approved, rejected} (approval_tally summed), or NULL
-- when none are open. card.select_with_attributes adds it per row on
-- with_approvals; a task without requests costs one index probe on
-- card.parent_card_id.
CREATE OR REPLACE FUNCTION approval_summary(p_task_id bigint)
RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object(
               'asked', sum(t.asked),
               'approved', sum(t.approved),
               'rejected', sum(t.rejected)) END
    FROM card ap
    JOIN card_type ct ON ct.id = ap.card_type_id AND ct.name = 'approval'
    CROSS JOIN LATERAL approval_fields(ap.id) fl
    CROSS JOIN LATERAL approval_tally(p_task_id, fl.from_id, fl.to_id, fl.approvers) t
    WHERE ap.parent_card_id = p_task_id
      AND ap.deleted_at IS NULL
      AND COALESCE(approval_round_start(p_task_id, fl.to_id), '-infinity'::timestamptz) < ap.created_at
$$;

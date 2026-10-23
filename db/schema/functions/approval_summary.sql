-- approval_summary — a task's Approvals column: over its open requests
-- (approval_open), {state, asked, approved, rejected, asked_at,
-- waiting_on_me}, or NULL when none are open.
--
--   state          'rejected' when anyone asked rejected, 'approved' when
--                  everyone asked approved, else 'open' (votes missing)
--   asked/approved/rejected
--                  approval_tally summed over the open requests
--   asked_at       when the oldest open request was made
--   waiting_on_me  approval_waiting_on for p_me (the viewer's person;
--                  false when NULL)
--
-- card.select_with_attributes adds it per row on with_approvals, and
-- approval_state reads its state for the filter and the sort.
CREATE OR REPLACE FUNCTION approval_summary(p_task_id bigint, p_me bigint)
RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object(
               'state', CASE WHEN sum(t.rejected) > 0 THEN 'rejected'
                             WHEN sum(t.approved) = sum(t.asked) THEN 'approved'
                             ELSE 'open' END,
               'asked', sum(t.asked),
               'approved', sum(t.approved),
               'rejected', sum(t.rejected),
               'asked_at', min(o.created_at),
               'waiting_on_me', COALESCE(p_me IS NOT NULL
                                         AND approval_waiting_on(p_task_id, ARRAY[p_me]), false)) END
    FROM approval_open(p_task_id) o
    CROSS JOIN LATERAL approval_tally(p_task_id, o.from_id, o.to_id, o.approvers) t
$$;

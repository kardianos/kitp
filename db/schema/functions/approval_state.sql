-- approval_state — a task's approval state for filters and sorting:
-- 'open' (votes still missing), 'rejected', 'approved' (approval_summary's
-- state over its open requests) or 'none' (no open request).
CREATE OR REPLACE FUNCTION approval_state(p_task_id bigint)
RETURNS text LANGUAGE sql STABLE AS $$
    SELECT COALESCE(approval_summary(p_task_id, NULL)->>'state', 'none')
$$;

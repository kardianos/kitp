-- approval_asked_at — when a task's oldest open approval request
-- (approval_open) was made; NULL when none is open. Backs the "Approval
-- asked" filter (within_last_days) and sort.
CREATE OR REPLACE FUNCTION approval_asked_at(p_task_id bigint)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
    SELECT min(o.created_at) FROM approval_open(p_task_id) o
$$;

-- approval_waiting_on — whether a task waits on any of p_people for a
-- vote: one of its open requests (approval_open) asks the person, and
-- they haven't voted on that request's step (from → to) in the step's
-- current round. Approve or reject both count as voted. An agent's vote
-- carries no person, so it never answers for one.
--
-- Backs the "Vote needed from" filter (attr approval_waiting_on in
-- card_compile_predicate and where.go) and approval_summary's
-- waiting_on_me.
CREATE OR REPLACE FUNCTION approval_waiting_on(p_task_id bigint, p_people bigint[])
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM approval_open(p_task_id) o
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.approvers, '[]'::jsonb)) AS e
        WHERE CASE WHEN (e #>> '{}') ~ '^[0-9]+$' THEN (e #>> '{}')::bigint END = ANY (p_people)
          AND NOT EXISTS (
              SELECT 1
              FROM activity d
              WHERE d.card_id = p_task_id
                AND d.kind = 'approval_decision'
                AND d.value_new->>'person_id' = (e #>> '{}')
                AND d.value_new->>'from_id' = o.from_id::text
                AND d.value_new->>'to_id' = o.to_id::text
                AND d.created_at > COALESCE(approval_round_start(p_task_id, o.to_id), '-infinity'::timestamptz))
    )
$$;

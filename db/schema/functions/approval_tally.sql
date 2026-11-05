-- approval_tally — how a request stands: of the people it asks
-- (p_approvers, a card_ref[] value), how many have approved / rejected the
-- edge p_from → p_to, by each person's LATEST vote on that edge in its
-- current round (approval_round_start). Votes belong to the edge, not the
-- request, so a vote cast before anyone asked still counts. Used by
-- approval_summary.
--
-- Someone asked who has not voted in the round and can no longer vote (no
-- login with comment rights on the task's project, as approval_waiting_on
-- judges) isn't counted: they would hold the request open for good
-- (review 2026-11-03 round 5, worth a look). A vote they cast while they
-- could still counts.
CREATE OR REPLACE FUNCTION approval_tally(p_task_id bigint, p_from bigint, p_to bigint, p_approvers jsonb)
RETURNS TABLE (asked int, approved int, rejected int) LANGUAGE sql STABLE AS $$
    WITH asked AS (
        SELECT DISTINCT (e #>> '{}')::bigint AS person_id
        FROM jsonb_array_elements(COALESCE(p_approvers, '[]'::jsonb)) AS e
    ),
    latest AS (
        SELECT DISTINCT ON (a.value_new->>'person_id')
               (a.value_new->>'person_id')::bigint AS person_id,
               a.value_new->>'decision' AS decision
        FROM activity a
        WHERE a.card_id = p_task_id
          AND a.kind = 'approval_decision'
          AND a.value_new->>'from_id' = p_from::text
          AND a.value_new->>'to_id' = p_to::text
          AND a.value_new ? 'person_id'
          AND a.created_at > COALESCE(approval_round_start(p_task_id, p_to), '-infinity'::timestamptz)
        ORDER BY a.value_new->>'person_id', a.id DESC
    )
    SELECT count(*)::int,
           (count(*) FILTER (WHERE l.decision = 'approve'))::int,
           (count(*) FILTER (WHERE l.decision = 'reject'))::int
    FROM asked k
    LEFT JOIN latest l ON l.person_id = k.person_id
    WHERE l.person_id IS NOT NULL
       OR EXISTS (
              SELECT 1 FROM user_account_person uap
              WHERE uap.person_card_id = k.person_id
                AND user_has_grant(uap.user_account_id, 'task', 'comment.post', card_enclosing_project(p_task_id)))
$$;

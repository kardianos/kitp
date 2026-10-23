-- approval_round_start — where the current round of votes on an edge
-- begins: the last time the task's status changed to the edge's target
-- (p_to), or NULL when it never has. Votes on the edge cast after it are
-- current; votes at or before it were settled when the task got there.
-- They leave the task's approval properties (approval_open) but stay
-- on the task.
CREATE OR REPLACE FUNCTION approval_round_start(p_task_id bigint, p_to bigint)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
    SELECT max(s.created_at)
    FROM activity s
    JOIN attribute_def sd ON sd.id = s.attribute_def_id AND sd.name = 'status'
    WHERE s.card_id = p_task_id
      AND s.kind = 'attr_update'
      AND (s.value_new #>> '{}') = p_to::text
$$;

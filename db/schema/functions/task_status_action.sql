-- task_status_action — the status-flow step an approval names: the step
-- from → to in the flow bound to `status` in the task's project (the lowest
-- sort_order when the pair carries several labels). No row when the
-- project has no status flow or the flow has no such step.
CREATE OR REPLACE FUNCTION task_status_action(p_task_id bigint, p_from bigint, p_to bigint)
RETURNS TABLE (step_id bigint, label text) LANGUAGE sql STABLE AS $$
    SELECT fs.id, fs.label
    FROM flow f
    JOIN attribute_def ad ON ad.id = f.attribute_def_id AND ad.name = 'status'
    JOIN flow_step fs
      ON fs.flow_id = f.id AND fs.from_card_id = p_from AND fs.to_card_id = p_to
    WHERE f.scope_card_id = card_enclosing_project(p_task_id)
    ORDER BY fs.sort_order, fs.id
    LIMIT 1
$$;

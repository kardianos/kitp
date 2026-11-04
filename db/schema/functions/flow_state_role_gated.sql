-- flow_state_role_gated — whether p_state is a state of flow p_flow that
-- p_actor couldn't move a card into in p_project: some step leads into it,
-- and every one of those steps needs a role the actor doesn't hold
-- (user_has_step_role). The flow's own starting state
-- (default_create_status_id) is never gated. A card can't be started,
-- moved or merged into such a state by someone who couldn't take a step
-- there: card.insert, task.move and card.merge all ask this (review
-- 2026-11-03 #16, round 2 #4).
CREATE OR REPLACE FUNCTION flow_state_role_gated(p_actor bigint, p_flow bigint, p_state bigint, p_project bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT p_state IS DISTINCT FROM (SELECT f.default_create_status_id FROM flow f WHERE f.id = p_flow)
       AND EXISTS (SELECT 1 FROM flow_step fs WHERE fs.flow_id = p_flow AND fs.to_card_id = p_state)
       AND NOT EXISTS (
           SELECT 1 FROM flow_step fs
           WHERE fs.flow_id = p_flow AND fs.to_card_id = p_state
             AND user_has_step_role(p_actor, fs.requires_role_id, p_project))
$$;

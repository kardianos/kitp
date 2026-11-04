-- user_has_step_role — whether an account may take a flow step that needs
-- `wanted` (flow_step.requires_role_id; NULL = anyone) in `project`: it holds
-- the system role globally, or a role that covers `wanted` (role_covers: the
-- same role or a built-in one ranked above it) globally or on the project.
-- One rule for attribute.update's flow gate, card.insert's starting state,
-- and the `allowed` / `your_role_allows` bits the step lists show — so an
-- admin passes a manager step, and an agent never takes a step its owner
-- couldn't (review 2026-11-03 #24; user_role_effective already limits an
-- agent to roles its owner covers).
CREATE OR REPLACE FUNCTION user_has_step_role(actor bigint, wanted bigint, project bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT wanted IS NULL
        OR EXISTS (
            SELECT 1 FROM user_role_effective(actor) ur
            JOIN role sr ON sr.id = ur.role_id
            WHERE ur.user_id = actor AND sr.name = 'system' AND ur.scope_card_id IS NULL)
        OR EXISTS (
            SELECT 1 FROM user_role_effective(actor) ur
            WHERE ur.user_id = actor
              AND role_covers(ur.role_id, wanted)
              AND (ur.scope_card_id IS NULL OR ur.scope_card_id = project))
$$;

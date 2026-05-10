-- 0030_classify_spawn_role_grants.sql — OIDC role grants for card.classify
-- and gate.spawn on task.
--
-- Background: companion to 0029 (workflow authoring grants). Migrations
-- 0021 and 0027 registered card.classify and gate.spawn but only granted
-- the dev `system` role (via CROSS JOIN over every card_type). The
-- workflow_def, classify, and gate handlers all declare
-- AllowedRoles=[worker, manager, admin], so the role-name gate passes
-- for those callers, but the per-leaf (card_type, process) check fails
-- because no role_grant row exists.
--
-- Effect: OIDC workers/managers/admins can now classify a task and (when
-- a process or future call site invokes it directly) spawn gates under
-- a task. Only `task` is granted because it is currently the sole
-- card_type with a workflow_def_ref edge (see 0021). When more
-- card_types become classifiable, their introducing migration should
-- add the matching grants.
--
-- Forward-only and idempotent.

INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name IN ('worker', 'manager', 'admin')
  AND ct.name = 'task'
  AND p.name IN ('card.classify', 'gate.spawn')
ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;

-- 0029_workflow_admin_grants.sql — admin role grants for workflow authoring.
--
-- Background: migration 0010 seeded admin grants only against the original
-- card_types (project/milestone/component/tag/task). When workflow_def
-- (0021) and gate_template (0025) were added, only the dev `system` role
-- received grants (via 0013's CROSS JOIN backfill on `system`). In OIDC
-- mode an admin user hit `user lacks grant on (card_type=7,
-- process="card.create", project=N)` when creating a workflow at
-- /admin/workflows, because no role_grant row connected admin to those
-- new card_types.
--
-- Authoring a workflow means creating workflow_def cards and the
-- gate_template children inside them, so we grant card.create / .update /
-- .delete on both. The runtime `gate` card_type is intentionally not
-- listed: gates are spawned by the dispatcher (gate.spawn), not authored
-- by hand. card.classify and gate.spawn role coverage are separate gaps
-- tracked elsewhere.
--
-- Forward-only and idempotent.

INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'admin'
  AND ct.name IN ('workflow_def', 'gate_template')
  AND p.name IN ('card.create', 'card.update', 'card.delete')
ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;

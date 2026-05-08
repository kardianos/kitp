-- 0027_gate_spawn_process.sql — register gate.spawn as a process step.
--
-- Background: WORKFLOW_HYBRID_PLAN.md "Spawn ordering" + Phase 3.
--
-- card.classify already runs attribute.update at ordinal=1 (set
-- workflow_def_ref + status). This migration registers gate.spawn
-- (a server-side handler in dom/gate) and adds it as ordinal=2 so
-- gates exist before any subsequent process step that might consult
-- them.
--
-- The handler itself is registered on startup; this migration only
-- wires it into the process_step table so the dispatcher knows to
-- run it.
--
-- Forward-only and idempotent.

INSERT INTO process (name) VALUES ('gate.spawn')
ON CONFLICT (name) DO NOTHING;

INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 1, 'gate', 'spawn' FROM process p WHERE p.name = 'gate.spawn'
ON CONFLICT (process_id, ordinal) DO NOTHING;

-- card.classify gains the gate spawn as its second step. We also keep
-- the existing ordinal=1 step. Re-runs are idempotent because of the
-- ON CONFLICT.
INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 2, 'gate', 'spawn' FROM process p WHERE p.name = 'card.classify'
ON CONFLICT (process_id, ordinal) DO NOTHING;

-- System role gets gate.spawn against every card_type.
INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'system' AND p.name = 'gate.spawn'
ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;

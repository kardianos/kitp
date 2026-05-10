-- 0031_system_grants_rebackfill.sql — re-run the system cross-join so any
-- (card_type, process) pairs introduced after 0013 are covered.
--
-- Background: migration 0013 backfilled the `system` role against every
-- (card_type, process) pair that existed at the time, but migrations are
-- forward-only — 0013 itself never replays. Each new card_type or
-- process added after 0013 (workflow_def in 0021, gate_template/gate in
-- 0025, user_card_sort.set in 0010, card.classify in 0021, gate.spawn in
-- 0027, etc.) needed explicit `system` grants in the introducing
-- migration. Several didn't, so dev-mode (AUTH_MODE=off) calls to
-- `card.create` on `workflow_def` / `gate_template` / `gate` failed.
--
-- This is the same cross-join 0013 ran, just executed again against the
-- current snapshot. Idempotent on (role_id, card_type_id, process_id).
-- Future card_types/processes should still grant `system` explicitly in
-- their introducing migration; this catch-up exists to close the
-- accumulated gaps and unblock the workflow authoring tests.
--
-- Forward-only and idempotent.

INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'system'
ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;

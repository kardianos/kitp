-- 0013_system_grants_backfill.sql — backfill role_grant rows for the
-- 'system' dev role.
--
-- Migration 0003 seeded a CROSS JOIN that gave the System User every grant
-- against every (card_type, process) tuple in existence at THAT moment. New
-- processes added later (notably user_card_sort.set in 0010) were granted to
-- worker/manager/admin but never backfilled to system, so dev-mode
-- (AUTH_MODE=off) requests against new processes returned `unauthorized`.
--
-- The fix is idempotent: re-run the original CROSS JOIN with ON CONFLICT
-- DO NOTHING so any future "added a process to migration N" miss is also
-- patched up the next time this migration set is replayed. Tests assert it.

INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'system'
ON CONFLICT (role_id, card_type_id, process_id) DO NOTHING;

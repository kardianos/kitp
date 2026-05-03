-- 0010_oidc_roles.sql — OIDC + role-based authorization (Phase 20).
--
-- Adds the bones needed to flip from dev-only "System User holds every grant"
-- to a real role model with OIDC-driven user provisioning. The dev "system"
-- role/grants stay (so AUTH_MODE=off still works); we layer four new roles
-- on top.

-- 1. user_account columns we need at OIDC time. oidc_sub already exists from
-- 0001 but we want to be defensive (idempotent re-runs are safe). email is
-- new.
ALTER TABLE user_account ADD COLUMN IF NOT EXISTS email text;

-- Backfill email for the seeded team members so the assignee dropdown can
-- show one alongside display_name without another migration later.
UPDATE user_account SET email = 'alice@example.invalid' WHERE display_name = 'alice' AND email IS NULL;
UPDATE user_account SET email = 'bob@example.invalid'   WHERE display_name = 'bob'   AND email IS NULL;
UPDATE user_account SET email = 'carol@example.invalid' WHERE display_name = 'carol' AND email IS NULL;
UPDATE user_account SET email = 'dave@example.invalid'  WHERE display_name = 'dave'  AND email IS NULL;
UPDATE user_account SET email = 'eve@example.invalid'   WHERE display_name = 'eve'   AND email IS NULL;

-- 2. role table needs a doc column so role.list / admin UI can describe each
-- role to the user. The column is nullable to keep the existing 'system'
-- row intact; we backfill it below.
ALTER TABLE role ADD COLUMN IF NOT EXISTS doc text;
UPDATE role SET doc = 'Internal role held by the System User in dev mode; carries every grant.' WHERE name = 'system' AND doc IS NULL;

-- 3. The four new roles.
INSERT INTO role (name, doc) VALUES
    ('viewer',  'Read-only access. No write grants.'),
    ('worker',  'Can act on tasks: update status/assignee, post comments, apply tags, reorder personal inbox.'),
    ('manager', 'Worker plus the ability to create/edit/delete projects, milestones, components, and tags within scope.'),
    ('admin',   'Manager plus user role management and OIDC claim mapping.')
ON CONFLICT (name) DO UPDATE SET doc = EXCLUDED.doc;

-- 4. user_card_sort.set wasn't a process before this migration; introduce it
-- so role_grant can target it. Same with the missing comment.post entry's
-- card_type assumption (already present from 0003 — reuse it as-is).
INSERT INTO process (name) VALUES ('user_card_sort.set') ON CONFLICT DO NOTHING;

INSERT INTO process_step (process_id, ordinal, endpoint, action)
SELECT p.id, 1, 'user_card_sort', 'set' FROM process p WHERE p.name = 'user_card_sort.set'
ON CONFLICT (process_id, ordinal) DO NOTHING;

-- 5. role_grant rows. We seed by joining names to keep the migration
-- portable. The ID columns we look up: role.id, card_type.id, process.id.
--
-- worker grants: act on the 'task' card_type only.
INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'worker'
  AND ct.name = 'task'
  AND p.name IN ('card.update','comment.post','user_card_sort.set')
ON CONFLICT DO NOTHING;

-- manager grants: every worker grant PLUS create/update/delete on
-- project/milestone/component/tag.
INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'manager'
  AND ct.name = 'task'
  AND p.name IN ('card.update','comment.post','user_card_sort.set')
ON CONFLICT DO NOTHING;

INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'manager'
  AND ct.name IN ('project','milestone','component','tag')
  AND p.name IN ('card.create','card.update','card.delete')
ON CONFLICT DO NOTHING;

-- admin grants: every grant the manager has, plus card.* on task,
-- everything else for symmetry. user_role.* / role_mapping.* are seeded
-- separately below because they're not (card_type, process) tuples in the
-- same way (they're admin-only handler-level checks).
INSERT INTO role_grant (role_id, card_type_id, process_id)
SELECT r.id, ct.id, p.id
FROM role r
CROSS JOIN card_type ct
CROSS JOIN process p
WHERE r.name = 'admin'
  AND ct.name IN ('project','milestone','component','tag','task')
  AND p.name IN ('card.create','card.update','card.delete','comment.post','user_card_sort.set')
ON CONFLICT DO NOTHING;

-- 6. role_mapping table — claim value (e.g. "kitp.admin") -> role.
CREATE TABLE IF NOT EXISTS role_mapping (
    claim_value text PRIMARY KEY,
    role_id     int NOT NULL REFERENCES role(id)
);

-- 7. Optional dev seed for the dex flow. Maps the conventional group names
-- to the new roles so a fresh stack lights up without admin click-through.
INSERT INTO role_mapping (claim_value, role_id)
SELECT 'kitp.admin', r.id FROM role r WHERE r.name = 'admin'
ON CONFLICT (claim_value) DO NOTHING;

INSERT INTO role_mapping (claim_value, role_id)
SELECT 'kitp.manager', r.id FROM role r WHERE r.name = 'manager'
ON CONFLICT (claim_value) DO NOTHING;

INSERT INTO role_mapping (claim_value, role_id)
SELECT 'kitp.worker', r.id FROM role r WHERE r.name = 'worker'
ON CONFLICT (claim_value) DO NOTHING;

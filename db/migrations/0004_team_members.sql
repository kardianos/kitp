-- 0004_team_members.sql — seeds a small team of user_account rows so the
-- Phase 14/15 UI assignee dropdown has something to show before OIDC lands.
-- The migration runner tracks applied migrations so this only runs once,
-- but the NOT EXISTS guards make manual re-run safe regardless.

INSERT INTO user_account (oidc_sub, display_name)
SELECT NULL, 'alice'
WHERE NOT EXISTS (SELECT 1 FROM user_account WHERE display_name = 'alice');

INSERT INTO user_account (oidc_sub, display_name)
SELECT NULL, 'bob'
WHERE NOT EXISTS (SELECT 1 FROM user_account WHERE display_name = 'bob');

INSERT INTO user_account (oidc_sub, display_name)
SELECT NULL, 'carol'
WHERE NOT EXISTS (SELECT 1 FROM user_account WHERE display_name = 'carol');

INSERT INTO user_account (oidc_sub, display_name)
SELECT NULL, 'dave'
WHERE NOT EXISTS (SELECT 1 FROM user_account WHERE display_name = 'dave');

INSERT INTO user_account (oidc_sub, display_name)
SELECT NULL, 'eve'
WHERE NOT EXISTS (SELECT 1 FROM user_account WHERE display_name = 'eve');

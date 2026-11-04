-- account_principal — the human an account acts for: a personal agent's
-- owner, else the account itself (NULL for NULL). Two accounts with the
-- same principal are one person's: what one uploaded or started, the other
-- may continue (an import job, bytes sent for a file). A workspace agent
-- (owned by System, user_account 1) is its own principal: workspace agents
-- are separate integrations, not one person (review 2026-11-03 round 3 #2).
CREATE OR REPLACE FUNCTION account_principal(account bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT ua.parent_user_id FROM user_account ua
         WHERE ua.id = account AND ua.is_agent AND ua.parent_user_id IS NOT NULL
           AND ua.parent_user_id <> 1),
        account)
$$;

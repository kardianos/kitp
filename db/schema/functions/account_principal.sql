-- account_principal — the human an account acts for: an agent's owner, else
-- the account itself (NULL for NULL). Two accounts with the same principal
-- are one person's: what one uploaded or started, the other may continue
-- (an import job, bytes sent for a file).
CREATE OR REPLACE FUNCTION account_principal(account bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT ua.parent_user_id FROM user_account ua
         WHERE ua.id = account AND ua.is_agent AND ua.parent_user_id IS NOT NULL),
        account)
$$;

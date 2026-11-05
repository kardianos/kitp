-- cas_reader_principals — the accounts whose uploaded bytes a reader may use
-- in file.create: its principal (an agent's owner, else itself) and that
-- principal's personal agents. A workspace agent (owned by System) is its
-- own principal, so System's agents are not System's.
--
-- Worked out once per request and matched against cas_blob_holder by key
-- (h.user_id = ANY(...)): per address it cost an agent lookup each, and
-- 75,000 addresses took cas.missing_chunks past its timeout (review
-- 2026-11-03 round 5 #12). user_account(parent_user_id) is indexed.
CREATE OR REPLACE FUNCTION cas_reader_principals(reader bigint)
RETURNS bigint[] LANGUAGE sql STABLE AS $$
    SELECT array_agg(p.id) FROM (
        SELECT account_principal(reader) AS id
        UNION
        SELECT ua.id FROM user_account ua
        WHERE ua.is_agent
          AND ua.parent_user_id = account_principal(reader)
          AND ua.parent_user_id <> 1
    ) p
$$;

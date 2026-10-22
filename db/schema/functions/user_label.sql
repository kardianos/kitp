-- user_label — how a user_account is named wherever the UI or a message
-- says who did something: the display name, plus the owner for a
-- personal agent ("claude (for Daniel Theophanes)"), since several
-- people can run an agent under the same name. A workspace agent is
-- parented to the System account (id 1, see agent_create_batch) and
-- belongs to no one, so it keeps its bare name ("Gerrit"). NULL for an
-- unknown id.
CREATE OR REPLACE FUNCTION user_label(user_id bigint)
RETURNS text LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN u.is_agent AND o.id IS NOT NULL AND o.id <> 1
            THEN u.display_name || ' (for ' || o.display_name || ')'
        ELSE u.display_name
    END
    FROM user_account u
    LEFT JOIN user_account o ON o.id = u.parent_user_id
    WHERE u.id = user_id
$$;

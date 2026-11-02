-- user_sees_project — DI-6 visibility for one project: the user (or, for an
-- agent, the human who owns it) holds a role that is global or scoped to
-- the project or a card above it. The approval handlers ask it of both the
-- caller and the people a request names.
CREATE OR REPLACE FUNCTION user_sees_project(p_user_id bigint, p_project_id bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM user_account u
        CROSS JOIN LATERAL user_role_visible(u.id) ur
        WHERE u.id = p_user_id
          AND (ur.scope_card_id IS NULL
               OR ur.scope_card_id IN (SELECT a.id FROM card_ancestors(p_project_id) a))
    )
$$;

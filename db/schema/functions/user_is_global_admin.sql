-- user_is_global_admin — whether a user holds the admin (or system) role workspace-wide
-- (not scoped to one project), by user_role_effective: an agent only while
-- its owner does too. The single admin check behind the admin-only
-- handlers and the role gate's rule that an admin handler with no project
-- to check against needs a workspace admin (auth.IsGlobalAdmin).
CREATE OR REPLACE FUNCTION user_is_global_admin(for_user bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM user_role_effective(for_user) ur
        JOIN role r ON r.id = ur.role_id
        WHERE r.name IN ('admin', 'system') AND ur.scope_card_id IS NULL
    )
$$;

-- user_role_effective — the role rows a user can use (docs: admin_agents.md).
--
-- A person's are their own user_role rows. An agent's (a user with a
-- parent_user_id) are its own rows that its owner covers: the same role or
-- one ranked above it (role_covers: viewer < commenter < worker < manager <
-- admin), at the same scope or workspace-wide. An agent starts with
-- nothing, is granted roles explicitly, and uses one only while its owner
-- covers it there, so it never sees or does more than its owner: not
-- through a row granted before user_role.set enforced that, nor after the
-- owner loses the role. An owner with admin alone covers an agent's worker
-- role, since admin's grants contain worker's.
--
-- Every role check reads this — card visibility (VisibilityClause,
-- card_visible_to, user_sees_project and the handlers' inline copies), the
-- dispatcher's grants, the role gate and the admin checks — so the rule
-- lives in one place. A plain SELECT, so Postgres inlines it into the
-- query that calls it. Listing, revoking and the OIDC reconcile work on
-- the stored user_role rows, not this.
CREATE OR REPLACE FUNCTION user_role_effective(for_user bigint)
RETURNS TABLE (user_id bigint, role_id bigint, scope_card_id bigint)
LANGUAGE sql STABLE AS $$
    SELECT ur.user_id, ur.role_id, ur.scope_card_id
    FROM user_role ur
    JOIN user_account u ON u.id = ur.user_id
    WHERE ur.user_id = for_user
      AND (u.parent_user_id IS NULL
           OR EXISTS (SELECT 1 FROM user_role pr
                      WHERE pr.user_id = u.parent_user_id
                        AND role_covers(pr.role_id, ur.role_id)
                        AND (pr.scope_card_id IS NULL OR pr.scope_card_id = ur.scope_card_id)))
$$;

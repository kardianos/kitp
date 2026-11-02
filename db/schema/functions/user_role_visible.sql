-- user_role_visible — the role rows that decide what a user can SEE (DI-6
-- visibility: VisibilityClause, card_visible_to, user_sees_project and the
-- read handlers' inline copies). A person's are their own. An agent's are
-- its owner's: an agent acts on its owner's behalf, so it sees exactly
-- what its owner sees — never more, whatever rows of its own it holds, and
-- nothing once it has no owner.
--
-- What a user can DO (the dispatcher's grants, the role gate, admin
-- checks) reads user_role_effective instead: an agent acts only with roles
-- it was granted that its owner also holds.
CREATE OR REPLACE FUNCTION user_role_visible(for_user bigint)
RETURNS TABLE (user_id bigint, role_id bigint, scope_card_id bigint)
LANGUAGE sql STABLE AS $$
    SELECT u.id, ur.role_id, ur.scope_card_id
    FROM user_account u
    JOIN user_role ur ON ur.user_id = COALESCE(u.parent_user_id, u.id)
    WHERE u.id = for_user
$$;

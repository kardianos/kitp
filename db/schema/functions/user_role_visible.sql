-- user_role_visible — the role rows that decide what a user can SEE (DI-6
-- visibility: VisibilityClause, card_visible_to, user_sees_project and the
-- read handlers' inline copies). A person's are their own. A personal
-- agent's are its owner's: it acts on its owner's behalf, so it sees
-- exactly what its owner sees — never more, whatever rows of its own it
-- holds. A workspace agent (owned by System, user_account 1, which holds
-- every role workspace-wide) sees by its own rows instead: "what its owner
-- sees" would be everything, whatever it was granted (review 2026-11-03
-- round 3 #2). System covers every role, so its own rows are also exactly
-- the ones it may use (user_role_effective).
--
-- What a user can DO (the dispatcher's grants, the role gate, admin
-- checks) reads user_role_effective instead: an agent acts only with roles
-- it was granted that its owner also holds.
CREATE OR REPLACE FUNCTION user_role_visible(for_user bigint)
RETURNS TABLE (user_id bigint, role_id bigint, scope_card_id bigint)
LANGUAGE sql STABLE AS $$
    SELECT u.id, ur.role_id, ur.scope_card_id
    FROM user_account u
    JOIN user_role ur ON ur.user_id = CASE WHEN u.parent_user_id = 1 THEN u.id
                                           ELSE COALESCE(u.parent_user_id, u.id) END
    WHERE u.id = for_user
$$;

-- card_visible_to — the per-row read predicate (DI-6) as a function, for
-- PL/pgSQL handlers that check one card at a time: true when the caller
-- (or, for an agent, its owner — user_role_visible) holds a user_role that
-- is global or scoped to a project the card chains up to, and no card in
-- that chain belongs to an area that is switched off (card_in_off_area —
-- that hides it from everyone, admins included). A message (reply_body)
-- chains on from its thread.
--
-- The same SQL as schema.VisibilityClause: one parent walk serves both the
-- role scope and the area test (review A14). PL/pgSQL so its plan is cached
-- per session; a plain-SQL function with subqueries is re-planned on every
-- call (about a millisecond each). TestVisibilityAgrees keeps this,
-- VisibilityClause and card_in_off_area in step.
CREATE OR REPLACE FUNCTION card_visible_to(actor_id bigint, card_id bigint)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
    _start bigint := card_visible_to.card_id;
    _private bigint;
BEGIN
    -- A private card (card.private_to, docs/PERSONAL_SCREENS.md) is its
    -- person's alone, whatever roles anyone holds.
    SELECT c.private_to INTO _private FROM card c WHERE c.id = card_visible_to.card_id;
    IF _private IS NOT NULL THEN
        RETURN COALESCE(_private = account_person(card_visible_to.actor_id), false);
    END IF;
    -- A message walks from its thread (see card_in_off_area).
    IF EXISTS (SELECT 1 FROM card r JOIN card_type rt ON rt.id = r.card_type_id
               WHERE r.id = card_visible_to.card_id AND rt.name = 'reply_body') THEN
        SELECT rv.card_id INTO _start
        FROM attribute_value rv
        JOIN attribute_def rd ON rd.id = rv.attribute_def_id AND rd.name = 'replies'
        WHERE jsonb_typeof(rv.value) = 'array' AND rv.value @> to_jsonb(card_visible_to.card_id)
        ORDER BY rv.card_id
        LIMIT 1;
        IF _start IS NULL THEN
            _start := card_visible_to.card_id; -- not on a thread: just itself
        END IF;
    END IF;
    RETURN EXISTS (
        WITH RECURSIVE up(id, parent_card_id, card_type_id, depth) AS (
            SELECT c.id, c.parent_card_id, c.card_type_id, 0
            FROM card c WHERE c.id = _start
            UNION ALL
            SELECT p.id, p.parent_card_id, p.card_type_id, up.depth + 1
            FROM card p JOIN up ON p.id = up.parent_card_id
            WHERE up.depth < 16
        ),
        chain AS (
            SELECT up.id, ct.name FROM up JOIN card_type ct ON ct.id = up.card_type_id
        )
        SELECT 1
        FROM user_account caller
        CROSS JOIN LATERAL user_role_visible(caller.id) ur
        WHERE caller.id = card_visible_to.actor_id
          AND (ur.scope_card_id IS NULL
               OR ur.scope_card_id IN (SELECT chain.id FROM chain WHERE chain.name = 'project'))
          AND ((NOT EXISTS (SELECT 1 FROM project_area WHERE state = 'off')
                AND NOT EXISTS (SELECT 1 FROM workspace_area WHERE state = 'off'))
               OR NOT EXISTS (
                 SELECT 1 FROM chain x JOIN area a ON a.card_types ? x.name
                 WHERE (a.scope = 'workspace'
                        AND EXISTS (SELECT 1 FROM workspace_area w WHERE w.area_key = a.key AND w.state = 'off'))
                    OR (a.scope = 'project'
                        AND EXISTS (SELECT 1 FROM project_area pa
                                    WHERE pa.area_key = a.key AND pa.state = 'off'
                                      AND pa.project_id IN (SELECT y.id FROM chain y WHERE y.name = 'project')))))
    );
END
$$;

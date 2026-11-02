-- card_visible_to — the per-row read predicate (DI-6) as a function, for
-- PL/pgSQL handlers that check one card at a time: true when the caller
-- (or, for an agent, its owner) holds a user_role that is global or scoped
-- to the card's enclosing project, and the card isn't in an area that is
-- switched off (card_in_off_area — that hides it from everyone, admins
-- included). Mirrors schema.VisibilityClause and the inline checks in
-- link_list_batch / comm_list_for_task_batch.
--
-- NB: declared after card_enclosing_project and card_in_off_area in schema.hcsv — SQL-language
-- function bodies resolve their callees at CREATE time.
CREATE OR REPLACE FUNCTION card_visible_to(actor_id bigint, card_id bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT NOT card_in_off_area(card_visible_to.card_id) AND EXISTS (
        SELECT 1
        FROM user_account caller
        JOIN user_role ur
          ON ur.user_id = caller.id
          OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
        WHERE caller.id = card_visible_to.actor_id
          AND (ur.scope_card_id IS NULL
               OR ur.scope_card_id = card_enclosing_project(card_visible_to.card_id))
    )
$$;

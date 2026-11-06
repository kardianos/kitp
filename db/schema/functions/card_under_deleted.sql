-- card_under_deleted — true when a card ABOVE this one is soft-deleted: a
-- parent, a grandparent and so on up the chain (a thread on a deleted task,
-- a task in a deleted project), or, for a message (reply_body), its thread
-- or a card above that. The card's own deleted_at isn't counted: callers
-- check that themselves (an export may include deleted tasks).
--
-- card.delete marks one card; what sits under it stays as it was, so
-- card.undelete brings it all back. Reads that list or match live cards AND
-- NOT this next to `deleted_at IS NULL`, so what is under a deleted card goes
-- with it: card.select / .select_with_attributes / .search, mail threading
-- (a reply to a deleted task's thread starts a new one), calendar feeds and
-- watch-list items.
--
-- PL/pgSQL, so its plans are cached per session. The walk is capped at
-- depth 16 (CLAUDE.md).
CREATE OR REPLACE FUNCTION card_under_deleted(card_id bigint)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
    _start bigint;
BEGIN
    SELECT c.parent_card_id INTO _start FROM card c WHERE c.id = card_under_deleted.card_id;
    IF _start IS NULL THEN
        -- No parent: only a message chains on, from its thread.
        IF NOT EXISTS (SELECT 1 FROM card r JOIN card_type rt ON rt.id = r.card_type_id
                       WHERE r.id = card_under_deleted.card_id AND rt.name = 'reply_body') THEN
            RETURN false;
        END IF;
        SELECT rv.card_id INTO _start
        FROM attribute_value rv
        JOIN attribute_def rd ON rd.id = rv.attribute_def_id AND rd.name = 'replies'
        WHERE jsonb_typeof(rv.value) = 'array' AND rv.value @> to_jsonb(card_under_deleted.card_id)
        ORDER BY rv.card_id
        LIMIT 1;
        IF _start IS NULL THEN
            RETURN false; -- not on a thread
        END IF;
    END IF;
    RETURN EXISTS (
        WITH RECURSIVE up(id, parent_card_id, deleted_at, depth) AS (
            SELECT c.id, c.parent_card_id, c.deleted_at, 1
            FROM card c WHERE c.id = _start
            UNION ALL
            SELECT p.id, p.parent_card_id, p.deleted_at, up.depth + 1
            FROM card p JOIN up ON p.id = up.parent_card_id
            WHERE up.depth < 16
        )
        SELECT 1 FROM up WHERE up.deleted_at IS NOT NULL
    );
END
$$;

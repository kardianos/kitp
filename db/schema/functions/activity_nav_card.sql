-- activity_nav_card — the card an activity row on `start` belongs to in
-- the UI: the nearest 'task' ancestor-or-self (so a comm's or link's
-- activity lands on its task); for a reply_body, which is global (no
-- structural parent), the task of the comm whose replies[] lists it;
-- otherwise the card itself.
CREATE OR REPLACE FUNCTION activity_nav_card(start bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (
            SELECT up.id
            FROM card_ancestors(start) up
            JOIN card_type ct ON ct.id = up.card_type_id
            WHERE ct.name = 'task'
            ORDER BY up.depth
            LIMIT 1
        ),
        (
            SELECT cm.parent_card_id
            FROM attribute_value rep
            JOIN attribute_def adr ON adr.id = rep.attribute_def_id AND adr.name = 'replies'
            JOIN card cm ON cm.id = rep.card_id
            WHERE rep.value @> to_jsonb(start)
            LIMIT 1
        ),
        start
    )
$$;

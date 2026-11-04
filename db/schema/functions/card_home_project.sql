-- card_home_project — the project a card belongs to: its enclosing project,
-- or for a message (reply_body, which has no parent card) its thread's —
-- the thread whose replies lists it, as card_visible_to walks it. NULL for
-- a global card, or a message on no thread. card.merge compares losers and
-- survivor by it: by card_enclosing_project every message was in "no
-- project", so an admin could merge messages of two projects' threads
-- (review 2026-11-03 round 4).
CREATE OR REPLACE FUNCTION card_home_project(card bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN EXISTS (SELECT 1 FROM card r JOIN card_type rt ON rt.id = r.card_type_id
                     WHERE r.id = card_home_project.card AND rt.name = 'reply_body')
        THEN card_enclosing_project((
                SELECT rv.card_id
                FROM attribute_value rv
                JOIN attribute_def rd ON rd.id = rv.attribute_def_id AND rd.name = 'replies'
                WHERE jsonb_typeof(rv.value) = 'array' AND rv.value @> to_jsonb(card_home_project.card)
                ORDER BY rv.card_id
                LIMIT 1))
        ELSE card_enclosing_project(card_home_project.card)
    END
$$;

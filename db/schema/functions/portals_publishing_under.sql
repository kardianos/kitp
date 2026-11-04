-- portals_publishing_under — the portals with a publication of a page at
-- or under a card (a page or a project). Pages hang under pages and
-- projects only, so the walk goes down through pages alone, capped at depth
-- 16 like every tree walk; any other card has none under it. card.move,
-- card.delete and card.undelete mark these portals for a rebuild. They used
-- to walk up from every publication in the workspace, at a cost that grew
-- with all of them (222 ms with 20,000; review 2026-11-03 round 4).
CREATE OR REPLACE FUNCTION portals_publishing_under(root bigint)
RETURNS TABLE (portal_id bigint) LANGUAGE sql STABLE AS $$
    WITH RECURSIVE sub(id, depth) AS (
        SELECT c.id, 0
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name IN ('page', 'project')
        WHERE c.id = portals_publishing_under.root
        UNION ALL
        SELECT c.id, sub.depth + 1
        FROM card c
        JOIN sub ON c.parent_card_id = sub.id
        WHERE sub.depth < 16
          AND c.card_type_id = (SELECT id FROM card_type WHERE name = 'page')
    )
    SELECT DISTINCT p.portal_id
    FROM publication p
    JOIN sub ON sub.id = p.card_id
$$;

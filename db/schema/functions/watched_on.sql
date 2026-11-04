-- watched_on — whether a card is on one of the viewer's own watch lists
-- named by `_ids`, where an id may also be the viewer's person card meaning
-- "any of my lists" (what the filter's "@me" becomes). Only lists private to
-- `_viewer` (a person card; card.private_to) count: another person's list
-- id, or their person id, names nothing — lists are each account's own and
-- private (review 2026-11-03 #8). NULL viewer → false. Backs the watch_list
-- filter leaf (card_compile_predicate, where.go compileWatchLeaf); an index
-- on watch_entry.card_id keeps it to the card's own few entries.
-- docs/WATCH_LISTS.md.
CREATE OR REPLACE FUNCTION watched_on(_card bigint, _ids bigint[], _viewer bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM watch_entry we
        JOIN card l ON l.id = we.watch_list_id AND l.deleted_at IS NULL
        WHERE we.card_id = _card
          AND l.private_to = _viewer
          AND (we.watch_list_id = ANY(_ids) OR _viewer = ANY(_ids)))
$$;

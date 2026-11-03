-- watched_on — whether a card is on any of the given watch lists, where an
-- id may also be a person card meaning "any of that person's lists" (what
-- the filter's "@me" becomes for the viewer). Backs the watch_list filter
-- leaf (card_compile_predicate, where.go compileWatchLeaf). An index on
-- watch_entry.card_id keeps it to the card's own few entries.
-- docs/WATCH_LISTS.md.
CREATE OR REPLACE FUNCTION watched_on(_card bigint, _ids bigint[])
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM watch_entry we
        JOIN card l ON l.id = we.watch_list_id AND l.deleted_at IS NULL
        WHERE we.card_id = _card
          AND (we.watch_list_id = ANY(_ids)
               OR EXISTS (SELECT 1
                          FROM attribute_value av
                          JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'subscriber'
                          WHERE av.card_id = l.id AND jsonb_typeof(av.value) = 'number'
                            AND (av.value)::text::bigint = ANY(_ids))))
$$;

-- watch_marks — the viewer's own watch lists a card is on, as the Grid, list
-- rows and Kanban cards mark it beside its title: [{id, symbol, title}] in
-- list order (by id, as watch_list.list lists them), or NULL when it is on
-- none. Only lists private to `_viewer` (the caller's account_person) count,
-- as in watched_on; NULL viewer → NULL. card.select_with_attributes adds it
-- per row on with_watch; the watch_entry card_id index keeps it to the
-- card's own few entries. docs/WATCH_LISTS.md.
CREATE OR REPLACE FUNCTION watch_marks(_card bigint, _viewer bigint)
RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT jsonb_agg(jsonb_build_object(
               'id', l.id::text,
               'symbol', COALESCE(NULLIF(sym.value #>> '{}', ''), '★'),
               'title', COALESCE(ttl.value #>> '{}', ''))
           ORDER BY l.id)
    FROM watch_entry we
    JOIN card l ON l.id = we.watch_list_id AND l.deleted_at IS NULL AND l.private_to = _viewer
    LEFT JOIN attribute_value sym ON sym.card_id = l.id
         AND sym.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'symbol')
    LEFT JOIN attribute_value ttl ON ttl.card_id = l.id
         AND ttl.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'title')
    WHERE we.card_id = _card AND _viewer IS NOT NULL
$$;

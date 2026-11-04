-- my_screen.list — the caller's personal screens (docs/PERSONAL_SCREENS.md):
-- `screen` cards with no parent, private to the caller's person, in their
-- Mine order (sort_order, then oldest first): id, title, layout,
-- list_card_type, predicate (the base filter JSON; '' = everything you can
-- see), sort_order, default_filter (a view of the screen, '0' = none) and how
-- many views it has.
CREATE OR REPLACE FUNCTION my_screen_list_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _person bigint := account_person(my_screen_list_batch.actor_id);
    _screen_ct bigint := (SELECT id FROM card_type WHERE name = 'screen');
    _filter_ct bigint := (SELECT id FROM card_type WHERE name = 'filter');
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('screens', COALESCE((
            SELECT jsonb_agg(row_obj ORDER BY so, sid)
            FROM (
                SELECT c.id AS sid,
                       COALESCE((SELECT (v.value)::text::numeric FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                 WHERE v.card_id = c.id AND d.name = 'sort_order' AND jsonb_typeof(v.value) = 'number'), 0) AS so,
                       jsonb_build_object(
                           'id', c.id::text,
                           'title', COALESCE((SELECT v.value #>> '{}' FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                              WHERE v.card_id = c.id AND d.name = 'title'), ''),
                           'layout', COALESCE((SELECT v.value #>> '{}' FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                               WHERE v.card_id = c.id AND d.name = 'layout'), 'list'),
                           'list_card_type', COALESCE((SELECT v.value #>> '{}' FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                                       WHERE v.card_id = c.id AND d.name = 'list_card_type'), 'task'),
                           'predicate', COALESCE((SELECT v.value #>> '{}' FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                                  WHERE v.card_id = c.id AND d.name = 'predicate' AND jsonb_typeof(v.value) = 'string'), ''),
                           'sort_order', COALESCE((SELECT (v.value)::text::numeric FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                                   WHERE v.card_id = c.id AND d.name = 'sort_order' AND jsonb_typeof(v.value) = 'number'), 0),
                           'default_filter', COALESCE((SELECT (v.value)::text FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                                       WHERE v.card_id = c.id AND d.name = 'default_filter' AND jsonb_typeof(v.value) = 'number'), '0'),
                           'view_count', (SELECT count(*) FROM card f
                                          WHERE f.parent_card_id = c.id AND f.card_type_id = _filter_ct AND f.deleted_at IS NULL)
                       ) AS row_obj
                FROM card c
                WHERE _person IS NOT NULL
                  AND c.card_type_id = _screen_ct AND c.parent_card_id IS NULL
                  AND c.private_to = _person AND c.deleted_at IS NULL
            ) s
        ), '[]'::jsonb));
    END LOOP;
END;
$$;

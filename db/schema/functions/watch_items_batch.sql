-- watch.items — what is on one of the caller's watch lists
-- (docs/WATCH_LISTS.md), in the list's order (sort_order, then newest
-- first): each task or thread with its title, its project, its status (label
-- and phase: task status, or a thread's comm_status), the task a thread sits
-- on (0 for a thread on its own — where it opens), sort_order and when it
-- was added. Only cards the caller can still see, outside switched-off
-- areas (DI-6); an entry on a card they can't see is skipped, not removed.
CREATE OR REPLACE FUNCTION watch_items_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _list bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'watch_list_id', '') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'watch.items: watch_list_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _list := (_raw->>'watch_list_id')::bigint;
        IF NOT watch_list_owned_by(_list, watch_items_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('watch.items: watch list %s not found', _list), NULL::jsonb;
            CONTINUE;
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('items', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'card_id', c.id::text,
                'card_type', ct.name,
                'title', COALESCE(card_label(c.id), ''),
                'task_id', COALESCE(CASE WHEN ct.name = 'comm' AND pct.name = 'task' THEN c.parent_card_id END, 0)::text,
                'project_id', COALESCE(pr.id, 0)::text,
                'project_title', COALESCE(card_label(pr.id), ''),
                'status', COALESCE(card_label(st.status_id), ''),
                'phase', COALESCE(sc.phase, ''),
                'sort_order', we.sort_order,
                'added_at', to_char(we.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                ORDER BY we.sort_order, we.created_at DESC, c.id)
            FROM watch_entry we
            JOIN card c ON c.id = we.card_id AND c.deleted_at IS NULL AND NOT card_under_deleted(c.id)
            JOIN card_type ct ON ct.id = c.card_type_id
            LEFT JOIN card p ON p.id = c.parent_card_id
            LEFT JOIN card_type pct ON pct.id = p.card_type_id
            LEFT JOIN LATERAL (SELECT card_enclosing_project(c.id) AS id) pr ON true
            LEFT JOIN LATERAL (
                SELECT (av.value)::text::bigint AS status_id
                FROM attribute_value av
                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                WHERE av.card_id = c.id
                  AND ad.name = CASE WHEN ct.name = 'comm' THEN 'comm_status' ELSE 'status' END
                  AND jsonb_typeof(av.value) = 'number'
            ) st ON true
            LEFT JOIN card sc ON sc.id = st.status_id
            WHERE we.watch_list_id = _list
              AND card_visible_to(watch_items_batch.actor_id, c.id)
              AND NOT card_in_off_area(c.id)
        ), '[]'::jsonb));
    END LOOP;
END;
$$;

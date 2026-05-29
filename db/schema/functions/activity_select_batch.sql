-- activity.select handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runSelect into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Decode card_id (optional — omit/0 for cross-card mode),
--      limit (default 200, capped at 999), before_activity_id
--      (exclusive cursor).
--   2. SELECT activity rows for that card (or all cards in cross-card
--      mode), joined with attribute_def (for kind=attr_update names)
--      and comment_body (for kind=comment bodies). Per-row visibility
--      filter (B7) gates every row including cross-card mode — that's
--      where the original bug was.
--   3. Sort: card mode = ascending by id (chronological); cross-card
--      mode = descending by id (newest first).
--
-- Result JSON shape matches `activity.SelectOutput`.
CREATE OR REPLACE FUNCTION activity_select_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (
    idx int,
    ok boolean,
    code text,
    message text,
    result jsonb
) LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _card_id bigint;
    _project_id bigint;
    _before_id bigint;
    _from_date date;
    _to_date date;
    _limit int;
    _sort_asc boolean;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _card_id := NULLIF(_raw->>'card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _card_id := NULL;
        END;
        BEGIN
            _before_id := NULLIF(_raw->>'before_activity_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _before_id := NULL;
        END;
        -- Optional project scope: when set, only activity for cards within that
        -- project (the project itself or a descendant) is returned — the
        -- standalone Activity page is per-project. 0/empty means unscoped.
        BEGIN
            _project_id := NULLIF(_raw->>'project_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _project_id := NULL;
        END;
        IF _project_id = 0 THEN
            _project_id := NULL;
        END IF;
        -- Optional [from_date, to_date] window on created_at (the standalone
        -- Activity page defaults to the last 7 days). Both inclusive by day:
        -- from_date >= midnight of from_date; to_date < midnight after to_date.
        -- A malformed date is treated as "unset" rather than failing the batch.
        BEGIN
            _from_date := NULLIF(_raw->>'from_date', '')::date;
        EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation THEN
            _from_date := NULL;
        END;
        BEGIN
            _to_date := NULLIF(_raw->>'to_date', '')::date;
        EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation THEN
            _to_date := NULL;
        END;
        _limit := COALESCE(NULLIF(_raw->>'limit', '')::int, 200);
        IF _limit <= 0 OR _limit >= 1000 THEN
            _limit := 200;
        END IF;

        IF _card_id IS NULL OR _card_id = 0 THEN
            _card_id := NULL;
            _sort_asc := false;
        ELSE
            _sort_asc := true;
        END IF;

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(row_obj ORDER BY ord)
                FROM (
                    SELECT
                        ROW_NUMBER() OVER (ORDER BY
                            CASE WHEN _sort_asc THEN a.id END ASC,
                            CASE WHEN NOT _sort_asc THEN a.id END DESC
                        ) AS ord,
                        jsonb_build_object(
                            'id',             a.id::text,
                            'card_id',        a.card_id::text,
                            -- The card the UI should OPEN for this row: the
                            -- nearest 'task' ancestor (so comm / reply activity
                            -- lands on the owning task, not the comm card which
                            -- has no task route). reply_body cards are global
                            -- (no structural parent) so they resolve via the
                            -- replies[] → comm → task chain; everything else
                            -- falls back to the card itself.
                            'nav_card_id',    nav.nav_card_id::text,
                            'nav_title',      nav.nav_title,
                            'kind',           a.kind,
                            'attribute_name', ad.name,
                            'value_old',      a.value_old,
                            'value_new',      a.value_new,
                            'comment_body',   cb.body,
                            'actor_id',       a.actor_id::text,
                            'created_at',     to_char(a.created_at AT TIME ZONE 'UTC',
                                                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                        ) AS row_obj
                    FROM activity a
                    LEFT JOIN attribute_def ad ON ad.id = a.attribute_def_id
                    LEFT JOIN comment_body cb ON cb.id = (a.value_new->>'comment_body_id')::bigint
                    LEFT JOIN LATERAL (
                        -- Resolve the navigable card (nearest task ancestor /
                        -- reply_body's comm's task / self) AND its title, so the
                        -- Activity feed can both link to and headline the owning
                        -- "thing" without a second round trip.
                        SELECT x.nav_card_id,
                               (
                                   SELECT av.value #>> '{}'
                                   FROM attribute_value av
                                   JOIN attribute_def adt ON adt.id = av.attribute_def_id
                                   WHERE av.card_id = x.nav_card_id AND adt.name = 'title'
                               ) AS nav_title
                        FROM (
                            SELECT COALESCE(
                                -- nearest 'task' ancestor (self or up the parent chain)
                                (
                                    WITH RECURSIVE up(id, parent_card_id, card_type_id, depth) AS (
                                        SELECT c.id, c.parent_card_id, c.card_type_id, 0
                                        FROM card c WHERE c.id = a.card_id
                                        UNION ALL
                                        SELECT p.id, p.parent_card_id, p.card_type_id, up.depth + 1
                                        FROM card p JOIN up ON p.id = up.parent_card_id
                                        WHERE up.depth < 16
                                    )
                                    SELECT up.id
                                    FROM up JOIN card_type ct ON ct.id = up.card_type_id
                                    WHERE ct.name = 'task'
                                    ORDER BY up.depth
                                    LIMIT 1
                                ),
                                -- reply_body: global card referenced by a comm's replies[]
                                (
                                    SELECT cm.parent_card_id
                                    FROM attribute_value rep
                                    JOIN attribute_def adr ON adr.id = rep.attribute_def_id AND adr.name = 'replies'
                                    JOIN card cm ON cm.id = rep.card_id
                                    WHERE rep.value @> to_jsonb(a.card_id)
                                    LIMIT 1
                                ),
                                a.card_id
                            ) AS nav_card_id
                        ) x
                    ) nav ON true
                    WHERE (_card_id IS NULL OR a.card_id = _card_id)
                      AND (_before_id IS NULL OR a.id < _before_id)
                      -- Date window (inclusive by day) on created_at.
                      AND (_from_date IS NULL OR a.created_at >= _from_date)
                      AND (_to_date IS NULL OR a.created_at < (_to_date + 1))
                      -- Project scope: the card is the project or a descendant
                      -- (walk parents up to the depth-16 cap, same as B7).
                      AND (_project_id IS NULL OR EXISTS (
                        WITH RECURSIVE pj(id, parent_card_id, depth) AS (
                            SELECT card.id, card.parent_card_id, 0
                            FROM card WHERE card.id = a.card_id
                            UNION ALL
                            SELECT p.id, p.parent_card_id, pj.depth + 1
                            FROM card p JOIN pj ON p.id = pj.parent_card_id
                            WHERE pj.depth < 16
                        )
                        SELECT 1 FROM pj WHERE pj.id = _project_id
                      ))
                      AND EXISTS (
                        -- depth < 16 caps the parent walk (CLAUDE.md cap;
                        -- matches card_ancestors / scopeWalkDepth) so a
                        -- parent_card_id cycle can't pin the connection (A1).
                        WITH RECURSIVE up(id, parent_card_id, card_type_id, depth) AS (
                            SELECT card.id, card.parent_card_id, card.card_type_id, 0
                            FROM card WHERE card.id = a.card_id
                            UNION ALL
                            SELECT p.id, p.parent_card_id, p.card_type_id, up.depth + 1
                            FROM card p JOIN up ON p.id = up.parent_card_id
                            WHERE up.depth < 16
                        )
                        SELECT 1
                        FROM user_account caller
                        JOIN user_role ur
                          ON ur.user_id = caller.id
                          OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
                        WHERE caller.id = activity_select_batch.actor_id
                          AND (
                            ur.scope_card_id IS NULL
                            OR ur.scope_card_id IN (
                                SELECT up.id
                                FROM up JOIN card_type ct2 ON ct2.id = up.card_type_id
                                WHERE ct2.name = 'project'
                            )
                          )
                      )
                    ORDER BY
                        CASE WHEN _sort_asc THEN a.id END ASC,
                        CASE WHEN NOT _sort_asc THEN a.id END DESC
                    LIMIT _limit
                ) sub
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

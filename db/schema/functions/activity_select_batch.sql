-- activity.select handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runSelect into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Decode card_id (optional — omit/0 for cross-card mode),
--      project_id, from_date / to_date, limit (default 200, capped at
--      999), before_activity_id (exclusive cursor), and the feed filters
--      actor_ids[] / exclude_actor_ids[] / kinds[] / card_types[] / q.
--   2. `scoped` = the activity rows in the card / project / date window
--      that the caller may see (per-row visibility filter B7 — gates
--      every row including cross-card mode, which is where the original
--      bug was).
--   3. rows = `scoped` narrowed by the feed filters and the cursor,
--      enriched so a client can render them without further lookups:
--      the actor's label (agents name their owner, see user_label), the
--      card's type + title, the card the UI opens for the row (nav_card,
--      see activity_nav_card) with its type + title, the attribute's
--      value_type, and `refs` — id → title for every card a card_ref
--      value (or a move target) names.
--   4. facets (only when `facets` is true): counts per actor / kind /
--      card type over `scoped`, ignoring the feed filters and cursor, so
--      a filter UI can offer every option the window holds.
--   5. Sort: card mode = ascending by id (chronological); cross-card
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
    _actor_ids bigint[];
    _exclude_actor_ids bigint[];
    _kinds text[];
    _card_types text[];
    _q text;
    _facets boolean;
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
        -- Feed filters. Empty / absent = no filter on that axis; a malformed
        -- actor id fails the row rather than silently widening the feed.
        BEGIN
            _actor_ids := ARRAY(
                SELECT e::bigint
                FROM jsonb_array_elements_text(
                    CASE jsonb_typeof(_raw->'actor_ids') WHEN 'array' THEN _raw->'actor_ids' ELSE '[]'::jsonb END
                ) AS e
            );
            _exclude_actor_ids := ARRAY(
                SELECT e::bigint
                FROM jsonb_array_elements_text(
                    CASE jsonb_typeof(_raw->'exclude_actor_ids') WHEN 'array' THEN _raw->'exclude_actor_ids' ELSE '[]'::jsonb END
                ) AS e
            );
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity.select: actor_ids and exclude_actor_ids must be user ids'::text, NULL::jsonb;
            CONTINUE;
        END;
        _kinds := ARRAY(
            SELECT e FROM jsonb_array_elements_text(
                CASE jsonb_typeof(_raw->'kinds') WHEN 'array' THEN _raw->'kinds' ELSE '[]'::jsonb END
            ) AS e
        );
        _card_types := ARRAY(
            SELECT e FROM jsonb_array_elements_text(
                CASE jsonb_typeof(_raw->'card_types') WHEN 'array' THEN _raw->'card_types' ELSE '[]'::jsonb END
            ) AS e
        );
        _q := NULLIF(btrim(COALESCE(_raw->>'q', '')), '');
        _facets := COALESCE(_raw->'facets' = 'true'::jsonb, false);

        IF _card_id IS NULL OR _card_id = 0 THEN
            _card_id := NULL;
            _sort_asc := false;
        ELSE
            _sort_asc := true;
        END IF;

        RETURN QUERY
        WITH scoped AS MATERIALIZED (
            SELECT a.*, ct.name AS card_type
            FROM activity a
            JOIN card c ON c.id = a.card_id
            JOIN card_type ct ON ct.id = c.card_type_id
            WHERE (_card_id IS NULL OR a.card_id = _card_id)
              -- Date window (inclusive by day) on created_at.
              AND (_from_date IS NULL OR a.created_at >= _from_date)
              AND (_to_date IS NULL OR a.created_at < (_to_date + 1))
              -- Project scope: the card is the project or a descendant
              -- (walk parents up to the depth-16 cap, same as B7).
              AND (_project_id IS NULL OR EXISTS (
                SELECT 1 FROM card_ancestors(a.card_id) pj WHERE pj.id = _project_id
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
        ),
        picked AS (
            SELECT s.*
            FROM scoped s
            WHERE (cardinality(_actor_ids) = 0 OR s.actor_id = ANY(_actor_ids))
              AND NOT (s.actor_id = ANY(_exclude_actor_ids))
              AND (cardinality(_kinds) = 0 OR s.kind = ANY(_kinds))
              AND (cardinality(_card_types) = 0 OR s.card_type = ANY(_card_types))
              AND (_before_id IS NULL OR s.id < _before_id)
              -- Text search: the card the row opens (title or "#id"), the
              -- card the row is on, or a comment's body.
              AND (_q IS NULL
                   OR card_label(activity_nav_card(s.card_id)) ILIKE '%' || _q || '%'
                   OR card_label(s.card_id) ILIKE '%' || _q || '%'
                   OR ltrim(_q, '#') = activity_nav_card(s.card_id)::text
                   OR EXISTS (
                       SELECT 1 FROM comment_body cbq
                       WHERE cbq.id = (s.value_new->>'comment_body_id')::bigint
                         AND cbq.body ILIKE '%' || _q || '%'
                   ))
            ORDER BY
                CASE WHEN _sort_asc THEN s.id END ASC,
                CASE WHEN NOT _sort_asc THEN s.id END DESC
            LIMIT _limit
        )
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'rows', COALESCE((
                    SELECT jsonb_agg(row_obj ORDER BY ord)
                    FROM (
                        SELECT
                            ROW_NUMBER() OVER (ORDER BY
                                CASE WHEN _sort_asc THEN p.id END ASC,
                                CASE WHEN NOT _sort_asc THEN p.id END DESC
                            ) AS ord,
                            jsonb_build_object(
                                'id',             p.id::text,
                                'card_id',        p.card_id::text,
                                'card_type',      p.card_type,
                                'card_title',     card_label(p.card_id),
                                -- The card the UI should OPEN for this row
                                -- (comm / link / reply activity lands on the
                                -- owning task, not a card with no task route).
                                'nav_card_id',    nv.nav_card_id::text,
                                'nav_card_type',  nct.name,
                                'nav_title',      card_label(nv.nav_card_id),
                                'kind',           p.kind,
                                'attribute_name', ad.name,
                                'value_type',     ad.value_type,
                                'value_old',      p.value_old,
                                'value_new',      p.value_new,
                                'refs',           refs.m,
                                'comment_body',   cb.body,
                                'actor_id',       p.actor_id::text,
                                'actor_name',     user_label(p.actor_id),
                                'created_at',     to_char(p.created_at AT TIME ZONE 'UTC',
                                                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                            ) AS row_obj
                        FROM picked p
                        CROSS JOIN LATERAL (SELECT activity_nav_card(p.card_id) AS nav_card_id) nv
                        JOIN card nc ON nc.id = nv.nav_card_id
                        JOIN card_type nct ON nct.id = nc.card_type_id
                        LEFT JOIN attribute_def ad ON ad.id = p.attribute_def_id
                        LEFT JOIN comment_body cb ON cb.id = (p.value_new->>'comment_body_id')::bigint
                        LEFT JOIN LATERAL (
                            -- Titles for the cards the row's values name: a
                            -- card_ref / card_ref[] value (old and new), a
                            -- card_move's new parent, a task_move's projects.
                            -- They're values of a card the caller can see,
                            -- labelled the way the card's own attributes are.
                            SELECT jsonb_object_agg(r.id::text, card_label(r.id)) AS m
                            FROM (
                                SELECT DISTINCT x::bigint AS id
                                FROM (
                                    SELECT jsonb_array_elements_text(
                                        CASE jsonb_typeof(v) WHEN 'array' THEN v ELSE jsonb_build_array(v) END
                                    ) AS x
                                    FROM unnest(ARRAY[p.value_old, p.value_new]) AS v
                                    WHERE ad.value_type IN ('card_ref', 'card_ref[]')
                                      AND v IS NOT NULL
                                      AND jsonb_typeof(v) IN ('array', 'number', 'string')
                                    UNION ALL
                                    SELECT p.value_new #>> '{}'
                                    WHERE p.kind = 'card_move'
                                      AND jsonb_typeof(p.value_new) IN ('number', 'string')
                                    UNION ALL
                                    SELECT p.value_new ->> k
                                    FROM unnest(ARRAY['old_project_id', 'new_project_id']) AS k
                                    WHERE p.kind = 'task_move'
                                      AND jsonb_typeof(p.value_new) = 'object'
                                ) t
                                WHERE x ~ '^[0-9]{1,18}$'
                            ) r
                            JOIN card rc ON rc.id = r.id
                        ) refs ON true
                    ) sub
                ), '[]'::jsonb),
                'facets', CASE WHEN _facets THEN jsonb_build_object(
                    'total', (SELECT count(*) FROM scoped),
                    'actors', COALESCE((
                        SELECT jsonb_agg(jsonb_build_object(
                                   'id', f.actor_id::text,
                                   'name', user_label(f.actor_id),
                                   'count', f.n
                               ) ORDER BY f.n DESC, f.actor_id)
                        FROM (SELECT s.actor_id, count(*) AS n FROM scoped s GROUP BY s.actor_id) f
                    ), '[]'::jsonb),
                    'kinds', COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('kind', f.kind, 'count', f.n)
                                         ORDER BY f.n DESC, f.kind)
                        FROM (SELECT s.kind, count(*) AS n FROM scoped s GROUP BY s.kind) f
                    ), '[]'::jsonb),
                    'card_types', COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('card_type', f.card_type, 'count', f.n)
                                         ORDER BY f.n DESC, f.card_type)
                        FROM (SELECT s.card_type, count(*) AS n FROM scoped s GROUP BY s.card_type) f
                    ), '[]'::jsonb)
                ) END
            );
    END LOOP;
END;
$$;

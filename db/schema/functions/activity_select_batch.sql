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
    _thread_comments boolean;
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
    _global boolean;
    _scopes bigint[];
    _seen boolean;
    _any_off boolean := EXISTS (SELECT 1 FROM project_area WHERE state = 'off')
                        OR EXISTS (SELECT 1 FROM workspace_area WHERE state = 'off');
BEGIN
    -- The caller's roles, once: a workspace-wide one, and the cards the
    -- others are scoped to (user_role_visible: an agent sees as its owner).
    SELECT COALESCE(bool_or(ur.scope_card_id IS NULL), false),
           COALESCE(array_agg(DISTINCT ur.scope_card_id) FILTER (WHERE ur.scope_card_id IS NOT NULL), '{}')
      INTO _global, _scopes
    FROM user_role_visible(activity_select_batch.actor_id) ur;

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
        -- standalone Activity page is per-project. 0/empty means unscoped
        -- (then bounded by date; see below).
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
        -- A malformed date fails the row (dates are YYYY-MM-DD, checked by
        -- iso_date_ok; docs/MAIL_INTAKE_AND_CALENDARS.md §1).
        IF COALESCE(_raw->>'from_date', '') <> '' AND NOT iso_date_ok(_raw->>'from_date') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('activity.select: from_date: not a date (YYYY-MM-DD): %s', _raw->>'from_date'),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF COALESCE(_raw->>'to_date', '') <> '' AND NOT iso_date_ok(_raw->>'to_date') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('activity.select: to_date: not a date (YYYY-MM-DD): %s', _raw->>'to_date'),
                NULL::jsonb;
            CONTINUE;
        END IF;
        _from_date := NULLIF(_raw->>'from_date', '')::date;
        _to_date := NULLIF(_raw->>'to_date', '')::date;
        -- With neither a card nor a project, the read is bounded by date:
        -- the last 30 days unless from_date says otherwise, at most 92
        -- days (idx_activity_created_at). Unbounded, it walked every row
        -- in the workspace (review 2026-11-03 round 4).
        IF COALESCE(_card_id, 0) = 0 AND _project_id IS NULL THEN
            _from_date := COALESCE(_from_date, current_date - 30);
            IF COALESCE(_to_date, current_date) - _from_date > 92 THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'activity.select: without card_id or project_id, from_date to to_date (or today) is at most 92 days'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;
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
        -- with_thread_comments (with card_id): also the comments made on
        -- the card's own email threads, so a thread's comments stay in
        -- view once it is attached to a task (review A13).
        _thread_comments := COALESCE((_raw->>'with_thread_comments')::boolean, false);
        _facets := COALESCE(_raw->'facets' = 'true'::jsonb, false);

        IF _card_id IS NULL OR _card_id = 0 THEN
            _card_id := NULL;
            _sort_asc := false;
        ELSE
            _sort_asc := true;
        END IF;

        -- Visibility (DI-6) once per request, not per row: projects don't
        -- nest, so a card is seen with a workspace-wide role or one scoped
        -- to its project. For one card or one project that is a single
        -- answer; without either, the rows come from the projects the
        -- caller has roles in (or, workspace-wide, from the date window).
        -- Each activity row walked its card's ancestors and the caller's
        -- roles, and a project's activity was found by walking every row
        -- in the workspace up to the project (review 2026-11-03 round 5).
        IF _card_id IS NOT NULL OR _project_id IS NOT NULL THEN
            _seen := _global OR COALESCE(card_enclosing_project(COALESCE(_card_id, _project_id)) = ANY (_scopes), false);
            IF _card_id IS NOT NULL AND _project_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM card_ancestors(_card_id) pa WHERE pa.id = _project_id) THEN
                _seen := false;
            END IF;
        ELSE
            _seen := true;
        END IF;

        RETURN QUERY
        WITH RECURSIVE
        -- One project's cards (the project and below, depth-16 cap).
        proj_sub(id, depth) AS (
            SELECT _project_id, 0 WHERE _card_id IS NULL AND _project_id IS NOT NULL
            UNION ALL
            SELECT c.id, s.depth + 1 FROM card c JOIN proj_sub s ON c.parent_card_id = s.id
            WHERE s.depth < 16
        ),
        -- Unscoped, for a caller with project roles only: those projects'
        -- cards.
        seen_sub(id, depth) AS (
            SELECT p.id, 0 FROM card p JOIN card_type pt ON pt.id = p.card_type_id AND pt.name = 'project'
            WHERE _card_id IS NULL AND _project_id IS NULL AND NOT _global AND p.id = ANY (_scopes)
            UNION ALL
            SELECT c.id, s.depth + 1 FROM card c JOIN seen_sub s ON c.parent_card_id = s.id
            WHERE s.depth < 16
        ),
        -- The candidate rows, one branch per kind of request (the others
        -- are skipped): each reaches activity by an index — card_id (and
        -- created_at), or created_at alone.
        src AS (
            SELECT a.* FROM activity a
            WHERE _card_id IS NOT NULL
              AND (a.card_id = _card_id
                   OR (_thread_comments AND a.kind IN ('comment', 'comment_edit') AND a.card_id IN (
                         SELECT th.id FROM card th
                         JOIN card_type tht ON tht.id = th.card_type_id AND tht.name = 'comm'
                         WHERE th.parent_card_id = _card_id AND th.deleted_at IS NULL)))
            UNION ALL
            SELECT a.* FROM proj_sub s JOIN activity a ON a.card_id = s.id
            UNION ALL
            SELECT a.* FROM activity a
            WHERE _card_id IS NULL AND _project_id IS NULL AND _global AND a.created_at >= _from_date
            UNION ALL
            SELECT a.* FROM seen_sub s JOIN activity a ON a.card_id = s.id
        ),
        scoped AS MATERIALIZED (
            SELECT a.*, ct.name AS card_type
            FROM src a
            JOIN card c ON c.id = a.card_id
            JOIN card_type ct ON ct.id = c.card_type_id
            WHERE _seen
              -- Date window (inclusive by day) on created_at.
              AND (_from_date IS NULL OR a.created_at >= _from_date)
              AND (_to_date IS NULL OR a.created_at < (_to_date + 1))
              -- Activity on someone else's private card (a personal view,
              -- a watch list; docs/PERSONAL_SCREENS.md) is theirs alone.
              -- (asked only of a private card: a shared one passes)
              AND (c.private_to IS NULL OR card_private_ok(a.card_id, activity_select_batch.actor_id))
              -- Hidden by a switched-off area: asked per row only when an
              -- area is off somewhere (it answers false otherwise, at a
              -- function call a row).
              AND (NOT _any_off OR NOT activity_hidden(a.kind, a.card_id, a.value_new))
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
                       WHERE cbq.id = activity_comment_body_id(s.kind, s.value_new)
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
                        LEFT JOIN comment_body cb ON cb.id = activity_comment_body_id(p.kind, p.value_new)
                        LEFT JOIN LATERAL (
                            -- Titles for the cards the row's values name: a
                            -- card_ref / card_ref[] value (old and new), a
                            -- card_move's new parent, a task_move's projects,
                            -- an approval vote's edge (from / to statuses).
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
                                    UNION ALL
                                    SELECT p.value_new ->> k
                                    FROM unnest(ARRAY['from_id', 'to_id']) AS k
                                    WHERE p.kind = 'approval_decision'
                                      AND jsonb_typeof(p.value_new) = 'object'
                                ) t
                                WHERE x ~ '^[0-9]{1,18}$'
                            ) r
                            -- Only cards the viewer can see: after task.move
                            -- a row's old values name the source project's
                            -- statuses and milestones (review 2026-11-03 #30).
                            JOIN card rc ON rc.id = r.id
                                        AND card_visible_to(activity_select_batch.actor_id, rc.id)
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

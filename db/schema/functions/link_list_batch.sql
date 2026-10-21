-- link.list handler — the live links on one task, oldest first, for the
-- task-detail LINKS section and for agents (MCP).
--
-- Visibility (DI-6): gated ONCE on the task — every link is a direct
-- child of it, so they share its project and the task's visibility
-- implies theirs. A task the caller can't see (or that doesn't exist)
-- lists as empty rather than erroring, so existence doesn't leak.
--
-- updated_at is the newest activity row on the link card (its creation
-- or the last attribute change, e.g. a forge flipping the state), so
-- the UI can show when a code change last moved. created_by is the
-- display name of the account that first linked it (a person, or the
-- forge's agent account).
--
-- Result JSON shape matches `link.ListOutput`:
--   {"rows": [{"id", "task_id", "url", "title", "kind", "state",
--              "created_at", "updated_at", "created_by_id",
--              "created_by"}]}
CREATE OR REPLACE FUNCTION link_list_batch(
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
    _task_id bigint;
    _visible boolean;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _task_id := COALESCE(NULLIF(_raw->>'task_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _task_id := 0;
        END;
        IF _task_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'link.list: task_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT EXISTS (
            SELECT 1
            FROM user_account caller
            JOIN user_role ur
              ON ur.user_id = caller.id
              OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
            WHERE caller.id = link_list_batch.actor_id
              AND (ur.scope_card_id IS NULL
                   OR ur.scope_card_id = card_enclosing_project(_task_id))
        ) INTO _visible;
        IF NOT _visible THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('rows', '[]'::jsonb);
            CONTINUE;
        END IF;

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id',            l.id::text,
                        'task_id',       l.parent_card_id::text,
                        'url',           COALESCE(attrs.url, ''),
                        'title',         COALESCE(NULLIF(attrs.title, ''), attrs.url, ''),
                        'kind',          COALESCE(attrs.kind, ''),
                        'state',         COALESCE(attrs.state, ''),
                        'created_at',    to_char(l.created_at AT TIME ZONE 'UTC',
                                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        'updated_at',    to_char(COALESCE(act.updated_at, l.created_at) AT TIME ZONE 'UTC',
                                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        'created_by_id', COALESCE(act.creator_id, 0)::text,
                        'created_by',    COALESCE(ua.display_name, '')
                    ) ORDER BY l.id
                )
                FROM card l
                JOIN card_type ct ON ct.id = l.card_type_id AND ct.name = 'link'
                LEFT JOIN LATERAL (
                    SELECT
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'link_url')   AS url,
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'title')      AS title,
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'link_kind')  AS kind,
                        max(av.value #>> '{}') FILTER (WHERE ad.name = 'link_state') AS state
                    FROM attribute_value av
                    JOIN attribute_def ad ON ad.id = av.attribute_def_id
                    WHERE av.card_id = l.id
                ) attrs ON true
                LEFT JOIN LATERAL (
                    SELECT max(a.created_at) AS updated_at,
                           (SELECT a2.actor_id FROM activity a2
                             WHERE a2.card_id = l.id AND a2.kind = 'card_create'
                             ORDER BY a2.id LIMIT 1) AS creator_id
                    FROM activity a
                    WHERE a.card_id = l.id
                ) act ON true
                LEFT JOIN user_account ua ON ua.id = act.creator_id
                WHERE l.parent_card_id = _task_id
                  AND l.deleted_at IS NULL
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

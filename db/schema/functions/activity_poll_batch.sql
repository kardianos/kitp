-- activity.poll handler: a CHEAP "is there newer activity?" check for the
-- task-detail background poll. Given a task_id + since_activity_id it returns
-- the latest activity id and the count of newer rows across the task AND its
-- comm child cards. Replies/threads write activity on the comm cards (children
-- of the task), comments + new-thread attr_updates write on the task itself —
-- so spanning task + comm children lets ONE `since` cursor catch all three.
--
-- Visibility (B7): gated ONCE on the task (the actor must be able to see it).
-- The comm children share the task's project, so task visibility implies theirs
-- — cheaper than the per-row walk activity.select does, and correct here.
--
-- Result JSON shape matches `activity.PollOutput`.
CREATE OR REPLACE FUNCTION activity_poll_batch(
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
    _since bigint;
    _latest bigint;
    _new_count int;
    _visible boolean;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _task_id := NULLIF(_raw->>'task_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _task_id := NULL;
        END;
        BEGIN
            _since := COALESCE(NULLIF(_raw->>'since_activity_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _since := 0;
        END;
        IF _task_id IS NULL OR _task_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity.poll: task_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- Per-actor visibility on the task: walk up to its project (depth<16
        -- cap) and confirm the actor (or its parent_user) holds a global- or
        -- project-scoped role. Mirrors activity.select's B7 clause, keyed once
        -- on the task rather than per activity row.
        SELECT EXISTS (
            WITH RECURSIVE up(id, parent_card_id, card_type_id, depth) AS (
                SELECT card.id, card.parent_card_id, card.card_type_id, 0
                FROM card WHERE card.id = _task_id
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
            WHERE caller.id = activity_poll_batch.actor_id
              AND (
                ur.scope_card_id IS NULL
                OR ur.scope_card_id IN (
                    SELECT up.id
                    FROM up JOIN card_type ct2 ON ct2.id = up.card_type_id
                    WHERE ct2.name = 'project'
                )
              )
        ) INTO _visible;

        IF NOT _visible THEN
            -- No access → report nothing new (don't leak existence).
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('latest_activity_id', '0', 'new_count', 0);
            CONTINUE;
        END IF;

        SELECT COALESCE(max(a.id), 0),
               COALESCE(count(*) FILTER (WHERE a.id > _since), 0)::int
          INTO _latest, _new_count
        FROM activity a
        WHERE a.card_id = _task_id
           OR a.card_id IN (
                SELECT c.id
                FROM card c
                JOIN card_type ct ON ct.id = c.card_type_id
                WHERE c.parent_card_id = _task_id AND ct.name = 'comm'
              );

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'latest_activity_id', _latest::text,
                'new_count', _new_count
            );
    END LOOP;
END;
$$;

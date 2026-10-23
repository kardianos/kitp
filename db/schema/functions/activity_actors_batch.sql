-- activity.actors handler: the accounts that can make changes in a
-- project, named the way the activity feed names them, for the actor
-- pickers of activity filters ("Done by" / "Not done by" on an activity
-- sink or a notification subscription).
--
-- Per-row pipeline:
--   1. Decode project_id (required) and ids[] (optional user ids to name
--      as well: the ones a saved filter already holds, so it can show a
--      name for an account that has since lost its role).
--   2. The project must exist and the caller must see it (DI-6: a global
--      role, or one scoped to the project or an ancestor; an agent sees
--      what its owner sees). Otherwise not_found, as for a hidden card.
--   3. Accounts: every holder of a role that reaches the project, the
--      agents those holders own (an agent acts under its owner's grants),
--      and ids. Each {id, name (user_label), is_agent, person_id (their
--      linked person card, for conditions on people such as "approval
--      asked of"; absent for an agent)}; people first, then agents, each
--      by name.
--
-- Result JSON shape matches `activity.ActorsOutput`.
CREATE OR REPLACE FUNCTION activity_actors_batch(
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
    _project_id bigint;
    _ids bigint[];
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _project_id := NULLIF(_raw->>'project_id', '')::bigint;
            _ids := ARRAY(
                SELECT e::bigint
                FROM jsonb_array_elements_text(
                    CASE jsonb_typeof(_raw->'ids') WHEN 'array' THEN _raw->'ids' ELSE '[]'::jsonb END
                ) AS e
            );
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity.actors: project_id and ids must be ids'::text, NULL::jsonb;
            CONTINUE;
        END;
        IF _project_id IS NULL OR _project_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity.actors: project_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT EXISTS (
            SELECT 1
            FROM card c
            JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
            WHERE c.id = _project_id
              AND EXISTS (
                SELECT 1
                FROM user_account caller
                JOIN user_role ur
                  ON ur.user_id = caller.id
                  OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
                WHERE caller.id = activity_actors_batch.actor_id
                  AND (ur.scope_card_id IS NULL
                       OR ur.scope_card_id IN (SELECT pj.id FROM card_ancestors(_project_id) pj))
              )
        ) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                'activity.actors: project not found'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        RETURN QUERY
        WITH holders AS (
            SELECT DISTINCT ur.user_id AS id
            FROM user_role ur
            WHERE ur.scope_card_id IS NULL
               OR ur.scope_card_id IN (SELECT pj.id FROM card_ancestors(_project_id) pj)
        ),
        accounts AS (
            SELECT h.id FROM holders h
            UNION
            SELECT u.id FROM user_account u JOIN holders h ON h.id = u.parent_user_id
            WHERE u.is_agent
            UNION
            SELECT u.id FROM user_account u WHERE u.id = ANY(_ids)
        )
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(
                           jsonb_build_object(
                               'id', u.id::text,
                               'name', user_label(u.id),
                               'is_agent', u.is_agent,
                               'person_id', (
                                   SELECT uap.person_card_id::text FROM user_account_person uap
                                   WHERE uap.user_account_id = u.id
                                   ORDER BY uap.person_card_id LIMIT 1))
                           ORDER BY u.is_agent, lower(user_label(u.id)), u.id)
                FROM accounts a
                JOIN user_account u ON u.id = a.id
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

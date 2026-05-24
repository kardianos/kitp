-- user_card_agent.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runList into one PL/pgSQL body.
--
-- One input → one result row. Always scoped to the calling actor:
-- listing surfaces only routings owned by actor_id (user_id =
-- actor_id). Optional per-input parent_card_id narrows to routings
-- whose target card sits directly under that parent (typical use:
-- one project).
--
-- Authz (RoleAuthenticated) runs pre-tx in Go.
--
-- Result JSON shape matches `usercardagent.ListOutput`:
--   {"rows": [{"card_id": "<bigint>", "agent_user_id": "<bigint>",
--             "created_at": "<RFC3339>"}]}
CREATE OR REPLACE FUNCTION user_card_agent_list_batch(
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
    _parent_id bigint;
    _has_parent boolean;
    _payload jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _has_parent := (_raw ? 'parent_card_id')
                        AND jsonb_typeof(_raw->'parent_card_id') <> 'null';
        _parent_id := NULL;
        IF _has_parent THEN
            BEGIN
                _parent_id := NULLIF(_raw->>'parent_card_id', '')::bigint;
            EXCEPTION WHEN invalid_text_representation THEN
                _parent_id := NULL;
            END;
            _has_parent := _parent_id IS NOT NULL;
        END IF;

        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'card_id',       uca.card_id::text,
                    'agent_user_id', uca.agent_user_id::text,
                    'created_at',
                        to_char(uca.created_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                ) ORDER BY uca.created_at DESC, uca.card_id
            )
            FROM user_card_agent uca
            WHERE uca.user_id = user_card_agent_list_batch.actor_id
              AND (NOT _has_parent OR EXISTS (
                    SELECT 1 FROM card c
                    WHERE c.id = uca.card_id
                      AND c.parent_card_id = _parent_id
              ))
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

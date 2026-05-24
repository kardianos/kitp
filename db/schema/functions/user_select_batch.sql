-- user.select handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runSelect into one PL/pgSQL body.
--
-- One input → one result row. Per-input filters AND together:
--   - ids[]:           explicit id whitelist (string-encoded bigints)
--   - parent_user_id:  exact match on user_account.parent_user_id
--   - is_agent:        exact match on user_account.is_agent
--
-- Empty/absent filters mean "match everything". Rows are sorted by
-- (display_name, id) for stable UI rendering.
--
-- Authz (RoleAuthenticated) runs pre-tx in Go.
--
-- Result JSON shape matches `user.SelectOutput`:
--   {"rows": [{"id": "<bigint>", "display_name": "...",
--             "parent_user_id": "<bigint>"|null, "is_agent": bool}]}
CREATE OR REPLACE FUNCTION user_select_batch(
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
    _ids_raw jsonb;
    _has_ids boolean;
    _parent_raw text;
    _parent_id bigint;
    _has_parent boolean;
    _is_agent_raw jsonb;
    _has_agent boolean;
    _is_agent boolean;
    _payload jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _ids_raw := _raw->'ids';
        _has_ids := (_ids_raw IS NOT NULL
                     AND jsonb_typeof(_ids_raw) = 'array'
                     AND jsonb_array_length(_ids_raw) > 0);

        _has_parent := (_raw ? 'parent_user_id')
                        AND jsonb_typeof(_raw->'parent_user_id') <> 'null';
        _parent_id := NULL;
        IF _has_parent THEN
            _parent_raw := _raw->>'parent_user_id';
            BEGIN
                _parent_id := NULLIF(_parent_raw, '')::bigint;
            EXCEPTION WHEN invalid_text_representation THEN
                _parent_id := NULL;
            END;
        END IF;

        _is_agent_raw := _raw->'is_agent';
        _has_agent := (_is_agent_raw IS NOT NULL
                        AND jsonb_typeof(_is_agent_raw) = 'boolean');
        _is_agent := COALESCE((_is_agent_raw)::boolean, false);

        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',           ua.id::text,
                    'display_name', ua.display_name,
                    'parent_user_id',
                        CASE WHEN ua.parent_user_id IS NULL
                             THEN NULL::jsonb
                             ELSE to_jsonb(ua.parent_user_id::text)
                        END,
                    'is_agent',     ua.is_agent
                ) ORDER BY ua.display_name, ua.id
            )
            FROM user_account ua
            WHERE
                (NOT _has_ids OR ua.id::text IN (
                    SELECT jsonb_array_elements_text(_ids_raw)
                ))
                AND (NOT _has_parent OR ua.parent_user_id = _parent_id)
                AND (NOT _has_agent  OR ua.is_agent = _is_agent)
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

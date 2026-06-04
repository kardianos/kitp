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
-- Authz (RoleAuthenticated) runs pre-tx in Go, but visibility of AGENT
-- rows is enforced here, per-row: a caller only ever sees agents they
-- parent, unless they hold the global admin role. Human rows
-- (is_agent=false) stay fully listable so assignee pickers are
-- unaffected. This is the security floor for the per-user "My Agents"
-- screen — the client cannot widen it by hand-crafting parent_user_id.
--
-- Result JSON shape matches `user.SelectOutput`:
--   {"rows": [{"id": "<bigint>", "display_name": "...",
--             "parent_user_id": "<bigint>"|null,
--             "parent_user_name": "<owner display_name>"|null,
--             "is_agent": bool}]}
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
    _actor_is_admin boolean;
BEGIN
    -- Whether the caller holds the global (unscoped) admin role. Computed
    -- once; gates whether agent rows owned by OTHER users are visible.
    SELECT EXISTS (
        SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
        WHERE ur.user_id = actor_id AND r.name = 'admin' AND ur.scope_card_id IS NULL
    ) INTO _actor_is_admin;

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
                    'parent_user_name', to_jsonb(owner.display_name),
                    'is_agent',     ua.is_agent
                ) ORDER BY ua.display_name, ua.id
            )
            FROM user_account ua
            LEFT JOIN user_account owner ON owner.id = ua.parent_user_id
            WHERE
                (NOT _has_ids OR ua.id::text IN (
                    SELECT jsonb_array_elements_text(_ids_raw)
                ))
                AND (NOT _has_parent OR ua.parent_user_id = _parent_id)
                AND (NOT _has_agent  OR ua.is_agent = _is_agent)
                -- Agent rows are visible only to their parent or a global
                -- admin; humans stay fully listable. Enforced regardless of
                -- the parent_user_id filter the caller passed.
                AND (
                    NOT ua.is_agent
                    OR _actor_is_admin
                    OR ua.parent_user_id = actor_id
                )
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

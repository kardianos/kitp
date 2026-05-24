-- user_role.revoke handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runRevoke into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: user_id and role_name are required.
--   2. Resolve role_name -> role_id. Unknown role surfaces 'validation'.
--   3. DELETE the matching user_role row. The legacy SQL matched on
--      (scope_card_id IS NULL AND scope_project_id IS NULL) OR
--      (scope_card_id = scope_project_id) — preserved verbatim so a
--      revoke with NULL scope clears the global grant and a revoke
--      with a project id clears that scoped grant.
--
-- Authz (admin / parent-of-agent rule set) runs pre-tx in Go.
--
-- Result JSON shape matches `userrole.RevokeOutput`:
--   {"ok": <bool>, "deleted": <0|1>}
CREATE OR REPLACE FUNCTION user_role_revoke_batch(
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
    _user_id bigint;
    _role_name text;
    _role_id bigint;
    _scope bigint;
    _deleted int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _user_id := NULLIF(_raw->>'user_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _user_id := NULL;
        END;
        _role_name := _raw->>'role_name';
        BEGIN
            _scope := NULLIF(_raw->>'scope_project_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _scope := NULL;
        END;

        IF _user_id IS NULL OR _user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_role.revoke: user_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _role_name IS NULL OR _role_name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_role.revoke: role_name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT id INTO _role_id FROM role WHERE name = _role_name;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('user_role.revoke: role %L not found', _role_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        WITH del AS (
            DELETE FROM user_role
            WHERE user_id = _user_id
              AND role_id = _role_id
              AND (
                  (scope_card_id IS NULL AND _scope IS NULL)
                  OR scope_card_id = _scope
              )
            RETURNING id
        )
        SELECT count(*)::int INTO _deleted FROM del;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', _deleted > 0,
                'deleted', _deleted
            );
    END LOOP;
END;
$$;

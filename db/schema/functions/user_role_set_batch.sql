-- user_role.set handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runSet into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: user_id and role_name are required.
--   2. Resolve role_name -> role_id. Unknown role surfaces 'validation'
--      (the legacy Go path would have failed the inner JOIN; we attribute
--      it to the row instead).
--   3. Upsert against the right partial unique index:
--        - scope_project_id IS NULL  -> uniq_user_role_global
--        - scope_project_id NOT NULL -> uniq_user_role_scoped
--      ON CONFLICT DO UPDATE SET user_id = EXCLUDED.user_id so the
--      RETURNING row fires even on no-op idempotent re-grant.
--
-- Authz (admin / parent-of-agent rule set) runs pre-tx in Go.
--
-- Result JSON shape matches `userrole.SetOutput`:
--   {"ok": true, "user_role_id": "<bigint>"}
CREATE OR REPLACE FUNCTION user_role_set_batch(
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
    _user_role_id bigint;
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
                'user_role.set: user_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _role_name IS NULL OR _role_name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_role.set: role_name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT id INTO _role_id FROM role WHERE name = _role_name;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('user_role.set: role %L not found', _role_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        IF _scope IS NULL THEN
            INSERT INTO user_role (user_id, role_id, scope_card_id)
            VALUES (_user_id, _role_id, NULL)
            ON CONFLICT (user_id, role_id) WHERE scope_card_id IS NULL
                DO UPDATE SET user_id = EXCLUDED.user_id
            RETURNING id INTO _user_role_id;
        ELSE
            INSERT INTO user_role (user_id, role_id, scope_card_id)
            VALUES (_user_id, _role_id, _scope)
            ON CONFLICT (user_id, role_id, scope_card_id) WHERE scope_card_id IS NOT NULL
                DO UPDATE SET user_id = EXCLUDED.user_id
            RETURNING id INTO _user_role_id;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'user_role_id', _user_role_id::text
            );
    END LOOP;
END;
$$;

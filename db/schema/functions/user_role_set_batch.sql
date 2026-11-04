-- user_role.set handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runSet into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: user_id and role_name are required.
--   2. Resolve role_name -> role_id. Unknown role surfaces 'validation'
--      (the legacy Go path would have failed the inner JOIN; we attribute
--      it to the row instead).
--   3. An agent (a user with a parent_user_id) can only be given a role
--      its owner covers at that scope or workspace-wide — the same role or
--      one ranked above it (role_covers) — ('forbidden'), whoever grants
--      it (docs: admin_agents.md, "parent-grants-subset").
--      user_role_effective applies the same rule when roles are used, so
--      a row the owner later stops covering does nothing.
--   4. Upsert against the right partial unique index:
--        - scope_project_id IS NULL  -> uniq_user_role_global
--        - scope_project_id NOT NULL -> uniq_user_role_scoped
--      ON CONFLICT DO UPDATE SET user_id = EXCLUDED.user_id so the
--      RETURNING row fires even on no-op idempotent re-grant.
--
-- Authz (who may grant: an admin, or an agent's owner) runs pre-tx in Go.
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
    _owner bigint;
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

        -- A deleted agent (agent.delete) gets no role again.
        IF EXISTS (SELECT 1 FROM user_account WHERE id = _user_id AND deleted_at IS NOT NULL) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                format('user_role.set: user %s not found', _user_id), NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT parent_user_id INTO _owner FROM user_account WHERE id = _user_id;
        IF _owner IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM user_role pr
            WHERE pr.user_id = _owner AND role_covers(pr.role_id, _role_id)
              AND (pr.scope_card_id IS NULL OR pr.scope_card_id = _scope)) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                CASE WHEN _scope IS NULL
                     THEN format('user_role.set: an agent can only hold a role its owner holds or ranks above; its owner has no workspace-wide %s role or higher', _role_name)
                     ELSE format('user_role.set: an agent can only hold a role its owner holds or ranks above; its owner has no %s role or higher on project %s', _role_name, _scope)
                END,
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

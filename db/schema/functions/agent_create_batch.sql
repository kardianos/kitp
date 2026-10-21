-- agent.create handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runCreate into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: display_name is required; owner, when present, is
--      'self' or 'system'.
--   2. Insert one user_account row with is_agent=TRUE. owner 'self'
--      (the default) parents it to the caller; owner 'system' parents it
--      to the System account (user_account id 1, auth.SystemUserID) — a
--      WORKSPACE agent: an integration identity (a code forge) that no
--      person owns, so deleting the admin who created it doesn't cascade
--      to it. Its effective roles are its own grants intersected with
--      System's (which holds every built-in role), i.e. exactly what an
--      admin grants it.
--
-- The actor-is-not-agent gate and the admin-only rule for owner
-- 'system' are enforced pre-tx in Go via `Authz` (mirrors the other
-- agent.* / user_role.* gates); the admin rule is re-checked here so the
-- function is safe on its own.
--
-- Result JSON shape matches `agent.CreateOutput`:
--   {"user_id": "<bigint>"}
-- bigint id is cast to text per the dispatcher's wire convention.
CREATE OR REPLACE FUNCTION agent_create_batch(
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
    _display_name text;
    _owner text;
    _parent bigint;
    _new_user_id bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _display_name := _raw->>'display_name';
        _owner := COALESCE(NULLIF(_raw->>'owner', ''), 'self');

        IF _display_name IS NULL OR _display_name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'agent.create: display_name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _owner NOT IN ('self', 'system') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('agent.create: owner must be self or system, got %L', _owner),
                NULL::jsonb;
            CONTINUE;
        END IF;

        _parent := agent_create_batch.actor_id;
        IF _owner = 'system' THEN
            IF NOT EXISTS (
                SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
                WHERE ur.user_id = agent_create_batch.actor_id
                  AND r.name = 'admin' AND ur.scope_card_id IS NULL
            ) THEN
                RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                    'agent.create: only a global admin can create a workspace (system-owned) agent'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
            _parent := 1;
        END IF;

        INSERT INTO user_account (display_name, parent_user_id, is_agent)
        VALUES (_display_name, _parent, TRUE)
        RETURNING id INTO _new_user_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'user_id', _new_user_id::text
            );
    END LOOP;
END;
$$;

-- agent.create handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runCreate into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: display_name is required.
--   2. Insert one user_account row with is_agent=TRUE and
--      parent_user_id=actor_id. The new user_account becomes an agent
--      owned by the calling user.
--
-- The actor-is-not-agent gate is enforced pre-tx in Go via `Authz`
-- (mirrors all the other agent.* / user_role.* gates) and is not
-- duplicated here.
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
    _display_name text;
    _new_user_id bigint;
BEGIN
    FOR _idx, _display_name IN
        SELECT (r.ord - 1)::int,
               r.value->>'display_name'
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _display_name IS NULL OR _display_name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'agent.create: display_name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        INSERT INTO user_account (display_name, parent_user_id, is_agent)
        VALUES (_display_name, actor_id, TRUE)
        RETURNING id INTO _new_user_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'user_id', _new_user_id::text
            );
    END LOOP;
END;
$$;

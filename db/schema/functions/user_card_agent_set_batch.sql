-- user_card_agent.set handler (Phase 2 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runSet (ownership validation + UPSERT)
-- into one PL/pgSQL body.
--
-- user_id is implicit — we stamp it from actor_id (auth.ActorOrSystem
-- in the Go wrapper). The caller never supplies user_id; a
-- malicious client therefore cannot write rows attributed to
-- another user.
--
-- Per-row pipeline:
--   1. Validation: card_id and agent_user_id are required.
--   2. Ownership: agent_user_id must name a user_account row that is
--      an agent (is_agent = TRUE) owned by the actor
--      (parent_user_id = actor_id). The legacy Go path rejected the
--      whole batch on the first mismatch via a forbidden error; the
--      unified handler reports per-row 'forbidden' instead so a
--      mixed batch can pinpoint the offender. The dispatcher's
--      first-error semantics still abort the surrounding tx, so
--      sibling writes that returned ok=true above the failed row
--      are still rolled back — only the diagnostic InputIndex
--      changes.
--   3. Upsert. PK (user_id, card_id) makes re-routing the same
--      card idempotent — the new agent_user_id wins.
--
-- Result JSON shape matches `usercardagent.SetOutput`:
--   {"ok": true}
-- No bigint ids on the output; nothing to cast.
CREATE OR REPLACE FUNCTION user_card_agent_set_batch(
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
    _card_id bigint;
    _agent_user_id bigint;
    _owned boolean;
BEGIN
    FOR _idx, _card_id, _agent_user_id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'card_id', '')::bigint,
               NULLIF(r.value->>'agent_user_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_card_agent.set: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _agent_user_id IS NULL OR _agent_user_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_card_agent.set: agent_user_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        DECLARE
            _route_user_id bigint := actor_id;
            _actor_parent bigint;
            _actor_is_agent boolean;
        BEGIN
            -- Agent self-routing: when an agent calls user_card_agent.set
            -- with agent_user_id = themselves, write the row keyed on
            -- THEIR parent so the routed_to_me filter (user_id = actor.
            -- parent, agent_user_id = actor) picks it up. The agent is
            -- effectively saying "put this card on my own inbox."
            SELECT is_agent, parent_user_id
            INTO _actor_is_agent, _actor_parent
            FROM user_account WHERE id = actor_id;
            IF _actor_is_agent AND _agent_user_id = actor_id AND _actor_parent IS NOT NULL THEN
                _route_user_id := _actor_parent;
                _owned := TRUE;
            ELSE
                SELECT EXISTS (
                    SELECT 1 FROM user_account
                    WHERE id = _agent_user_id
                      AND is_agent = TRUE
                      AND parent_user_id = actor_id
                ) INTO _owned;
            END IF;
            IF NOT _owned THEN
                RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                    format('user_card_agent.set: agent_user_id %s is not an agent owned by actor %s',
                           _agent_user_id, actor_id), NULL::jsonb;
                CONTINUE;
            END IF;
            INSERT INTO user_card_agent (user_id, card_id, agent_user_id)
            VALUES (_route_user_id, _card_id, _agent_user_id)
            ON CONFLICT (user_id, card_id) DO UPDATE
                SET agent_user_id = EXCLUDED.agent_user_id;
        END;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('ok', true);
    END LOOP;
END;
$$;

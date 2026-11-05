-- user_card_sort.set handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runSet into one PL/pgSQL body.
--
-- The caller never supplies user_id — we always stamp it from
-- actor_id (auth.ActorOrSystem in the Go wrapper). A malicious
-- client therefore cannot fake a write against another user's row.
--
-- Per-row pipeline:
--   1. Validation: card_id is required.
--   2. Upsert (user_id=actor, card_id, sort_order, updated_at=now()).
--      PK (user_id, card_id) makes re-setting idempotent — the new
--      sort_order wins.
--
-- Result JSON shape matches `usercardsort.SetOutput`:
--   {"ok": true}
-- No bigint ids on the output; nothing to cast.
CREATE OR REPLACE FUNCTION user_card_sort_set_batch(
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
    _sort_order double precision;
    _sort_raw jsonb;
BEGIN
    FOR _idx, _card_id, _sort_raw IN
        SELECT (r.ord - 1)::int,
               CASE WHEN (r.value->>'card_id') ~ '^[0-9]{1,18}$' THEN (r.value->>'card_id')::bigint END,
               r.value->'sort_order'
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_card_sort.set: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        -- A number (or a numeric string): a cast in the loop's query failed
        -- the whole batch as "internal" (review 2026-11-03 round 5).
        IF NOT (jsonb_typeof(_sort_raw) = 'number'
                OR (jsonb_typeof(_sort_raw) = 'string' AND (_sort_raw #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$')) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_card_sort.set: sort_order must be a number'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _sort_order := (_sort_raw #>> '{}')::double precision;
        INSERT INTO user_card_sort (user_id, card_id, sort_order, updated_at)
        VALUES (actor_id, _card_id, _sort_order, now())
        ON CONFLICT (user_id, card_id) DO UPDATE
            SET sort_order = EXCLUDED.sort_order,
                updated_at = now();
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('ok', true);
    END LOOP;
END;
$$;

-- card.undelete handler (Phase 4 of UNIFIED_HANDLER_PLAN.md — moved
-- from the original Phase 5 read bucket because card.undelete is
-- actually a write handler). Folds the former Go-side runUndelete into
-- one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: card_id is required.
--   2. Existence: the card must exist. Missing → 'card_not_found'.
--   3. Already-live guard: deleted_at must be non-NULL. A card that
--      isn't soft-deleted → 'card_not_found' (matches the legacy
--      "missing or already live" diagnostic, now pinned to the
--      specific input rather than the whole batch).
--   4. UPDATE card SET deleted_at = NULL.
--   5. Activity row of kind='card_undelete'.
--
-- Result JSON shape matches `card.UndeleteOutput`:
--   {"ok": true, "activity_id": "<bigint>"}
-- The bigint id is cast to text per the dispatcher's wire convention
-- (Go-side struct uses `json:",string"`).
CREATE OR REPLACE FUNCTION card_undelete_batch(
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
    _deleted_at timestamptz;
    _found boolean;
    _activity_id bigint;
BEGIN
    FOR _idx, _card_id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'card_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.undelete: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2 + 3. Existence + already-live guard in one lookup.
        SELECT deleted_at INTO _deleted_at FROM card WHERE id = _card_id;
        _found := FOUND;
        IF NOT _found THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('card.undelete: card %s not found', _card_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _deleted_at IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                'card.undelete: one or more cards were missing or already live'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Clear the soft-delete flag.
        UPDATE card SET deleted_at = NULL WHERE id = _card_id;

        -- 5. Activity row.
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_card_id, 'card_undelete', actor_id)
        RETURNING id INTO _activity_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'activity_id', _activity_id::text
            );
    END LOOP;
END;
$$;

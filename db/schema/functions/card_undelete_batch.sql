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
--   3b. A personal card (screen, watch list, view, calendar) comes back
--       only within its owner's cap (personal_cap_full) → 'limit'.
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

        -- 3a. A mail account or an activity sink is a workspace admin's
        --     (review 2026-11-06 #2).
        IF card_is_admin_only(_card_id) AND NOT user_is_global_admin(card_undelete_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'card.undelete: only a workspace admin changes a mail account or an activity sink'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3b. A personal card comes back within its owner's cap: deleting,
        --     creating and undeleting put a person past it (review
        --     2026-11-03 round 5 #11).
        IF EXISTS (
            SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _card_id
              AND personal_cap_full(ct.name, CASE WHEN ct.name = 'calendar' THEN
                      (SELECT CASE WHEN jsonb_typeof(sv.value) = 'number' THEN (sv.value)::text::bigint END
                       FROM attribute_value sv JOIN attribute_def sd ON sd.id = sv.attribute_def_id AND sd.name = 'subscriber'
                       WHERE sv.card_id = c.id)
                  ELSE c.private_to END)) THEN
            RETURN QUERY SELECT _idx, false, 'limit'::text,
                'card.undelete: its owner already has as many of these as they may; delete one first'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Clear the soft-delete flag.
        UPDATE card SET deleted_at = NULL WHERE id = _card_id;
        -- Its pages' publications were kept at delete (card.delete): the
        -- portals they are on rebuild with them back (review 2026-11-03
        -- round 2 #19).
        PERFORM portal_mark_dirty(pp.portal_id) FROM portals_publishing_under(_card_id) pp;
        -- A theme deleted or brought back rebuilds the portals built
        -- with it (review 2026-11-03 round 5).
        PERFORM portal_mark_dirty(pv.card_id)
        FROM attribute_value pv
        JOIN attribute_def pd ON pd.id = pv.attribute_def_id AND pd.name = 'portal_theme'
        WHERE jsonb_typeof(pv.value) = 'number' AND (pv.value)::text::bigint = _card_id;

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

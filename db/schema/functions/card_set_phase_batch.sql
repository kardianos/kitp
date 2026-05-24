-- card.set_phase handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side validateSetPhase + runSetPhase into one PL/pgSQL
-- body.
--
-- Per-row pipeline:
--   1. Validation: card_id required, phase ∈ (triage, active, terminal).
--   2. Existence: card must exist and not be soft-deleted →
--      'card_not_found' otherwise.
--   3. UPDATE card.phase, INSERT activity 'card_set_phase' with
--      value_old / value_new carrying the phase strings.
--
-- Result JSON shape matches `card.SetPhaseOutput`:
--   {"ok": true, "activity_id": "<bigint>"}
CREATE OR REPLACE FUNCTION card_set_phase_batch(
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
    _phase text;
    _phase_old text;
    _activity_id bigint;
BEGIN
    FOR _idx, _card_id, _phase IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'card_id', '')::bigint,
               r.value->>'phase'
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.set_phase: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _phase IS NULL OR _phase NOT IN ('triage', 'active', 'terminal') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('card.set_phase: phase %L: must be triage|active|terminal',
                    COALESCE(_phase, '')),
                NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT phase INTO _phase_old
        FROM card WHERE id = _card_id AND deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('card.set_phase: card %s not found', _card_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        UPDATE card SET phase = _phase WHERE id = _card_id;
        INSERT INTO activity (card_id, kind, value_old, value_new, actor_id)
        VALUES (_card_id, 'card_set_phase',
                to_jsonb(_phase_old), to_jsonb(_phase), actor_id)
        RETURNING id INTO _activity_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'activity_id', _activity_id::text
            );
    END LOOP;
END;
$$;

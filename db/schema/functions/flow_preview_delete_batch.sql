-- flow.preview_delete handler (Phase 5 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runFlowPreviewDelete into one PL/pgSQL body.
--
-- READ-shaped despite the name: no rows are mutated. Returns the V16
-- preview shape so the admin "are you sure?" dialog can show step count
-- + affected-task counts (total + phase breakdown) + a deterministic
-- sample of step labels BEFORE the destructive flow.delete call.
--
-- Per-row pipeline:
--   1. Presence check (flow_id required).
--   2. Look up the flow's name + attribute_def_id + step count.
--   3. Count attribute_value rows on that attribute_def whose JSON value
--      (jsonb_typeof = 'number') points at a value-card that appears as
--      from_card_id OR to_card_id in any flow_step under this flow —
--      i.e. any value-card the flow gates. Bucket by card.phase.
--   4. Up to 5 sample labels in (sort_order, label) order.
--
-- Result JSON shape matches `flow.PreviewDeleteOutput`.
--
-- Authz (admin) runs pre-tx in Go.
CREATE OR REPLACE FUNCTION flow_preview_delete_batch(
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
    _flow_id bigint;
    _name text;
    _attr_def_id bigint;
    _step_count int;
    _triage int;
    _active int;
    _terminal int;
    _total int;
    _labels jsonb;
    _payload jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _flow_id := COALESCE(NULLIF(_raw->>'flow_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _flow_id := 0;
        END;

        IF _flow_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow.preview_delete: flow_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT f.name, f.attribute_def_id,
               (SELECT count(*) FROM flow_step fs WHERE fs.flow_id = f.id)
          INTO _name, _attr_def_id, _step_count
        FROM flow f
        WHERE f.id = _flow_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'flow_not_found'::text,
                format('flow.preview_delete: id %s not found', _flow_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- Phase counts in one statement: WITH gated AS / affected AS.
        -- card_ref values serialise as JSON numbers (the value card id);
        -- cast through ::text::bigint to match the canonical form the
        -- attribute writer canonicalises to (same idiom flow.delete /
        -- attribute.update use).
        WITH gated AS (
            SELECT DISTINCT card_id FROM (
                SELECT from_card_id AS card_id FROM flow_step WHERE flow_id = _flow_id
                UNION
                SELECT to_card_id   AS card_id FROM flow_step WHERE flow_id = _flow_id
            ) u
        ),
        affected AS (
            SELECT c.phase
            FROM attribute_value av
            JOIN card c ON c.id = (av.value)::text::bigint
            WHERE av.attribute_def_id = _attr_def_id
              AND jsonb_typeof(av.value) = 'number'
              AND (av.value)::text::bigint IN (SELECT card_id FROM gated)
        )
        SELECT
            COALESCE(sum(CASE WHEN phase = 'triage'   THEN 1 ELSE 0 END), 0)::int,
            COALESCE(sum(CASE WHEN phase = 'active'   THEN 1 ELSE 0 END), 0)::int,
            COALESCE(sum(CASE WHEN phase = 'terminal' THEN 1 ELSE 0 END), 0)::int,
            COALESCE(count(*), 0)::int
        INTO _triage, _active, _terminal, _total
        FROM affected;

        -- Up to 5 sample labels in sort_order then label.
        SELECT COALESCE(jsonb_agg(label ORDER BY sort_order, label), '[]'::jsonb)
          INTO _labels
        FROM (
            SELECT label, sort_order
            FROM flow_step
            WHERE flow_id = _flow_id
            ORDER BY sort_order, label
            LIMIT 5
        ) s;

        _payload := jsonb_build_object(
            'flow_id',                       _flow_id::text,
            'flow_name',                     _name,
            'step_count',                    _step_count,
            'tasks_currently_in_flow_states', _total,
            'tasks_by_phase', jsonb_build_object(
                'triage',   _triage,
                'active',   _active,
                'terminal', _terminal),
            'sample_step_labels',            _labels
        );

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

-- flow_step.set handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds
-- runStepSet + validateStepInput + upsertStep into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Presence checks (flow_id, from_card_id, to_card_id, label).
--   2. Flow must exist; pull the attribute_def's target_card_type_id
--      so from_card_id / to_card_id can be validated as value-cards of
--      the right type. attribute_def lacking a target_card_type_id
--      surfaces 'flow_attr_not_card_ref'.
--   3. Both from_card_id and to_card_id must exist and have
--      card_type_id = target_card_type_id. Failures →
--      'card_not_found' / 'card_wrong_type'.
--   4. Insert (id=0) or update by id. The unique
--      (flow_id, from_card_id, to_card_id, label) constraint surfaces
--      as 'flow_step_duplicate'.
--
-- Result JSON shape matches `flow.StepSetOutput`: {"id": "<bigint>"}.
--
-- Authz (admin gate) runs pre-tx in Go.
CREATE OR REPLACE FUNCTION flow_step_set_batch(
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
    _id bigint;
    _flow_id bigint;
    _from_id bigint;
    _to_id bigint;
    _label text;
    _requires_role_id bigint;
    _sort_order int;
    _standalone boolean;
    _target_card_type_id bigint;
    _has_target boolean;
    _ctid bigint;
    _new_id bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _id := 0;
        END;
        BEGIN
            _flow_id := COALESCE(NULLIF(_raw->>'flow_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _flow_id := 0;
        END;
        BEGIN
            _from_id := COALESCE(NULLIF(_raw->>'from_card_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _from_id := 0;
        END;
        BEGIN
            _to_id := COALESCE(NULLIF(_raw->>'to_card_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _to_id := 0;
        END;
        _label := _raw->>'label';
        BEGIN
            _requires_role_id := COALESCE(NULLIF(_raw->>'requires_role_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _requires_role_id := 0;
        END;
        BEGIN
            _sort_order := COALESCE((_raw->>'sort_order')::int, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _sort_order := 0;
        END;
        -- Presentation bit: true = standalone button, false = overflow
        -- dropdown. Absent/invalid → false (the column default).
        _standalone := COALESCE((_raw->>'standalone')::boolean, false);

        -- 1. Presence checks.
        IF _flow_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow_step.set: flow_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _from_id = 0 OR _to_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow_step.set: from_card_id and to_card_id are required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _label IS NULL OR _label = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow_step.set: label is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Flow must exist; resolve the attribute_def target type.
        SELECT ad.target_card_type_id, ad.target_card_type_id IS NOT NULL
          INTO _target_card_type_id, _has_target
        FROM flow f
        JOIN attribute_def ad ON ad.id = f.attribute_def_id
        WHERE f.id = _flow_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'flow_not_found'::text,
                format('flow_step.set: flow %s not found', _flow_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT _has_target THEN
            RETURN QUERY SELECT _idx, false, 'flow_attr_not_card_ref'::text,
                'flow_step.set: flow''s attribute_def is not card_ref-typed; transitions are not applicable'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Validate from_card_id (matches the Go path's loop order;
        --    surfaces the first offender so error messages are stable).
        SELECT card_type_id INTO _ctid FROM card WHERE id = _from_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('flow_step.set: from_card_id=%s not found', _from_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ctid <> _target_card_type_id THEN
            RETURN QUERY SELECT _idx, false, 'card_wrong_type'::text,
                format('flow_step.set: from_card_id=%s is card_type %s, expected %s (target of flow''s attribute_def)',
                    _from_id, _ctid, _target_card_type_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT card_type_id INTO _ctid FROM card WHERE id = _to_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('flow_step.set: to_card_id=%s not found', _to_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ctid <> _target_card_type_id THEN
            RETURN QUERY SELECT _idx, false, 'card_wrong_type'::text,
                format('flow_step.set: to_card_id=%s is card_type %s, expected %s (target of flow''s attribute_def)',
                    _to_id, _ctid, _target_card_type_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Insert / update.
        BEGIN
            IF _id = 0 THEN
                INSERT INTO flow_step (flow_id, from_card_id, to_card_id, label, requires_role_id, sort_order, standalone)
                VALUES (_flow_id, _from_id, _to_id, _label,
                    NULLIF(_requires_role_id, 0), _sort_order, _standalone)
                RETURNING id INTO _new_id;
            ELSE
                UPDATE flow_step SET
                    flow_id = _flow_id,
                    from_card_id = _from_id,
                    to_card_id = _to_id,
                    label = _label,
                    requires_role_id = NULLIF(_requires_role_id, 0),
                    sort_order = _sort_order,
                    standalone = _standalone
                WHERE id = _id
                RETURNING id INTO _new_id;
                IF NOT FOUND THEN
                    RETURN QUERY SELECT _idx, false, 'flow_step_not_found'::text,
                        format('flow_step.set: id %s not found', _id),
                        NULL::jsonb;
                    CONTINUE;
                END IF;
            END IF;
        EXCEPTION
            WHEN unique_violation THEN
                RETURN QUERY SELECT _idx, false, 'flow_step_duplicate'::text,
                    'flow_step.set: a flow_step already exists with this (flow_id, from_card_id, to_card_id, label)'::text,
                    NULL::jsonb;
                CONTINUE;
            WHEN foreign_key_violation THEN
                RETURN QUERY SELECT _idx, false, 'fk_violation'::text,
                    format('flow_step.set: %s', SQLERRM),
                    NULL::jsonb;
                CONTINUE;
        END;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('id', _new_id::text);
    END LOOP;
END;
$$;

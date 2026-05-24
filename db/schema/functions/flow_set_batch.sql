-- flow.set handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runFlowSet + validateSetInput + upsertFlow into one
-- PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Presence / scalar validation (name, attribute_def_id,
--      scope_card_id required; default_create_status_id optional).
--   2. attribute_def must exist; surface its target_card_type_id so the
--      optional default_create_status_id can be type-checked.
--   3. scope_card_id must exist and be a project card.
--   4. Optional default_create_status_id must point at a card whose
--      card_type_id matches the attribute_def's target_card_type_id.
--   5. Insert (id=0) or update by id; the unique
--      (attribute_def_id, scope_card_id) constraint surfaces as
--      'flow_duplicate_scope'.
--
-- Result JSON shape matches `flow.SetOutput`: {"id": "<bigint>"}.
--
-- Authz (admin gate) runs pre-tx in Go.
CREATE OR REPLACE FUNCTION flow_set_batch(
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
    _name text;
    _doc text;
    _attr_def_id bigint;
    _scope_card_id bigint;
    _default_status_id bigint;
    _target_card_type_id bigint;
    _has_target boolean;
    _scope_kind text;
    _ctid bigint;
    _new_id bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode.
        BEGIN
            _id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _id := 0;
        END;
        _name := _raw->>'name';
        _doc := COALESCE(_raw->>'doc', '');
        BEGIN
            _attr_def_id := COALESCE(NULLIF(_raw->>'attribute_def_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _attr_def_id := 0;
        END;
        BEGIN
            _scope_card_id := COALESCE(NULLIF(_raw->>'scope_card_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _scope_card_id := 0;
        END;
        BEGIN
            _default_status_id := COALESCE(NULLIF(_raw->>'default_create_status_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _default_status_id := 0;
        END;

        -- Cheap presence checks (same diagnostics as the legacy Go path).
        IF _name IS NULL OR _name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow.set: name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _attr_def_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow.set: attribute_def_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _scope_card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow.set: scope_card_id is required (every flow is project-scoped)'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. attribute_def + target_card_type_id.
        SELECT target_card_type_id, target_card_type_id IS NOT NULL
          INTO _target_card_type_id, _has_target
          FROM attribute_def WHERE id = _attr_def_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'attribute_def_not_found'::text,
                format('flow.set: attribute_def %s not found', _attr_def_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. scope card must exist + be a project.
        SELECT ct.name INTO _scope_kind
          FROM card c JOIN card_type ct ON ct.id = c.card_type_id
          WHERE c.id = _scope_card_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'scope_card_not_found'::text,
                format('flow.set: scope_card_id %s not found', _scope_card_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _scope_kind <> 'project' THEN
            RETURN QUERY SELECT _idx, false, 'scope_not_project'::text,
                format('flow.set: scope_card_id %s is a %L card, not a project',
                    _scope_card_id, _scope_kind),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Optional default_create_status_id must be a card whose
        --    card_type_id matches the attribute_def's target_card_type_id.
        IF _default_status_id <> 0 THEN
            IF NOT _has_target THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'flow.set: attribute_def has no target_card_type — default_create_status_id is not applicable'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
            SELECT card_type_id INTO _ctid FROM card WHERE id = _default_status_id;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'default_status_not_found'::text,
                    format('flow.set: default_create_status_id %s not found', _default_status_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _ctid <> _target_card_type_id THEN
                RETURN QUERY SELECT _idx, false, 'default_status_wrong_type'::text,
                    format('flow.set: default_create_status_id %s is card_type %s, expected %s (target of attribute_def %s)',
                        _default_status_id, _ctid, _target_card_type_id, _attr_def_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 5. Insert or update. The unique (attribute_def_id, scope_card_id)
        --    constraint surfaces as 'flow_duplicate_scope' below.
        BEGIN
            IF _id = 0 THEN
                INSERT INTO flow (name, doc, attribute_def_id, scope_card_id, default_create_status_id)
                VALUES (_name, NULLIF(_doc, ''), _attr_def_id, _scope_card_id,
                    NULLIF(_default_status_id, 0))
                RETURNING id INTO _new_id;
            ELSE
                UPDATE flow SET
                    name = _name,
                    doc = NULLIF(_doc, ''),
                    attribute_def_id = _attr_def_id,
                    scope_card_id = _scope_card_id,
                    default_create_status_id = NULLIF(_default_status_id, 0)
                WHERE id = _id
                RETURNING id INTO _new_id;
                IF NOT FOUND THEN
                    RETURN QUERY SELECT _idx, false, 'flow_not_found'::text,
                        format('flow.set: id %s not found', _id),
                        NULL::jsonb;
                    CONTINUE;
                END IF;
            END IF;
        EXCEPTION
            WHEN unique_violation THEN
                RETURN QUERY SELECT _idx, false, 'flow_duplicate_scope'::text,
                    'flow.set: a flow already exists for this (attribute_def, scope_card_id) — only one flow per attribute per project (V18)'::text,
                    NULL::jsonb;
                CONTINUE;
            WHEN foreign_key_violation THEN
                RETURN QUERY SELECT _idx, false, 'fk_violation'::text,
                    format('flow.set: %s', SQLERRM),
                    NULL::jsonb;
                CONTINUE;
        END;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('id', _new_id::text);
    END LOOP;
END;
$$;

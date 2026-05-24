-- card.move handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runMove into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: card_id and new_parent_card_id are both required.
--   2. Existence: both cards must live (the moved card and the new
--      parent). Missing card → 'card_not_found', missing parent →
--      'parent_not_found'.
--   3. Parent-type compatibility: parent.card_type must be the child's
--      card_type.parent_card_type_id (or self when allow_self_parent).
--      Mismatch → 'edge_violation'.
--   4. UPDATE card SET parent_card_id = new_parent + INSERT activity
--      'card_move' with old/new parent ids in value_old / value_new.
--
-- Result JSON shape matches `card.MoveOutput`:
--   {"ok": true, "activity_id": "<bigint>"}
CREATE OR REPLACE FUNCTION card_move_batch(
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
    _new_parent bigint;
    _child_type_id bigint;
    _child_old_parent bigint;
    _child_parent_type_id bigint;
    _child_allow_self boolean;
    _parent_type_id bigint;
    _parent_type_name text;
    _child_type_name text;
    _activity_id bigint;
    _ok boolean;
BEGIN
    FOR _idx, _card_id, _new_parent IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'card_id', '')::bigint,
               NULLIF(r.value->>'new_parent_card_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0
           OR _new_parent IS NULL OR _new_parent = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.move: card_id and new_parent_card_id are required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2a. Moved card.
        SELECT c.card_type_id, c.parent_card_id,
               ct.parent_card_type_id, ct.allow_self_parent
          INTO _child_type_id, _child_old_parent,
               _child_parent_type_id, _child_allow_self
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _card_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('card.move: card %s not found', _card_id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2b. New parent.
        SELECT card_type_id INTO _parent_type_id
        FROM card WHERE id = _new_parent;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'parent_not_found'::text,
                format('card.move: new_parent_card_id %s not found', _new_parent),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. ParentAllowed.
        _ok := false;
        IF _child_allow_self AND _parent_type_id = _child_type_id THEN
            _ok := true;
        ELSIF _child_parent_type_id IS NOT NULL AND _parent_type_id = _child_parent_type_id THEN
            _ok := true;
        END IF;
        IF NOT _ok THEN
            SELECT name INTO _child_type_name FROM card_type WHERE id = _child_type_id;
            SELECT name INTO _parent_type_name FROM card_type WHERE id = _parent_type_id;
            RETURN QUERY SELECT _idx, false, 'edge_violation'::text,
                format('card.move: card_type %L is not allowed under parent type %L',
                    COALESCE(_child_type_name, '?'),
                    COALESCE(_parent_type_name, '?')),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Update + activity.
        UPDATE card SET parent_card_id = _new_parent WHERE id = _card_id;
        INSERT INTO activity (card_id, kind, value_old, value_new, actor_id)
        VALUES (_card_id, 'card_move',
                to_jsonb(_child_old_parent),
                to_jsonb(_new_parent),
                actor_id)
        RETURNING id INTO _activity_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'activity_id', _activity_id::text
            );
    END LOOP;
END;
$$;

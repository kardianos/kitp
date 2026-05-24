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
    -- A11 cross-project ref re-validation.
    _new_project bigint;
    _ref_attr text;
    _ref_vid bigint;
    _ref_vproj bigint;
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

        -- 2c. Cycle guard (A1 / SEC-1). A move is a cycle when the new
        --     parent IS the card, or the card is an ancestor of the new
        --     parent (i.e. the new parent sits in the subtree rooted at
        --     the card). card_ancestors walks parent_card_id up from the
        --     new parent with the depth cap baked in; if _card_id shows
        --     up in that chain, re-parenting would close a loop.
        IF _new_parent = _card_id
           OR EXISTS (SELECT 1 FROM card_ancestors(_new_parent) a WHERE a.id = _card_id) THEN
            RETURN QUERY SELECT _idx, false, 'cycle'::text,
                format('card.move: cannot move card %s under itself or its own descendant %s',
                    _card_id, _new_parent),
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

        -- 3b. Cross-project ref re-validation (A11 / BE-M5). A re-parent
        --     can change the card's enclosing project; card.insert /
        --     attribute.update enforce that a card's project-scoped
        --     card_ref values live in the same project, but a plain move
        --     used to skip the check, leaving a moved card with refs into
        --     its old project. Re-run the invariant against the NEW
        --     enclosing project via the shared helper (reuses A10's
        --     card_enclosing_project). Global value-cards are wildcards
        --     and never offend.
        _new_project := card_enclosing_project(_new_parent);
        SELECT cp.attr_name, cp.value_card_id, cp.value_project
          INTO _ref_attr, _ref_vid, _ref_vproj
        FROM card_ref_cross_project(_card_id, _new_project) cp;
        IF FOUND THEN
            RETURN QUERY SELECT _idx, false, 'cross_project_ref'::text,
                format('card.move: attribute %L value card %s belongs to project %s but the move would place card %s in project %s',
                    _ref_attr, _ref_vid, _ref_vproj, _card_id, COALESCE(_new_project::text, '0')),
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

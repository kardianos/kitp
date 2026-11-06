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
    _old_project bigint;
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
        WHERE c.id = _card_id
        -- Locked before the checks below: a card.insert or attribute.update
        -- naming it holds it FOR SHARE, so one that names it while it moves
        -- either finishes first (and 3b' counts it) or waits and then sees
        -- it in its new project (review 2026-11-06 round 8 #11).
        FOR NO KEY UPDATE OF c;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('card.move: card %s not found', _card_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        -- A mail account or an activity sink is a workspace admin's (see
        -- card_is_admin_only): moved into another project, A's mailbox filed
        -- into B, B's threads sent as A's address, and a Teams sink posted
        -- B's activity to A's channel (review 2026-11-06 round 8 L1).
        IF card_is_admin_only(_card_id) AND NOT user_is_global_admin(card_move_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'card.move: only a workspace admin changes a mail account or an activity sink'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2b. New parent — one the actor can see (an invisible one reads
        --     as missing, so the reply doesn't confirm it exists).
        SELECT card_type_id INTO _parent_type_id
        FROM card WHERE id = _new_parent AND deleted_at IS NULL
          AND card_visible_to(card_move_batch.actor_id, id);
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

        -- 2c'. Under someone's private card goes only a card private to
        --      them: a shared card moved under a personal screen stayed
        --      visible to everyone (it isn't private itself), and so did
        --      another person's (review 2026-11-03 round 4). A private card
        --      may sit under a shared one (a personal view on a shared
        --      screen, docs/PERSONAL_SCREENS.md P10), so that way is open.
        IF (SELECT c.private_to FROM card c WHERE c.id = _new_parent) IS NOT NULL
           AND (SELECT c.private_to FROM card c WHERE c.id = _card_id)
               IS DISTINCT FROM (SELECT c.private_to FROM card c WHERE c.id = _new_parent) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'card.move: only a card private to the same person can go under a personal card'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2c''. A personal screen has no parent (PERSONAL_SCREENS P7): moved
        --      under a project it left my_screen.* and the cap's count
        --      (review 2026-11-03 round 5 #11).
        IF EXISTS (SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id
                   WHERE c.id = _card_id AND ct.name = 'screen' AND c.private_to IS NOT NULL) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'card.move: a personal screen stays on its own, under no project'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2d. Nesting cap (review A26): the card and everything under it
        --     must stay within 14 levels, so every capped parent walk
        --     (depth < 16) reaches the project.
        IF (SELECT count(*) FROM card_ancestors(_new_parent))
           + (WITH RECURSIVE sub(id, depth) AS (
                  SELECT _card_id, 0
                  UNION ALL
                  SELECT c.id, sub.depth + 1 FROM card c JOIN sub ON c.parent_card_id = sub.id
                  WHERE sub.depth < 16)
              SELECT max(depth) FROM sub) >= 14 THEN
            RETURN QUERY SELECT _idx, false, 'too_deep'::text,
                'card.move: cards nest at most 14 deep'::text, NULL::jsonb;
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

        -- 3b'. Out of its project, a card (or one under it) must not be one
        --      its old project still uses: a state a flow names — its
        --      starting state, or a step's from / to — or a card that cards
        --      left behind point at (a milestone, a tag, a component). The
        --      flow and those cards would name another project's card, and
        --      every new task there failed with cross_project_ref (review
        --      2026-11-03 round 5 #5).
        _old_project := card_enclosing_project(_card_id);
        IF _new_project IS DISTINCT FROM _old_project THEN
            _ref_vid := NULL;
            WITH RECURSIVE sub(id, depth) AS (
                SELECT _card_id, 0
                UNION ALL
                SELECT c.id, sub.depth + 1 FROM card c JOIN sub ON c.parent_card_id = sub.id
                WHERE sub.depth < 16
            )
            SELECT s.id INTO _ref_vid FROM sub s
            WHERE EXISTS (SELECT 1 FROM flow f WHERE f.default_create_status_id = s.id)
               OR EXISTS (SELECT 1 FROM flow_step fs WHERE fs.from_card_id = s.id OR fs.to_card_id = s.id)
            LIMIT 1;
            IF _ref_vid IS NOT NULL THEN
                RETURN QUERY SELECT _idx, false, 'value_referenced_by_flow'::text,
                    format('card.move: card %s is a state of a flow in its project; take it out of the flow first', _ref_vid),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            WITH RECURSIVE sub(id, depth) AS (
                SELECT _card_id, 0
                UNION ALL
                SELECT c.id, sub.depth + 1 FROM card c JOIN sub ON c.parent_card_id = sub.id
                WHERE sub.depth < 16
            ),
            referrer AS (
                SELECT av.card_id, s.id AS target
                FROM sub s
                JOIN attribute_value av
                  ON jsonb_typeof(av.value) = 'number' AND (av.value)::text::bigint = s.id
                 AND av.attribute_def_id IN (SELECT id FROM attribute_def WHERE value_type = 'card_ref')
                UNION ALL
                SELECT av.card_id, s.id
                FROM sub s
                JOIN attribute_value av
                  ON jsonb_typeof(av.value) = 'array' AND av.value @> jsonb_build_array(s.id)
                 AND av.attribute_def_id IN (SELECT id FROM attribute_def WHERE value_type = 'card_ref[]')
            )
            SELECT r.target INTO _ref_vid
            FROM referrer r
            JOIN card rc ON rc.id = r.card_id AND rc.deleted_at IS NULL
            WHERE NOT EXISTS (SELECT 1 FROM sub WHERE sub.id = r.card_id)
              AND card_enclosing_project(rc.id) IS NOT DISTINCT FROM _old_project
            LIMIT 1;
            IF _ref_vid IS NOT NULL THEN
                RETURN QUERY SELECT _idx, false, 'value_in_use'::text,
                    format('card.move: card %s is used by cards in its project; change them first', _ref_vid),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 3c. The destination (DI-5): the dispatcher authorized the move
        --     against the card's current project. Into another project the
        --     actor must also be allowed to update this card type there,
        --     and the card's area must be on there (a card moved into an
        --     area that is off would vanish).
        -- Nothing moves into a feature bundle's source project: kitp
        -- rebuilds it from its file and copies it into every project that
        -- applies the bundle, so a card planted there spread to each of
        -- them, or (a task with a file) stopped the rebuild (review
        -- 2026-11-03 round 4 #4). The dispatcher's bundle check sees only
        -- where the card was.
        IF _new_project IS NOT NULL AND EXISTS (SELECT 1 FROM bundle b WHERE b.source_project_id = _new_project) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                format('card.move: project %s is a feature bundle''s source; kitp maintains it', _new_project),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _new_project IS DISTINCT FROM card_enclosing_project(_card_id) THEN
            SELECT name INTO _child_type_name FROM card_type WHERE id = _child_type_id;
            IF NOT user_has_grant(card_move_batch.actor_id, _child_type_name, 'card.update', COALESCE(_new_project, 0)) THEN
                RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                    format('card.move: you can''t move a %s into project %s', _child_type_name, COALESCE(_new_project::text, '0')),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;
        IF area_write_blocked(_child_type_id, _new_parent, COALESCE(_new_project, 0)) THEN
            RETURN QUERY SELECT _idx, false, 'area_off'::text,
                'card.move: the destination is in an area that is switched off'::text,
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

        -- 5. A published page moved (or a card above one) may now be under
        --    another portal's root or none: the portals it is on rebuild,
        --    and serving re-checks the root (portal/serve.go lookup; review
        --    2026-11-03 round 3 #21).
        PERFORM portal_mark_dirty(pp.portal_id) FROM portals_publishing_under(_card_id) pp;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'activity_id', _activity_id::text
            );
    END LOOP;
END;
$$;

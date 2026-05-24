-- copy_project_template — graph-copy a template project's descendant
-- structure (value cards + screens + filters + predicate_snippets, plus
-- the flow / flow_step rows scoped to the template, plus every
-- descendant's attribute_value rows) into a fresh new_project_id.
--
-- This is the PL/pgSQL reflection of projectstamp.go's graph-copy logic
-- (loadDescendants → copy cards → copyFlows → copyFlowSteps →
-- copyAttributeValues / remapAttributeValue). It is called from
-- card_insert_batch.sql when a new project lands; Phase 4 of
-- UNIFIED_HANDLER_PLAN.md will collapse the Go-side project.stamp into
-- this helper so both paths run a single source of truth.
--
-- Deliberately NOT copied (FLOW_AND_SCREEN_KERNEL §"Project templates"):
--   - card_type='task' descendants and their attribute_values
--   - comment_body / activity history
--   - user_card_sort / user_card_agent per-user state
--   - the template's OWN attribute_value rows (is_template / title etc.
--     belong to the template; the new project's title and other own
--     attributes are managed by the caller, e.g. card_insert_batch).
--
-- Predicate-tree remap (filter card `predicate`, screen `toggle_groups`,
-- predicate_snippet `predicate`) walks the JSONB tree via
-- remap_predicate_tree(), rewriting card_ref ids on leaves whose `attr`
-- names a card_ref / card_ref[] attribute. Ported from
-- projectstamp.remapPredicateNode (Phase 4 of UNIFIED_HANDLER_PLAN.md);
-- replaces the earlier `RAISE NOTICE` passthrough.
CREATE OR REPLACE FUNCTION copy_project_template(
    template_id bigint,
    new_project_id bigint,
    actor_id bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    _task_ct_id bigint;
    _src_id bigint;
    _src_ct_id bigint;
    _src_parent_id bigint;
    _src_phase text;
    _mapped_parent bigint;
    _new_id bigint;
    _flow_src_id bigint;
    _flow_name text;
    _flow_doc text;
    _flow_attr_def_id bigint;
    _flow_default_status bigint;
    _flow_new_default bigint;
    _new_flow_id bigint;
    _step_from bigint;
    _step_to bigint;
    _step_label text;
    _step_role_id bigint;
    _step_sort_order int;
    _mapped_from bigint;
    _mapped_to bigint;
    _av_card_id bigint;
    _av_def_id bigint;
    _av_value jsonb;
    _ad_name text;
    _ad_value_type text;
    _new_value jsonb;
    _activity_id bigint;
    _n bigint;
    _mapped bigint;
    _remap_jsonb jsonb;
    _card_ref_attrs text[];
    _inner_text text;
    _parsed jsonb;
    _remapped_inner jsonb;
BEGIN
    -- Per-call temp tables. DROP-then-CREATE so multiple calls within
    -- one tx (e.g. a card.insert batch creating two projects) don't
    -- collide on the table names. ON COMMIT DROP also clears them at
    -- tx end.
    DROP TABLE IF EXISTS _remap;
    DROP TABLE IF EXISTS _flow_remap;
    DROP TABLE IF EXISTS _descendants;
    CREATE TEMP TABLE _remap (
        src_id bigint PRIMARY KEY,
        new_id bigint NOT NULL
    ) ON COMMIT DROP;

    CREATE TEMP TABLE _flow_remap (
        src_flow_id bigint PRIMARY KEY,
        new_flow_id bigint NOT NULL
    ) ON COMMIT DROP;

    -- Track the descendant order (BFS depth then id) so attribute_value
    -- copies replay in the same shape the Go path uses.
    CREATE TEMP TABLE _descendants (
        seq bigserial PRIMARY KEY,
        src_id bigint NOT NULL,
        src_card_type_id bigint NOT NULL,
        src_parent_id bigint,
        src_phase text NOT NULL
    ) ON COMMIT DROP;

    -- Template's own id maps to the new project id; predicate / card_ref
    -- leaves that point at the template directly rewrite to the new
    -- project. (Matches projectstamp.stampOne's seed of remap[template]=new.)
    INSERT INTO _remap (src_id, new_id) VALUES (template_id, new_project_id);

    -- Resolve the task card_type so we can exclude its descendants.
    SELECT id INTO _task_ct_id FROM card_type WHERE name = 'task';
    IF NOT FOUND THEN
        _task_ct_id := 0;
    END IF;

    -- BFS-walk: every non-task non-deleted descendant under template_id.
    INSERT INTO _descendants (src_id, src_card_type_id, src_parent_id, src_phase)
    WITH RECURSIVE walk AS (
        SELECT id, card_type_id, parent_card_id, phase, 1 AS depth
        FROM card
        WHERE parent_card_id = template_id AND deleted_at IS NULL
        UNION ALL
        SELECT c.id, c.card_type_id, c.parent_card_id, c.phase, w.depth + 1
        FROM card c
        JOIN walk w ON w.id = c.parent_card_id
        -- depth < 16 caps the downward tree walk (CLAUDE.md cap; matches
        -- card_ancestors / scopeWalkDepth) so a parent_card_id cycle in
        -- the template can't pin the connection (A1).
        WHERE c.deleted_at IS NULL AND w.depth < 16
    )
    SELECT w.id, w.card_type_id, w.parent_card_id, w.phase
    FROM walk w
    WHERE (_task_ct_id = 0 OR w.card_type_id <> _task_ct_id)
    ORDER BY w.depth, w.id;

    -- Phase A: copy each descendant card row + card_create activity,
    -- building _remap as we go. BFS order guarantees parent is in
    -- _remap before its children land.
    FOR _src_id, _src_ct_id, _src_parent_id, _src_phase IN
        SELECT src_id, src_card_type_id, src_parent_id, src_phase
        FROM _descendants ORDER BY seq
    LOOP
        IF _src_parent_id IS NULL THEN
            _mapped_parent := NULL;
        ELSE
            SELECT new_id INTO _mapped_parent FROM _remap WHERE src_id = _src_parent_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'copy_project_template: descendant % has parent % not in remap', _src_id, _src_parent_id;
            END IF;
        END IF;
        INSERT INTO card (card_type_id, parent_card_id, phase)
        VALUES (_src_ct_id, _mapped_parent, _src_phase)
        RETURNING id INTO _new_id;

        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_new_id, 'card_create', actor_id);

        INSERT INTO _remap (src_id, new_id) VALUES (_src_id, _new_id);
    END LOOP;

    -- Phase B: copy flow rows scoped to the template. flow.attribute_def_id
    -- stays as-is (attribute_defs are global); default_create_status_id
    -- remaps via _remap (when present).
    FOR _flow_src_id, _flow_name, _flow_doc, _flow_attr_def_id, _flow_default_status IN
        SELECT id, name, doc, attribute_def_id, default_create_status_id
        FROM flow WHERE scope_card_id = template_id
    LOOP
        _flow_new_default := NULL;
        IF _flow_default_status IS NOT NULL THEN
            SELECT new_id INTO _flow_new_default FROM _remap WHERE src_id = _flow_default_status;
            -- If the default points outside the template's value cards
            -- (cross-project / system default), leave NULL — the admin
            -- can fix it post-copy. Matches the Go behaviour.
        END IF;
        INSERT INTO flow (name, doc, attribute_def_id, scope_card_id, default_create_status_id)
        VALUES (_flow_name, _flow_doc, _flow_attr_def_id, new_project_id, _flow_new_default)
        RETURNING id INTO _new_flow_id;
        INSERT INTO _flow_remap (src_flow_id, new_flow_id) VALUES (_flow_src_id, _new_flow_id);
    END LOOP;

    -- Phase C: copy flow_step rows under every remapped flow. from/to
    -- remap via _remap; requires_role_id stays (roles are install-global).
    FOR _flow_src_id, _new_flow_id IN
        SELECT src_flow_id, new_flow_id FROM _flow_remap
    LOOP
        FOR _step_from, _step_to, _step_label, _step_role_id, _step_sort_order IN
            SELECT from_card_id, to_card_id, label, requires_role_id, sort_order
            FROM flow_step WHERE flow_id = _flow_src_id
        LOOP
            SELECT new_id INTO _mapped_from FROM _remap WHERE src_id = _step_from;
            IF NOT FOUND THEN
                CONTINUE;
            END IF;
            SELECT new_id INTO _mapped_to FROM _remap WHERE src_id = _step_to;
            IF NOT FOUND THEN
                CONTINUE;
            END IF;
            INSERT INTO flow_step (flow_id, from_card_id, to_card_id, label, requires_role_id, sort_order)
            VALUES (_new_flow_id, _mapped_from, _mapped_to, _step_label, _step_role_id, _step_sort_order);
        END LOOP;
    END LOOP;

    -- Build the JSONB-form remap object and the card_ref attribute-name
    -- list once before Phase D; remap_predicate_tree() expects both.
    SELECT COALESCE(jsonb_object_agg(src_id::text, new_id), '{}'::jsonb)
      INTO _remap_jsonb
    FROM _remap;
    SELECT COALESCE(array_agg(name), ARRAY[]::text[]) INTO _card_ref_attrs
    FROM attribute_def
    WHERE value_type IN ('card_ref', 'card_ref[]');

    -- Phase D: copy attribute_value rows for every descendant. Per
    -- (attribute_def.name, attribute_def.value_type) the value may need
    -- remapping:
    --   - value_type='card_ref'  → remap bigint via _remap (passthrough on miss)
    --   - value_type='card_ref[]' → walk JSONB array, remap each element
    --   - attribute name='flow_ref' (value_type='number') → remap via _flow_remap
    --   - attribute name IN ('predicate','toggle_groups') → walk predicate
    --     tree via remap_predicate_tree(), rewriting card_ref leaf values
    --     via _remap_jsonb. Stored as a JSONB-string-of-JSON (text
    --     value_type), so unwrap the outer string layer before recursing.
    --   - everything else → verbatim copy
    FOR _av_card_id, _av_def_id, _av_value IN
        SELECT av.card_id, av.attribute_def_id, av.value
        FROM attribute_value av
        JOIN _remap r ON r.src_id = av.card_id
        WHERE av.card_id <> template_id  -- skip the template's OWN attrs
        ORDER BY av.card_id, av.attribute_def_id
    LOOP
        SELECT name, value_type INTO _ad_name, _ad_value_type
        FROM attribute_def WHERE id = _av_def_id;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;

        _new_value := _av_value;

        IF _ad_name = 'flow_ref' THEN
            -- Stored as a JSON number = flow id; remap when present.
            IF jsonb_typeof(_av_value) = 'number' THEN
                _n := (_av_value)::text::bigint;
                SELECT new_flow_id INTO _mapped FROM _flow_remap WHERE src_flow_id = _n;
                IF FOUND THEN
                    _new_value := to_jsonb(_mapped);
                END IF;
            END IF;
        ELSIF _ad_name IN ('predicate', 'toggle_groups') THEN
            -- Predicate-tree remap. The value is stored as a JSONB string
            -- containing a JSON-encoded predicate tree (or array, for
            -- toggle_groups). Unwrap the outer string, walk the tree via
            -- remap_predicate_tree(), then re-wrap as a JSONB string so
            -- the on-disk shape is preserved.
            IF _av_value IS NOT NULL AND jsonb_typeof(_av_value) <> 'null' THEN
                IF jsonb_typeof(_av_value) = 'string' THEN
                    _inner_text := _av_value #>> '{}';
                    BEGIN
                        _parsed := _inner_text::jsonb;
                    EXCEPTION WHEN others THEN
                        _parsed := NULL;
                    END;
                    IF _parsed IS NOT NULL THEN
                        _remapped_inner := remap_predicate_tree(_parsed, _remap_jsonb, _card_ref_attrs);
                        _new_value := to_jsonb(_remapped_inner::text);
                    END IF;
                ELSE
                    -- Defensive: a future caller might store the predicate
                    -- as a raw JSON object (not string-wrapped). Walk it
                    -- directly.
                    _new_value := remap_predicate_tree(_av_value, _remap_jsonb, _card_ref_attrs);
                END IF;
            END IF;
        ELSIF _ad_value_type = 'card_ref' THEN
            IF jsonb_typeof(_av_value) = 'number' THEN
                _n := (_av_value)::text::bigint;
                SELECT new_id INTO _mapped FROM _remap WHERE src_id = _n;
                IF FOUND THEN
                    _new_value := to_jsonb(_mapped);
                END IF;
            ELSIF jsonb_typeof(_av_value) = 'string'
                  AND (_av_value #>> '{}') ~ '^-?\d+$' THEN
                _n := (_av_value #>> '{}')::bigint;
                SELECT new_id INTO _mapped FROM _remap WHERE src_id = _n;
                IF FOUND THEN
                    _new_value := to_jsonb(_mapped);
                END IF;
            END IF;
        ELSIF _ad_value_type = 'card_ref[]' THEN
            IF jsonb_typeof(_av_value) = 'array' THEN
                -- Map each element: numeric / string-of-digits → remap
                -- via _remap; anything else passthrough.
                SELECT COALESCE(jsonb_agg(
                    CASE
                        WHEN jsonb_typeof(e.v) = 'number'
                             AND (SELECT new_id FROM _remap WHERE src_id = ((e.v)::text::bigint)) IS NOT NULL
                            THEN to_jsonb((SELECT new_id FROM _remap WHERE src_id = ((e.v)::text::bigint)))
                        WHEN jsonb_typeof(e.v) = 'string'
                             AND (e.v #>> '{}') ~ '^-?\d+$'
                             AND (SELECT new_id FROM _remap WHERE src_id = ((e.v #>> '{}')::bigint)) IS NOT NULL
                            THEN to_jsonb((SELECT new_id FROM _remap WHERE src_id = ((e.v #>> '{}')::bigint)))
                        ELSE e.v
                    END
                    ORDER BY e.ord), '[]'::jsonb)
                INTO _new_value
                FROM jsonb_array_elements(_av_value) WITH ORDINALITY AS e(v, ord);
            END IF;
        END IF;

        -- Look up the remapped card id for this attribute_value.
        SELECT new_id INTO _new_id FROM _remap WHERE src_id = _av_card_id;

        -- Emit attr_update activity row + attribute_value upsert
        -- (same shape as projectstamp.writeAttributeValue and
        --  card/screen_seed writeAttr).
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_new_id, 'attr_update', _av_def_id, NULL, _new_value, actor_id)
        RETURNING id INTO _activity_id;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_new_id, _av_def_id, _new_value, _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;
    END LOOP;
END;
$$;

-- flow_step.list_for_card handler (Phase 5 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runStepListForCard + projectIDForCard +
-- listAvailableTransitions into one PL/pgSQL body. The same shape is
-- reused by Gate 5's attribute.update rejection envelope via the
-- existing build_flow_available_array helper, but this read-side
-- handler exposes the full AvailableTransition row (from/to label +
-- phase, requires_role name, per-actor allowed bit), not just the
-- compact "available[]" V13 shape.
--
-- Per-row pipeline:
--   1. Presence check (card_id required).
--   2. WITH RECURSIVE walk parent_card_id upward to find the first
--      ancestor (including the card itself) whose card_type is
--      'project'. Cap at depth 16 to match scopeWalkDepth.
--      No enclosing project ⇒ empty result (no flows can apply).
--   3. JOIN flow / attribute_def / attribute_value (card-ref value
--      pointing at flow_step.from_card_id) / flow_step / from+to cards
--      / titles. The 'allowed' bit applies the F-ROLE auth model:
--      requires_role_id IS NULL OR actor has 'system' globally OR
--      actor has the role globally or scoped to the project.
--
-- Authz (RoleAuthenticated) runs pre-tx in Go.
--
-- Result JSON shape matches `flow.ListForCardOutput`:
--   {"rows": [{"id": "<bigint>", "flow_id": "<bigint>", "flow_name": ...,
--             "attribute_def_id": "<bigint>", "attribute_def_name": ...,
--             "from_card_id": "<bigint>", "from_label": ..., "from_phase": ...,
--             "to_card_id":   "<bigint>", "to_label":   ..., "to_phase":   ...,
--             "label": ..., "requires_role_id": "<bigint>",
--             "requires_role_name": ..., "sort_order": <int>,
--             "allowed": <bool>}]}
CREATE OR REPLACE FUNCTION flow_step_list_for_card_batch(
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
    _card_id bigint;
    _project_id bigint;
    _payload jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _card_id := COALESCE(NULLIF(_raw->>'card_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _card_id := 0;
        END;

        IF _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'flow_step.list_for_card: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- Resolve the enclosing project. depth < 16 matches
        -- internal/api/authz.go's scopeWalkDepth (CLAUDE.md rule).
        WITH RECURSIVE chain AS (
            SELECT id, parent_card_id, card_type_id, 0 AS depth
            FROM card WHERE id = _card_id
            UNION ALL
            SELECT c.id, c.parent_card_id, c.card_type_id, ch.depth + 1
            FROM card c
            JOIN chain ch ON ch.parent_card_id = c.id
            WHERE ch.depth < 16
        )
        SELECT chain.id INTO _project_id
        FROM chain
        JOIN card_type ct ON ct.id = chain.card_type_id
        WHERE ct.name = 'project'
        LIMIT 1;

        IF _project_id IS NULL THEN
            -- Orphan / root card → no project-scoped flows apply.
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('rows', '[]'::jsonb);
            CONTINUE;
        END IF;

        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',                 fs.id::text,
                    'flow_id',            fs.flow_id::text,
                    'flow_name',          f.name,
                    'attribute_def_id',   f.attribute_def_id::text,
                    'attribute_def_name', ad.name,
                    'from_card_id',       fs.from_card_id::text,
                    'from_label',         COALESCE(av_from_title.value #>> '{}', ''),
                    'from_phase',         fc.phase,
                    'to_card_id',         fs.to_card_id::text,
                    'to_label',           COALESCE(av_to_title.value #>> '{}', ''),
                    'to_phase',           tc.phase,
                    'label',              fs.label,
                    'requires_role_id',   COALESCE(fs.requires_role_id, 0)::text,
                    'requires_role_name', COALESCE(r.name, ''),
                    'sort_order',         fs.sort_order,
                    'standalone',         fs.standalone,
                    'allowed', (
                        fs.requires_role_id IS NULL
                        OR EXISTS (
                            SELECT 1 FROM user_role ur
                            JOIN role sr ON sr.id = ur.role_id
                            WHERE ur.user_id = flow_step_list_for_card_batch.actor_id
                              AND sr.name = 'system'
                              AND ur.scope_card_id IS NULL
                        )
                        OR EXISTS (
                            SELECT 1 FROM user_role ur
                            WHERE ur.user_id = flow_step_list_for_card_batch.actor_id
                              AND ur.role_id = fs.requires_role_id
                              AND (ur.scope_card_id IS NULL OR ur.scope_card_id = _project_id)
                        )
                    )
                ) ORDER BY ad.name, fs.sort_order, fs.label, fs.id
            )
            FROM flow f
            JOIN attribute_def ad ON ad.id = f.attribute_def_id
            JOIN attribute_value av
              ON av.card_id = _card_id
             AND av.attribute_def_id = f.attribute_def_id
             AND jsonb_typeof(av.value) = 'number'
            JOIN flow_step fs
              ON fs.flow_id = f.id
             AND fs.from_card_id = (av.value)::text::bigint
            JOIN card fc ON fc.id = fs.from_card_id AND fc.deleted_at IS NULL
            JOIN card tc ON tc.id = fs.to_card_id   AND tc.deleted_at IS NULL
            LEFT JOIN role r ON r.id = fs.requires_role_id
            LEFT JOIN attribute_def ad_title ON ad_title.name = 'title'
            LEFT JOIN attribute_value av_from_title
              ON av_from_title.card_id          = fs.from_card_id
             AND av_from_title.attribute_def_id = ad_title.id
            LEFT JOIN attribute_value av_to_title
              ON av_to_title.card_id          = fs.to_card_id
             AND av_to_title.attribute_def_id = ad_title.id
            WHERE f.scope_card_id = _project_id
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

-- card.insert handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runInsert into one PL/pgSQL body.
--
-- Per-row pipeline (each input is one new card):
--   1. Decode + cheap presence checks (card_type_name, title).
--   2. Resolve card_type by name; reject unknown.
--   3. Parent rules: either no parent (top-level cards), or parent
--      must exist + its card_type must be allowed under the child's
--      parent_card_type_id (or self when allow_self_parent).
--   4. Phase validation when supplied (triage|active|terminal).
--   5. Required-edge presence: every is_required edge for this
--      card_type must appear in the supplied attributes (title is
--      always written, so the loop catches non-title required edges,
--      e.g. (task, status)). Missing required attribute → edge_violation.
--   6. Per-project scope: card_ref / card_ref[] initial attribute
--      values must point at cards under the new card's enclosing
--      project, or be global. Top-level inserts skip this (their
--      enclosing project doesn't exist yet).
--   7. INSERT card row, INSERT card_create activity, then for the
--      title + each initial attribute INSERT attr_update activity +
--      UPSERT attribute_value.
--   8. Per-card_type post-insert hook for projects: graph-copy the
--      standard template (is_template=true project) via
--      copy_project_template. The template owns the full default set
--      (status value-cards, screens, filters, predicate_snippets, flows,
--      flow_steps) — copying it is the one source of truth shared with
--      project.stamp (Phase 4 collapses both onto this helper).
--
-- Result JSON shape matches `card.InsertOutput`:
--   {"id": "<bigint>"}
-- The bigint id is cast to text because Go's struct uses
-- `json:",string"` (wire convention for 64-bit ids).
CREATE OR REPLACE FUNCTION card_insert_batch(
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
    _card_type_name text;
    _parent_card_id bigint;
    _has_parent boolean;
    _title text;
    _phase text;
    _attrs jsonb;
    _card_type_id bigint;
    _allow_self_parent boolean;
    _parent_required boolean;
    _parent_required_type bigint;
    _parent_type_id bigint;
    _parent_ok boolean;
    _parent_type_name text;
    _new_card_id bigint;
    _activity_id bigint;
    _title_def_id bigint;
    _title_required boolean;
    _attr_name text;
    _attr_value jsonb;
    _attr_def_id bigint;
    _attr_value_type text;
    _attr_target_type bigint;
    _attr_is_required boolean;
    _value_norm jsonb;
    _value_card_ids bigint[];
    _v bigint;
    _vproj bigint;
    _vct bigint;
    _enclosing_project bigint;
    _rej_code text;
    _rej_msg text;
    _missing_attr text;
    _template_id bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _card_type_name := _raw->>'card_type_name';
        BEGIN
            _parent_card_id := NULLIF(_raw->>'parent_card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _parent_card_id := NULL;
        END;
        _has_parent := _parent_card_id IS NOT NULL;
        _title := _raw->>'title';
        _phase := COALESCE(_raw->>'phase', '');
        _attrs := COALESCE(_raw->'attributes', '{}'::jsonb);

        -- 1. Resolve card_type.
        SELECT ct.id, ct.allow_self_parent,
               ct.parent_card_type_id IS NOT NULL,
               ct.parent_card_type_id
          INTO _card_type_id, _allow_self_parent,
               _parent_required, _parent_required_type
        FROM card_type ct
        WHERE ct.name = _card_type_name;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'unknown_card_type'::text,
                format('card.insert: unknown card_type_name %L', _card_type_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Title required.
        IF _title IS NULL OR _title = '' THEN
            RETURN QUERY SELECT _idx, false, 'missing_required'::text,
                'card.insert: title is required (built-in edge)'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Parent rules.
        IF NOT _has_parent THEN
            IF _parent_required THEN
                RETURN QUERY SELECT _idx, false, 'edge_violation'::text,
                    format('card.insert: card_type %L requires a parent', _card_type_name),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        ELSE
            SELECT card_type_id INTO _parent_type_id
            FROM card WHERE id = _parent_card_id;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'parent_not_found'::text,
                    format('card.insert: parent_card_id %s not found', _parent_card_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            _parent_ok := false;
            IF _allow_self_parent AND _parent_type_id = _card_type_id THEN
                _parent_ok := true;
            ELSIF _parent_required_type IS NOT NULL AND _parent_type_id = _parent_required_type THEN
                _parent_ok := true;
            END IF;
            IF NOT _parent_ok THEN
                SELECT name INTO _parent_type_name FROM card_type WHERE id = _parent_type_id;
                RETURN QUERY SELECT _idx, false, 'edge_violation'::text,
                    format('card.insert: card_type %L is not allowed under parent type %L',
                        _card_type_name, COALESCE(_parent_type_name, '?')),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 4. Phase validation.
        IF _phase <> '' AND _phase NOT IN ('triage', 'active', 'terminal') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('card.insert: phase %L: must be triage|active|terminal', _phase),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 5. Title edge must exist on this card_type.
        SELECT ad.id INTO _title_def_id
        FROM attribute_def ad
        JOIN edge e ON e.attribute_def_id = ad.id
        WHERE ad.name = 'title' AND e.card_type_id = _card_type_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'internal'::text,
                format('card.insert: card_type %L lacks a title edge', _card_type_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 6. Verify every supplied attribute is allowed on this card_type
        --    (drop "title" from the supplied map since we write it from
        --    the dedicated Title field). Reject unknown / disallowed
        --    attributes with edge_violation so the row never lands.
        _rej_code := NULL;
        _rej_msg := NULL;
        FOR _attr_name, _attr_value IN
            SELECT key, value FROM jsonb_each(_attrs)
        LOOP
            IF _attr_name = 'title' THEN
                CONTINUE;
            END IF;
            PERFORM 1
            FROM attribute_def ad
            JOIN edge e ON e.attribute_def_id = ad.id
            WHERE ad.name = _attr_name AND e.card_type_id = _card_type_id;
            IF NOT FOUND THEN
                _rej_code := 'edge_violation';
                _rej_msg := format('card.insert: attribute %L is not allowed on card_type %L',
                    _attr_name, _card_type_name);
                EXIT;
            END IF;
        END LOOP;
        IF _rej_code IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false, _rej_code, _rej_msg, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 7. Required-edge presence (Gate 6). For every is_required edge,
        --    a non-null value must be present in the supplied attributes
        --    OR be the title (always present by this point). When a
        --    required attribute is absent, before rejecting we check
        --    whether the enclosing project has a flow with a
        --    default_create_status_id bound to that attribute_def — if
        --    so, we splice that default into _attrs and proceed. Lets
        --    callers omit `status` on task inserts and get the project's
        --    configured starting status without a separate lookup hop.
        _missing_attr := NULL;
        FOR _attr_name IN
            SELECT ad.name
            FROM edge e
            JOIN attribute_def ad ON ad.id = e.attribute_def_id
            WHERE e.card_type_id = _card_type_id AND e.is_required = true
            ORDER BY e.ordering, ad.id
        LOOP
            IF _attr_name = 'title' THEN
                CONTINUE;
            END IF;
            -- Present + non-null in supplied attributes → OK.
            IF _attrs ? _attr_name
               AND _attrs->_attr_name IS NOT NULL
               AND jsonb_typeof(_attrs->_attr_name) <> 'null' THEN
                CONTINUE;
            END IF;
            -- Explicit null is a deliberate opt-out and stays rejected;
            -- only the truly-absent case falls through to the flow
            -- default. (Caller passing {"status": null} explicitly
            -- signals "no status, please reject" rather than
            -- "give me the default.")
            IF NOT _attrs ? _attr_name THEN
                DECLARE
                    _proj bigint;
                    _default_value bigint;
                BEGIN
                    -- Enclosing project via the shared capped helper (A1/A10).
                    _proj := card_enclosing_project(_parent_card_id);
                    IF _proj IS NOT NULL THEN
                        SELECT f.default_create_status_id INTO _default_value
                        FROM flow f
                        JOIN attribute_def ad ON ad.id = f.attribute_def_id
                        WHERE f.scope_card_id = _proj
                          AND ad.name = _attr_name
                          AND f.default_create_status_id IS NOT NULL
                        LIMIT 1;
                        IF _default_value IS NOT NULL THEN
                            _attrs := _attrs || jsonb_build_object(_attr_name, to_jsonb(_default_value));
                            CONTINUE;
                        END IF;
                    END IF;
                END;
            END IF;
            _missing_attr := _attr_name;
            EXIT;
        END LOOP;
        IF _missing_attr IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false, 'edge_violation'::text,
                format('card.insert: attribute %L is required on card_type %L',
                    _missing_attr, _card_type_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 8. Per-project scope check for card_ref / card_ref[] initial
        --    values. Only runs when the new card has a parent (top-level
        --    cards have no enclosing project to clash with).
        IF _has_parent THEN
            -- Resolve enclosing project (NULL when none) via the shared
            -- capped helper (A1/A10).
            _enclosing_project := card_enclosing_project(_parent_card_id);

            _rej_code := NULL;
            FOR _attr_name, _attr_value IN
                SELECT key, value FROM jsonb_each(_attrs)
            LOOP
                IF _attr_name = 'title' THEN
                    CONTINUE;
                END IF;
                SELECT ad.value_type, COALESCE(ad.target_card_type_id, 0)
                  INTO _attr_value_type, _attr_target_type
                FROM attribute_def ad
                WHERE ad.name = _attr_name;
                IF NOT FOUND OR _attr_value_type NOT IN ('card_ref', 'card_ref[]') THEN
                    CONTINUE;
                END IF;
                IF _attr_value IS NULL OR jsonb_typeof(_attr_value) = 'null' THEN
                    CONTINUE;
                END IF;
                -- Build value_card_ids list. Reject malformed shapes.
                _value_card_ids := ARRAY[]::bigint[];
                IF _attr_value_type = 'card_ref' THEN
                    IF jsonb_typeof(_attr_value) = 'number' THEN
                        _value_card_ids := ARRAY[(_attr_value)::text::bigint];
                    ELSIF jsonb_typeof(_attr_value) = 'string'
                          AND (_attr_value #>> '{}') ~ '^-?\d+$' THEN
                        _value_card_ids := ARRAY[((_attr_value #>> '{}')::bigint)];
                    ELSE
                        _rej_code := 'validation';
                        _rej_msg := format('card.insert: %s: card_ref value not a number or numeric string: %s',
                            _attr_name, _attr_value::text);
                        EXIT;
                    END IF;
                ELSE
                    -- card_ref[]
                    IF jsonb_typeof(_attr_value) <> 'array' THEN
                        _rej_code := 'validation';
                        _rej_msg := format('card.insert: %s: value must be a JSON array of card ids', _attr_name);
                        EXIT;
                    END IF;
                    DECLARE
                        _el jsonb;
                    BEGIN
                        FOR _el IN SELECT e.v FROM jsonb_array_elements(_attr_value) AS e(v) LOOP
                            IF jsonb_typeof(_el) = 'number' THEN
                                _value_card_ids := array_append(_value_card_ids, (_el)::text::bigint);
                            ELSIF jsonb_typeof(_el) = 'string'
                                  AND (_el #>> '{}') ~ '^-?\d+$' THEN
                                _value_card_ids := array_append(_value_card_ids, ((_el #>> '{}')::bigint));
                            ELSE
                                _rej_code := 'validation';
                                _rej_msg := format('card.insert: %s: card_ref value not a number or numeric string: %s',
                                    _attr_name, _el::text);
                                EXIT;
                            END IF;
                        END LOOP;
                    END;
                    IF _rej_code IS NOT NULL THEN
                        EXIT;
                    END IF;
                END IF;
                -- Per-value walk.
                FOREACH _v IN ARRAY _value_card_ids LOOP
                    IF _v = 0 THEN
                        CONTINUE;
                    END IF;
                    SELECT card_type_id INTO _vct FROM card WHERE id = _v;
                    IF NOT FOUND THEN
                        _rej_code := 'cross_project_ref';
                        _rej_msg := format('attribute %L: value card %s does not exist', _attr_name, _v);
                        EXIT;
                    END IF;
                    IF _attr_target_type <> 0 AND _vct <> _attr_target_type THEN
                        _rej_code := 'cross_project_ref';
                        _rej_msg := format('attribute %L: value card %s is not of the expected card type',
                            _attr_name, _v);
                        EXIT;
                    END IF;
                    -- Value's enclosing project via the shared capped
                    -- helper (A1/A10); NULL → global.
                    _vproj := card_enclosing_project(_v);
                    -- Global value is a wildcard.
                    IF _vproj IS NULL THEN
                        CONTINUE;
                    END IF;
                    IF _enclosing_project IS NULL OR _vproj <> _enclosing_project THEN
                        _rej_code := 'cross_project_ref';
                        _rej_msg := format(
                            'attribute %L: value card %s belongs to project %s but target is in project %s',
                            _attr_name, _v, _vproj, COALESCE(_enclosing_project::text, '0'));
                        EXIT;
                    END IF;
                END LOOP;
                IF _rej_code IS NOT NULL THEN
                    EXIT;
                END IF;
            END LOOP;
            IF _rej_code IS NOT NULL THEN
                RETURN QUERY SELECT _idx, false, _rej_code, _rej_msg, NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 9. Write.
        INSERT INTO card (card_type_id, parent_card_id, phase)
        VALUES (_card_type_id, _parent_card_id, COALESCE(NULLIF(_phase, ''), 'triage'))
        RETURNING id INTO _new_card_id;

        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_new_card_id, 'card_create', actor_id);

        -- Title attribute write.
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_new_card_id, 'attr_update', _title_def_id, NULL, to_jsonb(_title), actor_id)
        RETURNING id INTO _activity_id;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_new_card_id, _title_def_id, to_jsonb(_title), _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- Remaining attributes (canonicalising card_ref / card_ref[]
        -- string-form ids to JSON numbers so seed-numeric reads match).
        FOR _attr_name, _attr_value IN
            SELECT key, value FROM jsonb_each(_attrs)
        LOOP
            IF _attr_name = 'title' THEN
                CONTINUE;
            END IF;
            IF _attr_value IS NULL OR jsonb_typeof(_attr_value) = 'null' THEN
                CONTINUE;
            END IF;
            SELECT ad.id, ad.value_type INTO _attr_def_id, _attr_value_type
            FROM attribute_def ad WHERE ad.name = _attr_name;
            IF _attr_value_type = 'card_ref' THEN
                IF jsonb_typeof(_attr_value) = 'string'
                   AND (_attr_value #>> '{}') ~ '^-?\d+$' THEN
                    _value_norm := to_jsonb(((_attr_value #>> '{}')::bigint));
                ELSE
                    _value_norm := _attr_value;
                END IF;
            ELSIF _attr_value_type = 'card_ref[]' THEN
                SELECT COALESCE(jsonb_agg(
                           CASE
                             WHEN jsonb_typeof(e.v) = 'string'
                                  AND (e.v #>> '{}') ~ '^-?\d+$'
                               THEN to_jsonb(((e.v #>> '{}')::bigint))
                             ELSE e.v
                           END
                           ORDER BY e.ord), '[]'::jsonb)
                  INTO _value_norm
                  FROM jsonb_array_elements(_attr_value) WITH ORDINALITY AS e(v, ord);
            ELSE
                _value_norm := _attr_value;
            END IF;
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (_new_card_id, 'attr_update', _attr_def_id, NULL, _value_norm, actor_id)
            RETURNING id INTO _activity_id;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (_new_card_id, _attr_def_id, _value_norm, _activity_id)
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value,
                    last_activity_id = EXCLUDED.last_activity_id;
        END LOOP;

        -- 10. Per-card_type hook: graph-copy the standard template
        --     (is_template=true project) into the new project. The
        --     template owns the canonical default set — status value
        --     cards, screens, filters, predicate_snippets, flow rows,
        --     flow_step rows — so this is the one source of truth that
        --     project.stamp (Phase 4) will collapse onto too. When no
        --     template exists (fresh DB before the install seed lands),
        --     the new project is bare; fixtures that need a populated
        --     project should run after the install seed or use a
        --     hand-rolled card-tree.
        -- Skip the auto-stamp when the new project IS ITSELF a template
        -- (is_template=true in the insert attrs): a template is created blank
        -- so it doesn't inherit the standard template's structure. Real
        -- projects (is_template absent / false) still get the standard template.
        IF _card_type_name = 'project'
           AND COALESCE((_attrs->>'is_template')::boolean, FALSE) = FALSE THEN
            SELECT av.card_id INTO _template_id
            FROM attribute_value av
            JOIN attribute_def ad ON ad.id = av.attribute_def_id
            JOIN card c ON c.id = av.card_id
            JOIN card_type ct ON ct.id = c.card_type_id
            WHERE ad.name = 'is_template'
              AND av.value = to_jsonb(TRUE)
              AND ct.name = 'project'
              AND c.deleted_at IS NULL
              AND c.id <> _new_card_id
            ORDER BY av.card_id
            LIMIT 1;
            IF FOUND AND _template_id IS NOT NULL THEN
                PERFORM copy_project_template(_template_id, _new_card_id, actor_id);
            END IF;
        END IF;

        -- 11. assign_to_me hook: the single-call "put it in my inbox"
        --     ergonomic. Agents self-route via user_card_agent (keyed
        --     on the parent so routed_to_me picks the row up); humans
        --     linked to a person card get `assignee` set to that
        --     card. Anything else is a silent no-op (e.g. a login-only
        --     human with no person link) — better than erroring out
        --     mid-insert and rolling back the whole row.
        IF COALESCE((_raw->>'assign_to_me')::boolean, false) THEN
            DECLARE
                _actor_is_agent boolean;
                _actor_parent_id bigint;
                _actor_person_id bigint;
                _assignee_def_id bigint;
                _route_activity_id bigint;
            BEGIN
                SELECT is_agent, parent_user_id
                INTO _actor_is_agent, _actor_parent_id
                FROM user_account WHERE id = actor_id;
                IF _actor_is_agent AND _actor_parent_id IS NOT NULL THEN
                    INSERT INTO user_card_agent (user_id, card_id, agent_user_id)
                    VALUES (_actor_parent_id, _new_card_id, actor_id)
                    ON CONFLICT (user_id, card_id) DO UPDATE
                        SET agent_user_id = EXCLUDED.agent_user_id;
                ELSE
                    SELECT card_id INTO _actor_person_id
                    FROM user_account_person WHERE user_account_id = actor_id;
                    IF _actor_person_id IS NOT NULL THEN
                        SELECT id INTO _assignee_def_id
                        FROM attribute_def WHERE name = 'assignee';
                        IF _assignee_def_id IS NOT NULL THEN
                            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                            VALUES (_new_card_id, 'attr_update', _assignee_def_id, NULL,
                                    to_jsonb(_actor_person_id), actor_id)
                            RETURNING id INTO _route_activity_id;
                            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                            VALUES (_new_card_id, _assignee_def_id,
                                    to_jsonb(_actor_person_id), _route_activity_id)
                            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                                SET value = EXCLUDED.value,
                                    last_activity_id = EXCLUDED.last_activity_id;
                        END IF;
                    END IF;
                END IF;
            END;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('id', _new_card_id::text);
    END LOOP;
END;
$$;

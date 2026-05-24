-- attribute.update handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side validateUpdate + runUpdate into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Existence: card must live, edge (card_type, attribute_def) must
--      be declared. Failures → 'card_not_found' / 'edge_violation'.
--   2. Required-removal guard: a JSON null payload on an is_required
--      edge → 'edge_violation' (same code the Go path used; "required
--      and cannot be removed").
--   3. card_ref / card_ref[] canonicalisation: the dispatcher's wire
--      convention serialises bigint ids as JSON strings, but seed rows
--      and the read path store / expect JSON numbers. The CASE arms
--      canonicalise to numeric jsonb before the UPSERT so equality
--      filters match regardless of write origin.
--   4. Project-scope check: every card_ref / card_ref[] value must
--      either be global (no enclosing project — e.g. person) or share
--      the target card's enclosing project. Resolves the enclosing
--      project via the shared capped card_enclosing_project helper
--      (A1/A10). The target_card_type_id contract is also enforced —
--      e.g. milestone_ref must point at a milestone card. Failures →
--      'cross_project_ref'.
--   5. Screen uniqueness: for slug / hotkey on screen cards, no other
--      screen under the same project may hold the same value. slug
--      additionally validates ^[a-z][a-z0-9-]*$. Failures →
--      'slug_invalid' / 'slug_in_use' / 'hotkey_in_use'.
--   6. Flow gate (card_ref only): when a flow row binds
--      (attribute_def, enclosing project), require a flow_step from
--      prev→new. Missing step → 'flow_disallowed'. Step present but
--      step.requires_role_id not satisfied → 'flow_role_required'.
--      Missing prev value on a flow-bound attribute → 'flow_invariant'.
--      NB: the legacy Go path attached a structured Detail JSON with
--      from / attempted_to / available[]. The unified contract drops
--      per-error Detail; the code + message survive.
--   7. Activity row + attribute_value upsert. activity.id is the
--      result's activity_id; the prior attribute_value.value (NULL on
--      first set) becomes prev_value.
--
-- Result JSON shape matches `attribute.UpdateOutput`:
--   {"ok": true, "activity_id": "123", "prev_value": <jsonb>?}
-- prev_value is omitted when there was no prior row (matches the
-- struct's `omitempty`). bigint ids are cast to text per the wire
-- convention.
CREATE OR REPLACE FUNCTION attribute_update_batch(
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
    _attr_name text;
    _value jsonb;
    _value_norm jsonb;
    _card_type_id bigint;
    _attr_def_id bigint;
    _is_required boolean;
    _value_type text;
    _target_card_type_id bigint;
    _value_card_ids bigint[];
    _target_project_id bigint;
    _v bigint;
    _vproj bigint;
    _vexists boolean;
    _vct bigint;
    _slug_re constant text := '^[a-z][a-z0-9-]*$';
    _parent_card_id bigint;
    _card_type_name text;
    _candidate text;
    _conflict_label text;
    _flow_id bigint;
    _prev_id bigint;
    _new_id bigint;
    _step_id bigint;
    _requires_role_id bigint;
    _role_name text;
    _role_ok boolean;
    _activity_id bigint;
    _prev_value jsonb;
    _detail jsonb;
    _from jsonb;
    _attempted_to jsonb;
    _available jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1a. Decode + cheap presence checks.
        BEGIN
            _card_id := NULLIF(_raw->>'card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _card_id := NULL;
        END;
        _attr_name := _raw->>'attribute_name';
        _value := _raw->'value';

        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attribute.update: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _attr_name IS NULL OR _attr_name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attribute.update: attribute_name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 1b. Card existence.
        SELECT card_type_id INTO _card_type_id FROM card WHERE id = _card_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('attribute.update: card %s not found', _card_id), NULL::jsonb;
            CONTINUE;
        END IF;

        -- 1c. Edge existence + pick up value_type / is_required /
        --     target_card_type_id in one shot.
        SELECT ad.id, e.is_required, ad.value_type, ad.target_card_type_id
          INTO _attr_def_id, _is_required, _value_type, _target_card_type_id
        FROM attribute_def ad
        JOIN edge e ON e.attribute_def_id = ad.id
        WHERE ad.name = _attr_name AND e.card_type_id = _card_type_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'edge_violation'::text,
                format('attribute.update: attribute %L is not allowed on this card type', _attr_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Required-removal guard. Absent value or literal null both
        --    count as removal; matches the Go isJSONNull helper.
        IF _value IS NULL OR jsonb_typeof(_value) = 'null' THEN
            IF _is_required THEN
                RETURN QUERY SELECT _idx, false, 'edge_violation'::text,
                    format('attribute.update: attribute %L is required and cannot be removed', _attr_name),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            -- Removal: the canonical stored form is the JSON null
            -- literal so the upsert path is uniform with non-null sets.
            _value_norm := 'null'::jsonb;
            _value_card_ids := ARRAY[]::bigint[];
        ELSIF _value_type = 'card_ref' THEN
            -- card_ref: accept JSON number or numeric-string. Reject
            -- anything else with a validation error mirroring the Go
            -- ParseCardRefValue diagnostic ("milestone_ref: card_ref
            -- value not a number or numeric string: …").
            IF jsonb_typeof(_value) = 'number' THEN
                _value_card_ids := ARRAY[(_value)::text::bigint];
                _value_norm := _value;
            ELSIF jsonb_typeof(_value) = 'string'
                  AND (_value #>> '{}') ~ '^-?\d+$' THEN
                _value_card_ids := ARRAY[((_value #>> '{}')::bigint)];
                _value_norm := to_jsonb(((_value #>> '{}')::bigint));
            ELSE
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('attribute.update: %s: card_ref value not a number or numeric string: %s',
                        _attr_name, _value::text),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        ELSIF _value_type = 'card_ref[]' THEN
            IF jsonb_typeof(_value) <> 'array' THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('attribute.update: %s: value must be a JSON array of card ids', _attr_name),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            -- Build canonical numeric array and the bigint[] for
            -- scope checks. A bad element short-circuits the loop.
            _value_card_ids := ARRAY[]::bigint[];
            DECLARE
                _bad boolean := false;
                _bad_msg text;
                _el jsonb;
            BEGIN
                FOR _el IN SELECT e.v FROM jsonb_array_elements(_value) AS e(v) LOOP
                    IF jsonb_typeof(_el) = 'number' THEN
                        _value_card_ids := array_append(_value_card_ids, (_el)::text::bigint);
                    ELSIF jsonb_typeof(_el) = 'string'
                          AND (_el #>> '{}') ~ '^-?\d+$' THEN
                        _value_card_ids := array_append(_value_card_ids, ((_el #>> '{}')::bigint));
                    ELSE
                        _bad := true;
                        _bad_msg := format('attribute.update: %s: card_ref value not a number or numeric string: %s',
                            _attr_name, _el::text);
                        EXIT;
                    END IF;
                END LOOP;
                IF _bad THEN
                    RETURN QUERY SELECT _idx, false, 'validation'::text, _bad_msg, NULL::jsonb;
                    CONTINUE;
                END IF;
            END;
            -- Canonical jsonb form: numeric array, ordered by input
            -- position. Matches the runUpdate CTE's CASE arm.
            SELECT COALESCE(jsonb_agg(
                       CASE
                         WHEN jsonb_typeof(e.v) = 'string'
                              AND (e.v #>> '{}') ~ '^-?\d+$'
                           THEN to_jsonb(((e.v #>> '{}')::bigint))
                         ELSE e.v
                       END
                       ORDER BY e.ord), '[]'::jsonb)
              INTO _value_norm
              FROM jsonb_array_elements(_value) WITH ORDINALITY AS e(v, ord);
        ELSE
            -- text / number / bool / date — no canonicalisation, no
            -- card_ref validation.
            _value_norm := _value;
            _value_card_ids := ARRAY[]::bigint[];
        END IF;

        -- 4. Project-scope check (card_ref / card_ref[] only).
        IF (_value_type = 'card_ref' OR _value_type = 'card_ref[]')
           AND array_length(_value_card_ids, 1) IS NOT NULL THEN

            -- Resolve target's enclosing project (NULL when target is a
            -- global card) via the shared capped helper (A1/A10).
            _target_project_id := card_enclosing_project(_card_id);

            DECLARE
                _rej_code text;
                _rej_msg text;
            BEGIN
                _rej_code := NULL;
                FOREACH _v IN ARRAY _value_card_ids LOOP
                    IF _v = 0 THEN
                        CONTINUE;
                    END IF;
                    SELECT TRUE, card_type_id INTO _vexists, _vct
                    FROM card WHERE id = _v;
                    IF NOT FOUND THEN
                        _rej_code := 'cross_project_ref';
                        _rej_msg := format('attribute %L: value card %s does not exist',
                            _attr_name, _v);
                        EXIT;
                    END IF;
                    -- target_card_type_id contract: a card_ref
                    -- attribute pointing at the wrong card_type is a
                    -- scope violation. Mirrors scope.go's check.
                    IF _target_card_type_id IS NOT NULL
                       AND _vct <> _target_card_type_id THEN
                        _rej_code := 'cross_project_ref';
                        _rej_msg := format('attribute %L: value card %s is not of the expected card type',
                            _attr_name, _v);
                        EXIT;
                    END IF;
                    -- Resolve value's enclosing project (NULL → global)
                    -- via the shared capped helper (A1/A10).
                    _vproj := card_enclosing_project(_v);
                    -- Global value (no project ancestor) is a wildcard.
                    IF _vproj IS NULL THEN
                        CONTINUE;
                    END IF;
                    IF _target_project_id IS NULL OR _vproj <> _target_project_id THEN
                        _rej_code := 'cross_project_ref';
                        _rej_msg := format(
                            'attribute %L: value card %s belongs to project %s but target is in project %s',
                            _attr_name, _v, _vproj, COALESCE(_target_project_id::text, '0'));
                        EXIT;
                    END IF;
                END LOOP;
                IF _rej_code IS NOT NULL THEN
                    RETURN QUERY SELECT _idx, false, _rej_code, _rej_msg, NULL::jsonb;
                    CONTINUE;
                END IF;
            END;
        END IF;

        -- 5. Screen uniqueness (slug / hotkey).
        IF (_attr_name = 'slug' OR _attr_name = 'hotkey')
           AND jsonb_typeof(_value_norm) <> 'null' THEN
            IF jsonb_typeof(_value_norm) <> 'string' THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('attribute.update: %L must be a string', _attr_name),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            _candidate := _value_norm #>> '{}';
            SELECT c.parent_card_id, ct.name
              INTO _parent_card_id, _card_type_name
            FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _card_id AND c.deleted_at IS NULL;
            -- Only screen cards with a parent participate in the
            -- uniqueness rule. Other shapes fall through (mirrors the
            -- Go helper's defensive short-circuit).
            IF FOUND AND _card_type_name = 'screen' AND _parent_card_id IS NOT NULL THEN
                IF _attr_name = 'slug' AND _candidate !~ _slug_re THEN
                    RETURN QUERY SELECT _idx, false, 'slug_invalid'::text,
                        format('attribute.update: slug %L must match ^[a-z][a-z0-9-]*$', _candidate),
                        NULL::jsonb;
                    CONTINUE;
                END IF;
                -- hotkey: a whitespace-only value is treated as "clear",
                -- which skips the uniqueness check entirely.
                IF NOT (_attr_name = 'hotkey' AND btrim(_candidate) = '') THEN
                    SELECT COALESCE(
                        (SELECT av_t.value #>> '{}'
                         FROM attribute_value av_t
                         JOIN attribute_def ad_t ON ad_t.id = av_t.attribute_def_id
                         WHERE av_t.card_id = c.id AND ad_t.name = 'title'),
                        c.id::text)
                      INTO _conflict_label
                    FROM attribute_value av
                    JOIN attribute_def ad ON ad.id = av.attribute_def_id
                    JOIN card c ON c.id = av.card_id
                    WHERE ad.name = _attr_name
                      AND av.value = to_jsonb(_candidate)
                      AND c.parent_card_id = _parent_card_id
                      AND c.id <> _card_id
                      AND c.deleted_at IS NULL
                    LIMIT 1;
                    IF FOUND THEN
                        RETURN QUERY SELECT _idx, false, (_attr_name || '_in_use')::text,
                            format('attribute.update: %s %L is already used by screen %L in this project',
                                _attr_name, _candidate, COALESCE(_conflict_label, '')),
                            NULL::jsonb;
                        CONTINUE;
                    END IF;
                END IF;
            END IF;
        END IF;

        -- 6. Flow gate (card_ref only). Mirrors attribute/flow.go.
        IF _value_type = 'card_ref' AND jsonb_typeof(_value_norm) = 'number' THEN
            -- Reuse the target_project we resolved for scope above,
            -- or compute it fresh when scope didn't run, via the shared
            -- capped helper (A1/A10).
            IF _target_project_id IS NULL THEN
                _target_project_id := card_enclosing_project(_card_id);
            END IF;

            IF _target_project_id IS NOT NULL THEN
                SELECT id INTO _flow_id
                FROM flow
                WHERE attribute_def_id = _attr_def_id AND scope_card_id = _target_project_id;
                IF FOUND THEN
                    -- Current value on this (card, attribute). Only the
                    -- canonical numeric form counts.
                    SELECT (av.value)::text::bigint INTO _prev_id
                    FROM attribute_value av
                    WHERE av.card_id = _card_id
                      AND av.attribute_def_id = _attr_def_id
                      AND jsonb_typeof(av.value) = 'number';
                    IF NOT FOUND OR _prev_id IS NULL OR _prev_id = 0 THEN
                        RETURN QUERY SELECT _idx, false, 'flow_invariant'::text,
                            format('attribute.update: card %s has no current value for flow-bound attribute %L',
                                _card_id, _attr_name),
                            NULL::jsonb;
                        CONTINUE;
                    END IF;
                    _new_id := (_value_norm)::text::bigint;
                    IF _new_id <> _prev_id THEN
                        SELECT id, requires_role_id INTO _step_id, _requires_role_id
                        FROM flow_step
                        WHERE flow_id = _flow_id
                          AND from_card_id = _prev_id
                          AND to_card_id = _new_id
                        LIMIT 1;
                        IF NOT FOUND THEN
                            -- Build the V13 rejection envelope. `from` and
                            -- `attempted_to` are the prev/new value cards;
                            -- `available[]` enumerates every flow_step the
                            -- card may currently fire (same shape Gate 4
                            -- returns from flow_step.list_for_card). The
                            -- per-actor `your_role_allows` bit lets the UI
                            -- render "ask a manager" without re-querying.
                            SELECT jsonb_build_object(
                                'id', c.id::text,
                                'label', COALESCE(av_t.value #>> '{}', ''),
                                'phase', c.phase)
                              INTO _from
                            FROM card c
                            LEFT JOIN attribute_def ad_t ON ad_t.name = 'title'
                            LEFT JOIN attribute_value av_t
                              ON av_t.card_id = c.id AND av_t.attribute_def_id = ad_t.id
                            WHERE c.id = _prev_id AND c.deleted_at IS NULL;
                            IF NOT FOUND THEN
                                _from := jsonb_build_object('id', _prev_id::text, 'label', '', 'phase', '');
                            END IF;
                            SELECT jsonb_build_object(
                                'id', c.id::text,
                                'label', COALESCE(av_t.value #>> '{}', ''),
                                'phase', c.phase)
                              INTO _attempted_to
                            FROM card c
                            LEFT JOIN attribute_def ad_t ON ad_t.name = 'title'
                            LEFT JOIN attribute_value av_t
                              ON av_t.card_id = c.id AND av_t.attribute_def_id = ad_t.id
                            WHERE c.id = _new_id AND c.deleted_at IS NULL;
                            IF NOT FOUND THEN
                                _attempted_to := jsonb_build_object('id', _new_id::text, 'label', '', 'phase', '');
                            END IF;
                            _available := build_flow_available_array(actor_id, _card_id, _target_project_id);
                            _detail := jsonb_build_object(
                                'from', _from,
                                'attempted_to', _attempted_to,
                                'available', _available);
                            RETURN QUERY SELECT _idx, false, 'flow_disallowed'::text,
                                format('Cannot move %s from %L to %L.',
                                    _attr_name,
                                    _from->>'label',
                                    _attempted_to->>'label'),
                                _detail;
                            CONTINUE;
                        END IF;
                        IF _requires_role_id IS NOT NULL THEN
                            SELECT r.name,
                                   (
                                     EXISTS (
                                       SELECT 1 FROM user_role ur
                                       JOIN role sr ON sr.id = ur.role_id
                                       WHERE ur.user_id = actor_id AND sr.name = 'system'
                                         AND ur.scope_card_id IS NULL
                                     )
                                     OR EXISTS (
                                       SELECT 1 FROM user_role ur
                                       WHERE ur.user_id = actor_id AND ur.role_id = _requires_role_id
                                         AND (ur.scope_card_id IS NULL
                                              OR ur.scope_card_id = _target_project_id)
                                     )
                                   )
                              INTO _role_name, _role_ok
                            FROM role r WHERE r.id = _requires_role_id;
                            IF NOT FOUND OR NOT _role_ok THEN
                                -- Same V13 envelope shape as flow_disallowed.
                                SELECT jsonb_build_object(
                                    'id', c.id::text,
                                    'label', COALESCE(av_t.value #>> '{}', ''),
                                    'phase', c.phase)
                                  INTO _from
                                FROM card c
                                LEFT JOIN attribute_def ad_t ON ad_t.name = 'title'
                                LEFT JOIN attribute_value av_t
                                  ON av_t.card_id = c.id AND av_t.attribute_def_id = ad_t.id
                                WHERE c.id = _prev_id AND c.deleted_at IS NULL;
                                IF NOT FOUND THEN
                                    _from := jsonb_build_object('id', _prev_id::text, 'label', '', 'phase', '');
                                END IF;
                                SELECT jsonb_build_object(
                                    'id', c.id::text,
                                    'label', COALESCE(av_t.value #>> '{}', ''),
                                    'phase', c.phase)
                                  INTO _attempted_to
                                FROM card c
                                LEFT JOIN attribute_def ad_t ON ad_t.name = 'title'
                                LEFT JOIN attribute_value av_t
                                  ON av_t.card_id = c.id AND av_t.attribute_def_id = ad_t.id
                                WHERE c.id = _new_id AND c.deleted_at IS NULL;
                                IF NOT FOUND THEN
                                    _attempted_to := jsonb_build_object('id', _new_id::text, 'label', '', 'phase', '');
                                END IF;
                                _available := build_flow_available_array(actor_id, _card_id, _target_project_id);
                                _detail := jsonb_build_object(
                                    'from', _from,
                                    'attempted_to', _attempted_to,
                                    'available', _available);
                                RETURN QUERY SELECT _idx, false, 'flow_role_required'::text,
                                    format('attribute.update: transition requires role %L; actor does not hold it',
                                        COALESCE(_role_name, '?')),
                                    _detail;
                                CONTINUE;
                            END IF;
                        END IF;
                    END IF;
                END IF;
            END IF;
        END IF;

        -- 7. Write. Read prev value, insert activity, upsert
        --    attribute_value. The runUpdate CTE batched all this; the
        --    per-row PL/pgSQL version is functionally equivalent. The
        --    same activity_id is stamped on attribute_value.last_activity_id.
        SELECT value INTO _prev_value
        FROM attribute_value
        WHERE card_id = _card_id AND attribute_def_id = _attr_def_id;
        IF NOT FOUND THEN
            _prev_value := NULL;
        END IF;

        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_card_id, 'attr_update', _attr_def_id, _prev_value, _value_norm, actor_id)
        RETURNING id INTO _activity_id;

        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_card_id, _attr_def_id, _value_norm, _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- Build the result. prev_value is omitted (NULL key) when there
        -- was no prior row; UpdateOutput uses omitempty for that field.
        IF _prev_value IS NULL THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object(
                    'ok', true,
                    'activity_id', _activity_id::text
                );
        ELSE
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object(
                    'ok', true,
                    'activity_id', _activity_id::text,
                    'prev_value', _prev_value
                );
        END IF;
    END LOOP;
END;
$$;

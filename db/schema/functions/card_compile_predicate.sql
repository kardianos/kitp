-- card_compile_predicate — recursive predicate-tree compiler used by
-- card_select_with_attributes_batch.
--
-- Mirrors the Go-side `compileTree` / `compileLeaf` (where.go) and
-- `translatePredicate` (select_attrs.go) compilers. Walks the input
-- JSONB tree and emits a SQL boolean expression suitable for the
-- outer WHERE in card_select_with_attributes_batch's main query.
--
-- Parameter passing: callers thread a JSONB params accumulator;
-- every caller-supplied value (attribute names, comparison values,
-- snippet ids) is appended to the accumulator. The emitted SQL
-- references them as `(($1->INDEX) #>> '{}')` for text, or
-- `($1->INDEX)::jsonb` for the jsonb equality leaves. `$1` in the
-- emitted fragment is the JSONB params bag bound by the caller's
-- EXECUTE USING params; visibility / parent_card_id / card_type_name
-- bind to higher placeholders the caller chose (e.g. $2, $3, ...).
--
-- Recognised tree shapes:
--   - Connective group: {"connective":"and|or|not","children":[...]}
--     Recurses; empty AND ⇒ TRUE, empty OR ⇒ FALSE, NOT must have
--     exactly one child.
--   - Leaf:             {"attr":"<name>","op":"<op>","values":[...]}
--     Ops covered (matches where.go): eq / != / in / not in /
--     exists / not exists / contains / before_today / within_days /
--     has_phase / not terminal / parent_status_phase / snippet.
--   - Flat v1 leaf shape: {"attr":"<name>","op":"=", "value":<json>}
--     (used by the legacy `where[]` field). Translated identically to
--     the v2 `values:[v]` shape.
--
-- card_ref canonicalization: when the attribute's value_type is
-- card_ref / card_ref[], JSON-string ids are rewritten to JSON-numbers
-- before being appended to the params bag. Mirrors
-- schema.Snapshot.CanonicalizeValue.
--
-- Snippet expansion: op='snippet' fetches the referenced
-- predicate_snippet card's `predicate` attribute value and recurses.
-- Cycle detection uses the `visited` argument (array of seen snippet
-- ids); a cycle returns FALSE rather than looping. A missing /
-- soft-deleted snippet compiles to FALSE; a present-but-empty
-- snippet compiles to TRUE.
CREATE OR REPLACE FUNCTION card_compile_predicate(
    node jsonb,
    params jsonb,
    visited bigint[]
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    _connective text;
    _children jsonb;
    _child jsonb;
    _child_sql text;
    _parts text[];
    _attr text;
    _op text;
    _value_type text;
    _values jsonb;
    _v jsonb;
    _v_canon jsonb;
    _placeholders text[];
    _ph_count int;
    _days int;
    _needle text;
    _snip_id bigint;
    _snip_pred jsonb;
    _next_visited bigint[];
    _sql text;
    _phase_strings text[];
    _phase_str text;
    _result jsonb;
BEGIN
    IF node IS NULL OR jsonb_typeof(node) <> 'object' THEN
        -- Vacuous node → TRUE (matches the empty-AND identity).
        RETURN jsonb_build_object('sql', 'TRUE', 'params', params);
    END IF;

    -- Connective group dispatch.
    IF node ? 'connective' AND (node->>'connective') <> '' THEN
        _connective := lower(node->>'connective');
        _children := COALESCE(node->'children', '[]'::jsonb);

        IF _connective = 'and' THEN
            IF jsonb_array_length(_children) = 0 THEN
                RETURN jsonb_build_object('sql', 'TRUE', 'params', params);
            END IF;
            _parts := ARRAY[]::text[];
            FOR _child IN SELECT value FROM jsonb_array_elements(_children)
            LOOP
                _result := card_compile_predicate(_child, params, visited);
                params := _result->'params';
                _parts := array_append(_parts, '(' || (_result->>'sql') || ')');
            END LOOP;
            RETURN jsonb_build_object('sql', array_to_string(_parts, ' AND '), 'params', params);
        ELSIF _connective = 'or' THEN
            IF jsonb_array_length(_children) = 0 THEN
                RETURN jsonb_build_object('sql', 'FALSE', 'params', params);
            END IF;
            _parts := ARRAY[]::text[];
            FOR _child IN SELECT value FROM jsonb_array_elements(_children)
            LOOP
                _result := card_compile_predicate(_child, params, visited);
                params := _result->'params';
                _parts := array_append(_parts, '(' || (_result->>'sql') || ')');
            END LOOP;
            RETURN jsonb_build_object('sql', array_to_string(_parts, ' OR '), 'params', params);
        ELSIF _connective = 'not' THEN
            IF jsonb_array_length(_children) <> 1 THEN
                RAISE EXCEPTION 'card_compile_predicate: not group must have exactly one child (got %)', jsonb_array_length(_children);
            END IF;
            _result := card_compile_predicate(_children->0, params, visited);
            params := _result->'params';
            RETURN jsonb_build_object('sql', 'NOT (' || (_result->>'sql') || ')', 'params', params);
        ELSE
            RAISE EXCEPTION 'card_compile_predicate: unknown connective %', node->>'connective';
        END IF;
    END IF;

    -- Compound shape from v1: {"and":[...]}. Mirrors translatePredicate.
    IF node ? 'and' AND jsonb_typeof(node->'and') = 'array' THEN
        _children := node->'and';
        IF jsonb_array_length(_children) = 0 THEN
            RETURN jsonb_build_object('sql', 'TRUE', 'params', params);
        END IF;
        _parts := ARRAY[]::text[];
        FOR _child IN SELECT value FROM jsonb_array_elements(_children)
        LOOP
            _result := card_compile_predicate(_child, params, visited);
            params := _result->'params';
            _parts := array_append(_parts, '(' || (_result->>'sql') || ')');
        END LOOP;
        RETURN jsonb_build_object('sql', array_to_string(_parts, ' AND '), 'params', params);
    END IF;

    -- Leaf shape: attr + op (+ values or value).
    _attr := COALESCE(node->>'attr', '');
    _op := lower(COALESCE(node->>'op', '='));
    -- Vacuously-empty predicate: when the dispatcher's JSON marshal
    -- drops an `and:[]` shape (omitempty on []Predicate elides empty
    -- slices) the wire shape that reaches us is `{}`. Treat as TRUE
    -- so empty AND lists keep their identity behaviour.
    IF _attr = '' AND _op = '=' AND NOT (node ? 'value')
       AND jsonb_array_length(COALESCE(node->'values', '[]'::jsonb)) = 0 THEN
        RETURN jsonb_build_object('sql', 'TRUE', 'params', params);
    END IF;
    IF _attr = '' OR _attr !~ '^[A-Za-z0-9_]+$' THEN
        RAISE EXCEPTION 'card_compile_predicate: bad attribute name %', _attr;
    END IF;

    -- Resolve attr value_type for canonicalization. Missing attribute_def
    -- pass-through (matches Go-side behaviour of leaving raw value alone).
    SELECT value_type INTO _value_type FROM attribute_def WHERE name = _attr LIMIT 1;

    -- Normalise: v1 single-value `value` to v2 `values:[v]`. v1 op '='
    -- aliases to v2 'eq'; '!=' to 'ne'. Same set translation logic.
    IF NOT (node ? 'values') AND node ? 'value' THEN
        _values := jsonb_build_array(node->'value');
    ELSE
        _values := COALESCE(node->'values', '[]'::jsonb);
    END IF;

    -- Op dispatch.
    IF _op IN ('=', 'eq') THEN
        IF jsonb_array_length(_values) = 0 THEN
            _v := 'null'::jsonb;
        ELSE
            _v := _values->0;
            IF _v IS NULL THEN _v := 'null'::jsonb; END IF;
        END IF;
        _v_canon := _canon_card_ref(_v, _value_type);
        -- Append attr (text) + value (jsonb) to params.
        params := params || jsonb_build_array(_attr) || jsonb_build_array(_v_canon);
        _ph_count := jsonb_array_length(params);
        -- Two newest indices: attr at (count-2), value at (count-1).
        _sql := format(
            'EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s) AND av.value = ($1->%s)::jsonb)',
            (_ph_count - 2)::text, (_ph_count - 1)::text);
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op IN ('!=', 'ne') THEN
        IF jsonb_array_length(_values) = 0 THEN
            _v := 'null'::jsonb;
        ELSE
            _v := _values->0;
            IF _v IS NULL THEN _v := 'null'::jsonb; END IF;
        END IF;
        _v_canon := _canon_card_ref(_v, _value_type);
        params := params || jsonb_build_array(_attr) || jsonb_build_array(_v_canon);
        _ph_count := jsonb_array_length(params);
        _sql := format(
            'NOT EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s) AND av.value = ($1->%s)::jsonb)',
            (_ph_count - 2)::text, (_ph_count - 1)::text);
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'in' THEN
        IF jsonb_array_length(_values) = 0 THEN
            RETURN jsonb_build_object('sql', 'FALSE', 'params', params);
        END IF;
        params := params || jsonb_build_array(_attr);
        _placeholders := ARRAY[]::text[];
        FOR _v IN SELECT value FROM jsonb_array_elements(_values)
        LOOP
            _v_canon := _canon_card_ref(_v, _value_type);
            params := params || jsonb_build_array(_v_canon);
            _ph_count := jsonb_array_length(params);
            _placeholders := array_append(_placeholders,
                format('($1->%s)::jsonb', (_ph_count - 1)::text));
        END LOOP;
        _ph_count := jsonb_array_length(params);
        -- attr index is (_ph_count - len(values) - 1). Recompute via len.
        _sql := format(
            'EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s) AND av.value IN (%s))',
            (_ph_count - jsonb_array_length(_values) - 1)::text,
            array_to_string(_placeholders, ', '));
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'not in' THEN
        IF jsonb_array_length(_values) = 0 THEN
            RETURN jsonb_build_object('sql', 'TRUE', 'params', params);
        END IF;
        params := params || jsonb_build_array(_attr);
        _placeholders := ARRAY[]::text[];
        FOR _v IN SELECT value FROM jsonb_array_elements(_values)
        LOOP
            _v_canon := _canon_card_ref(_v, _value_type);
            params := params || jsonb_build_array(_v_canon);
            _ph_count := jsonb_array_length(params);
            _placeholders := array_append(_placeholders,
                format('($1->%s)::jsonb', (_ph_count - 1)::text));
        END LOOP;
        _ph_count := jsonb_array_length(params);
        _sql := format(
            'NOT EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s) AND av.value IN (%s))',
            (_ph_count - jsonb_array_length(_values) - 1)::text,
            array_to_string(_placeholders, ', '));
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'exists' THEN
        params := params || jsonb_build_array(_attr);
        _ph_count := jsonb_array_length(params);
        _sql := format(
            'EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s))',
            (_ph_count - 1)::text);
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'not exists' THEN
        params := params || jsonb_build_array(_attr);
        _ph_count := jsonb_array_length(params);
        _sql := format(
            'NOT EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s))',
            (_ph_count - 1)::text);
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'before_today' THEN
        params := params || jsonb_build_array(_attr);
        _ph_count := jsonb_array_length(params);
        _sql := format(
            'EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s) AND av.value #>> ''{}'' <> '''' ' ||
            'AND av.value #>> ''{}'' < to_char(now()::date, ''YYYY-MM-DD''))',
            (_ph_count - 1)::text);
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'within_days' THEN
        IF jsonb_array_length(_values) = 0 THEN
            RAISE EXCEPTION 'within_days: missing day count';
        END IF;
        _v := _values->0;
        IF jsonb_typeof(_v) = 'number' THEN
            _days := (_v)::text::int;
        ELSIF jsonb_typeof(_v) = 'string' AND (_v #>> '{}') ~ '^-?[0-9]+$' THEN
            _days := (_v #>> '{}')::int;
        ELSE
            RAISE EXCEPTION 'within_days: value must be int or string-int';
        END IF;
        IF _days < 0 THEN
            RAISE EXCEPTION 'within_days: negative N (%)', _days;
        END IF;
        IF _days > 3650 THEN
            RAISE EXCEPTION 'within_days: % days is unreasonable (>10y)', _days;
        END IF;
        params := params || jsonb_build_array(_attr) || jsonb_build_array(_days);
        _ph_count := jsonb_array_length(params);
        _sql := format(
            'EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s) AND av.value #>> ''{}'' <> '''' ' ||
            'AND av.value #>> ''{}'' >= to_char(now()::date, ''YYYY-MM-DD'') ' ||
            'AND av.value #>> ''{}'' <= to_char((now() + (($1->>%s)::int) * interval ''1 day'')::date, ''YYYY-MM-DD''))',
            (_ph_count - 2)::text, (_ph_count - 1)::text);
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'contains' THEN
        IF jsonb_array_length(_values) = 0 THEN
            RAISE EXCEPTION 'contains: missing value';
        END IF;
        _v := _values->0;
        IF jsonb_typeof(_v) <> 'string' THEN
            RAISE EXCEPTION 'contains: value must be a string';
        END IF;
        _needle := _v #>> '{}';
        IF _needle = '' THEN
            RAISE EXCEPTION 'contains: value must be non-empty';
        END IF;
        IF _attr = 'comments' THEN
            params := params || jsonb_build_array('%' || _needle || '%');
            _ph_count := jsonb_array_length(params);
            _sql := format(
                'EXISTS (SELECT 1 FROM activity a JOIN comment_body cb ON cb.id = (a.value_new ->> ''comment_body_id'')::bigint ' ||
                'WHERE a.card_id = c.id AND a.kind = ''comment'' AND cb.body ILIKE ($1->>%s))',
                (_ph_count - 1)::text);
        ELSE
            params := params || jsonb_build_array(_attr) || jsonb_build_array('%' || _needle || '%');
            _ph_count := jsonb_array_length(params);
            _sql := format(
                'EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
                'WHERE av.card_id = c.id AND ad.name = ($1->>%s) AND av.value::text ILIKE ($1->>%s))',
                (_ph_count - 2)::text, (_ph_count - 1)::text);
        END IF;
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'has_phase' THEN
        IF jsonb_array_length(_values) = 0 THEN
            RETURN jsonb_build_object('sql', 'FALSE', 'params', params);
        END IF;
        params := params || jsonb_build_array(_attr);
        _placeholders := ARRAY[]::text[];
        FOR _v IN SELECT value FROM jsonb_array_elements(_values)
        LOOP
            IF jsonb_typeof(_v) <> 'string' THEN
                RAISE EXCEPTION 'has_phase: value must be a string';
            END IF;
            _phase_str := _v #>> '{}';
            IF _phase_str NOT IN ('triage', 'active', 'terminal') THEN
                RAISE EXCEPTION 'has_phase: %: must be triage|active|terminal', _phase_str;
            END IF;
            params := params || jsonb_build_array(_phase_str);
            _ph_count := jsonb_array_length(params);
            _placeholders := array_append(_placeholders,
                format('($1->>%s)', (_ph_count - 1)::text));
        END LOOP;
        _ph_count := jsonb_array_length(params);
        _sql := format(
            'EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'JOIN card target ON target.id = (av.value)::text::bigint ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s) ' ||
            'AND jsonb_typeof(av.value) = ''number'' ' ||
            'AND target.phase = ANY(ARRAY[%s]::text[]) AND target.deleted_at IS NULL)',
            (_ph_count - jsonb_array_length(_values) - 1)::text,
            array_to_string(_placeholders, ', '));
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'not terminal' THEN
        params := params || jsonb_build_array(_attr);
        _ph_count := jsonb_array_length(params);
        _sql := format(
            'NOT EXISTS (SELECT 1 FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            'JOIN card target ON target.id = (av.value)::text::bigint ' ||
            'WHERE av.card_id = c.id AND ad.name = ($1->>%s) AND jsonb_typeof(av.value) = ''number'' ' ||
            'AND target.phase = ''terminal'' AND target.deleted_at IS NULL)',
            (_ph_count - 1)::text);
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'parent_status_phase' THEN
        IF _attr <> 'parent_task' THEN
            RAISE EXCEPTION 'parent_status_phase: attr must be parent_task (got %)', _attr;
        END IF;
        IF jsonb_array_length(_values) = 0 THEN
            RETURN jsonb_build_object('sql', 'FALSE', 'params', params);
        END IF;
        _placeholders := ARRAY[]::text[];
        FOR _v IN SELECT value FROM jsonb_array_elements(_values)
        LOOP
            IF jsonb_typeof(_v) <> 'string' THEN
                RAISE EXCEPTION 'parent_status_phase: value must be a string';
            END IF;
            _phase_str := _v #>> '{}';
            IF _phase_str NOT IN ('triage', 'active', 'terminal') THEN
                RAISE EXCEPTION 'parent_status_phase: %: must be triage|active|terminal', _phase_str;
            END IF;
            params := params || jsonb_build_array(_phase_str);
            _ph_count := jsonb_array_length(params);
            _placeholders := array_append(_placeholders,
                format('($1->>%s)', (_ph_count - 1)::text));
        END LOOP;
        _sql := format(
            'EXISTS (SELECT 1 FROM attribute_value pav JOIN attribute_def pad ON pad.id = pav.attribute_def_id ' ||
            'JOIN card parent ON parent.id = (pav.value)::text::bigint ' ||
            'JOIN attribute_value sav ON sav.card_id = parent.id ' ||
            'JOIN attribute_def sad ON sad.id = sav.attribute_def_id ' ||
            'JOIN card status_card ON status_card.id = (sav.value)::text::bigint ' ||
            'WHERE pav.card_id = c.id AND pad.name = ''parent_task'' AND sad.name = ''status'' ' ||
            'AND jsonb_typeof(pav.value) = ''number'' AND jsonb_typeof(sav.value) = ''number'' ' ||
            'AND parent.deleted_at IS NULL AND status_card.deleted_at IS NULL ' ||
            'AND status_card.phase = ANY(ARRAY[%s]::text[]))',
            array_to_string(_placeholders, ', '));
        RETURN jsonb_build_object('sql', _sql, 'params', params);

    ELSIF _op = 'snippet' THEN
        IF jsonb_array_length(_values) = 0 THEN
            RAISE EXCEPTION 'snippet: missing snippet id';
        END IF;
        _v := _values->0;
        IF jsonb_typeof(_v) = 'number' THEN
            _snip_id := (_v)::text::bigint;
        ELSIF jsonb_typeof(_v) = 'string' AND (_v #>> '{}') ~ '^-?[0-9]+$' THEN
            _snip_id := (_v #>> '{}')::bigint;
        ELSE
            RAISE EXCEPTION 'snippet: id must be int or numeric string';
        END IF;
        IF _snip_id = ANY(visited) THEN
            -- Matches the Go-side compileSnippet behaviour: cycles surface
            -- as a hard error rather than silent FALSE so callers can
            -- repair the snippet graph.
            RAISE EXCEPTION 'snippet: cycle detected at snippet id %', _snip_id;
        END IF;
        -- Fetch the snippet card's predicate attribute.
        SELECT av.value INTO _snip_pred
        FROM card sc
        JOIN card_type sct ON sct.id = sc.card_type_id
        LEFT JOIN LATERAL (
            SELECT av.value
            FROM attribute_value av
            JOIN attribute_def ad ON ad.id = av.attribute_def_id
            WHERE av.card_id = sc.id AND ad.name = 'predicate'
            LIMIT 1
        ) av ON TRUE
        WHERE sc.id = _snip_id AND sc.deleted_at IS NULL AND sct.name = 'predicate_snippet';

        IF _snip_pred IS NULL THEN
            RETURN jsonb_build_object('sql', 'FALSE', 'params', params);
        END IF;

        -- Snippet predicate is JSONB-stringified inside the attribute value
        -- (it's stored as a JSON string holding the tree JSON). Unwrap if
        -- so; otherwise use the value directly.
        IF jsonb_typeof(_snip_pred) = 'string' THEN
            BEGIN
                _snip_pred := (_snip_pred #>> '{}')::jsonb;
            EXCEPTION WHEN others THEN
                RETURN jsonb_build_object('sql', 'TRUE', 'params', params);
            END;
        END IF;

        IF _snip_pred IS NULL OR (jsonb_typeof(_snip_pred) = 'object'
                                  AND _snip_pred = '{}'::jsonb) THEN
            RETURN jsonb_build_object('sql', 'TRUE', 'params', params);
        END IF;

        _next_visited := array_append(visited, _snip_id);
        _result := card_compile_predicate(_snip_pred, params, _next_visited);
        params := _result->'params';
        RETURN jsonb_build_object('sql', _result->>'sql', 'params', params);

    ELSE
        RAISE EXCEPTION 'card_compile_predicate: unsupported op %', _op;
    END IF;
END;
$$;

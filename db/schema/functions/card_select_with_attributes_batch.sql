-- card.select_with_attributes handler (Phase 5 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runSelectWithAttributes + queryOne +
-- translatePredicate + compileTree + compileLeaf into a PL/pgSQL body
-- that calls the card_compile_predicate helper.
--
-- This is the SPA's main read path. Per the plan's Open Questions §3
-- the migration is borderline (the dynamic SQL build sacrifices plan
-- caching that other handlers retain), but consolidating the dispatch
-- shape across reads keeps the dispatcher uniform.
--
-- Per-row pipeline:
--   1. Decode filters (parent_card_id, card_type_name, where[], tree,
--      include_deleted, with_personal_sort, routed_to_me, order, limit,
--      offset).
--   2. Compile the predicate tree (v2 `tree` takes precedence over the
--      v1 `where[]` flat list) via card_compile_predicate; accumulate
--      bound values into a JSONB params bag.
--   3. Compile ORDER BY clauses, including value-type-aware LATERAL
--      joins for attributes.<name> entries (card_ref / number / bool /
--      text/date / generic JSONB fallback).
--   4. Assemble + EXECUTE the SELECT, aggregating rows into a single
--      JSONB array under result.rows matching SelectWithAttributesOutput.
--
-- Visibility predicate (B7) is AND-joined into every query.
CREATE OR REPLACE FUNCTION card_select_with_attributes_batch(
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
    _parent_card_id bigint;
    _project_id bigint;
    _card_type_name text;
    _include_deleted boolean;
    _with_personal_sort boolean;
    _routed_to_me boolean;
    _tree jsonb;
    _where jsonb;
    _limit_v int;
    _offset_v int;
    _params jsonb;
    _me_person_id bigint;
    _compile_result jsonb;
    _pred_sql text;
    _clauses text[];
    _personal_sort_select text;
    _personal_sort_join text;
    _routed_join text;
    _order_joins text;
    _order_parts text[];
    _order_clause jsonb;
    _order_field text;
    _order_dir text;
    _order_dir_uc text;
    _order_attr text;
    _attr_value_type text;
    _attr_def_id bigint;
    _title_def_id bigint;
    _sort_order_def_id bigint;
    _alias text;
    _i int;
    _final_sql text;
    _result_rows jsonb;
    _where_sql text;
    _order_sql text;
    _order_clause_inner text;
    _limit_sql text;
    _offset_sql text;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _parent_card_id := NULLIF(_raw->>'parent_card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _parent_card_id := NULL;
        END;
        BEGIN
            _project_id := NULLIF(_raw->>'project_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _project_id := NULL;
        END;
        _card_type_name := NULLIF(_raw->>'card_type_name', '');
        _include_deleted := COALESCE((_raw->>'include_deleted')::boolean, false);
        _with_personal_sort := COALESCE((_raw->>'with_personal_sort')::boolean, false);
        _routed_to_me := COALESCE((_raw->>'routed_to_me')::boolean, false);
        _tree := _raw->'tree';
        _where := _raw->'where';
        BEGIN
            _limit_v := NULLIF(_raw->>'limit', '')::int;
        EXCEPTION WHEN invalid_text_representation THEN
            _limit_v := NULL;
        END;
        BEGIN
            _offset_v := NULLIF(_raw->>'offset', '')::int;
        EXCEPTION WHEN invalid_text_representation THEN
            _offset_v := NULL;
        END;

        -- Params bag for the dynamic query. Layout (positional in EXECUTE
        -- USING):
        --   $1 = _params (JSONB array of arbitrary bound values from
        --                 predicate compilation + parent/type/limit/offset).
        --   $2 = actor_id (bigint).
        _params := '[]'::jsonb;
        _clauses := ARRAY[]::text[];

        -- Visibility predicate (B7).
        _clauses := array_append(_clauses, format(
            'EXISTS (WITH RECURSIVE up(id, parent_card_id, card_type_id, depth) AS (' ||
            'SELECT card.id, card.parent_card_id, card.card_type_id, 0 ' ||
            'FROM card WHERE card.id = c.id ' ||
            'UNION ALL ' ||
            'SELECT p.id, p.parent_card_id, p.card_type_id, up.depth + 1 ' ||
            'FROM card p JOIN up ON p.id = up.parent_card_id WHERE up.depth < 16 ' ||
            ') SELECT 1 FROM user_account caller ' ||
            'JOIN user_role ur ON ur.user_id = caller.id ' ||
            '  OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id) ' ||
            'WHERE caller.id = $2 AND (ur.scope_card_id IS NULL OR ur.scope_card_id IN (' ||
            'SELECT up.id FROM up JOIN card_type ct2 ON ct2.id = up.card_type_id WHERE ct2.name = ''project'')))'
        ));

        IF NOT _include_deleted THEN
            _clauses := array_append(_clauses, 'c.deleted_at IS NULL');
        END IF;

        IF _parent_card_id IS NOT NULL THEN
            _params := _params || jsonb_build_array(_parent_card_id);
            _clauses := array_append(_clauses, format(
                'c.parent_card_id = ($1->>%s)::bigint',
                (jsonb_array_length(_params) - 1)::text));
        END IF;

        -- Enclosing-project filter: keep only cards whose ancestor chain (the
        -- card itself or any parent, up to the depth-16 cap) includes
        -- _project_id. Scopes grandchild cards (filters → screen → project)
        -- that parent_card_id can't reach — used by project-scoped admin screens.
        IF _project_id IS NOT NULL THEN
            _params := _params || jsonb_build_array(_project_id);
            _clauses := array_append(_clauses, format(
                'EXISTS (WITH RECURSIVE anc(id, parent_card_id, depth) AS (' ||
                'SELECT card.id, card.parent_card_id, 0 FROM card WHERE card.id = c.id ' ||
                'UNION ALL ' ||
                'SELECT p.id, p.parent_card_id, anc.depth + 1 ' ||
                'FROM card p JOIN anc ON p.id = anc.parent_card_id WHERE anc.depth < 16 ' ||
                ') SELECT 1 FROM anc WHERE anc.id = ($1->>%s)::bigint)',
                (jsonb_array_length(_params) - 1)::text));
        END IF;
        IF _card_type_name IS NOT NULL THEN
            _params := _params || jsonb_build_array(_card_type_name);
            _clauses := array_append(_clauses, format(
                'ct.name = ($1->>%s)',
                (jsonb_array_length(_params) - 1)::text));
        END IF;

        -- Resolve the dynamic "@me" person-ref token to the caller's person card
        -- id BEFORE compiling (so card_compile_predicate only sees concrete ids).
        -- Saved filters store "@me" verbatim → each viewer resolves to their own
        -- person (dynamic per-viewer assignee/originator == me). Skipped when the
        -- caller has no linked person — "@me" then stays a string + matches no
        -- card, which is correct (the viewer has no person identity).
        SELECT person_card_id INTO _me_person_id
        FROM user_account_person WHERE user_account_id = actor_id;
        IF _me_person_id IS NOT NULL THEN
            IF _tree IS NOT NULL THEN
                _tree := _resolve_me_tokens(_tree, _me_person_id);
            END IF;
            IF _where IS NOT NULL THEN
                _where := _resolve_me_tokens(_where, _me_person_id);
            END IF;
        END IF;

        -- Predicate: v2 tree wins, fallback to v1 flat where[] (top-level AND).
        IF _tree IS NOT NULL AND jsonb_typeof(_tree) = 'object' THEN
            _compile_result := card_compile_predicate(_tree, _params, ARRAY[]::bigint[]);
            _params := _compile_result->'params';
            _pred_sql := _compile_result->>'sql';
            IF _pred_sql IS NOT NULL AND _pred_sql <> '' THEN
                _clauses := array_append(_clauses, _pred_sql);
            END IF;
        ELSIF _where IS NOT NULL AND jsonb_typeof(_where) = 'array' THEN
            FOR _i IN 0 .. (jsonb_array_length(_where) - 1)
            LOOP
                _compile_result := card_compile_predicate(_where->_i, _params, ARRAY[]::bigint[]);
                _params := _compile_result->'params';
                _pred_sql := _compile_result->>'sql';
                IF _pred_sql IS NOT NULL AND _pred_sql <> '' THEN
                    _clauses := array_append(_clauses, _pred_sql);
                END IF;
            END LOOP;
        END IF;

        -- Personal-sort join + select column (Inbox screen).
        IF _with_personal_sort THEN
            _personal_sort_select := 'ucs.sort_order AS personal_sort_order';
            _personal_sort_join := 'LEFT JOIN user_card_sort ucs ON ucs.user_id = $2 AND ucs.card_id = c.id';
        ELSE
            _personal_sort_select := 'NULL::float8 AS personal_sort_order';
            _personal_sort_join := '';
        END IF;

        -- Routed-to-me agent-perspective filter.
        IF _routed_to_me THEN
            _routed_join := 'JOIN user_card_agent uca ON uca.card_id = c.id ' ||
                'AND uca.agent_user_id = $2 ' ||
                'AND uca.user_id = (SELECT parent_user_id FROM user_account WHERE id = $2)';
        ELSE
            _routed_join := '';
        END IF;

        -- ORDER BY assembly.
        _order_parts := ARRAY[]::text[];
        _order_joins := '';
        IF _raw ? 'order' AND jsonb_typeof(_raw->'order') = 'array' THEN
            FOR _i IN 0 .. (jsonb_array_length(_raw->'order') - 1)
            LOOP
                _order_clause := _raw->'order'->_i;
                _order_field := _order_clause->>'field';
                _order_dir := COALESCE(_order_clause->>'direction', 'ASC');
                _order_dir_uc := upper(_order_dir);
                IF _order_dir_uc NOT IN ('ASC', 'DESC') THEN
                    _order_dir_uc := 'ASC';
                END IF;

                IF _order_field = 'created_at' THEN
                    _order_parts := array_append(_order_parts, 'c.created_at ' || _order_dir_uc);
                ELSIF _order_field = 'last_activity_at' THEN
                    _order_parts := array_append(_order_parts,
                        'la.last_activity_at ' || _order_dir_uc || ' NULLS LAST');
                ELSIF _order_field = 'personal_sort_order' THEN
                    IF NOT _with_personal_sort THEN
                        RAISE EXCEPTION 'select_with_attributes: order by personal_sort_order requires with_personal_sort=true';
                    END IF;
                    _order_parts := array_append(_order_parts,
                        'ucs.sort_order ' || _order_dir_uc || ' NULLS LAST');
                ELSIF position('attributes.' in _order_field) = 1 THEN
                    _order_attr := substr(_order_field, length('attributes.') + 1);
                    IF _order_attr = '' OR _order_attr !~ '^[A-Za-z0-9_]+$' THEN
                        RAISE EXCEPTION 'select_with_attributes: bad order field %', _order_field;
                    END IF;
                    SELECT id, value_type INTO _attr_def_id, _attr_value_type
                    FROM attribute_def WHERE name = _order_attr LIMIT 1;
                    _alias := format('ord_%s', _i::text);
                    _params := _params || jsonb_build_array(_order_attr);
                    -- The attribute-name placeholder index.
                    IF _attr_value_type = 'card_ref' THEN
                        SELECT id INTO _title_def_id FROM attribute_def WHERE name = 'title';
                        SELECT id INTO _sort_order_def_id FROM attribute_def WHERE name = 'sort_order';
                        IF _title_def_id IS NULL OR _sort_order_def_id IS NULL THEN
                            RAISE EXCEPTION 'select_with_attributes: snapshot missing title/sort_order attribute_def';
                        END IF;
                        -- jsonb_typeof guard: Postgres' planner may evaluate the
                        -- SELECT list before the WHERE filter, so the cast must
                        -- tolerate non-number values that the WHERE would have
                        -- eliminated. Without the guard, sibling attribute_value
                        -- rows on the same card (title, description, etc.)
                        -- trigger 22P02 when their text values reach the bigint
                        -- cast.
                        _order_joins := _order_joins || format(
                            ' LEFT JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(av.value) = ''number'' ' ||
                            'THEN (av.value)::text::bigint ELSE NULL END AS ref_id ' ||
                            'FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
                            'WHERE av.card_id = c.id AND ad.name = ($1->>%s)) %s ON TRUE ' ||
                            'LEFT JOIN attribute_value %s_so ON %s_so.card_id = %s.ref_id AND %s_so.attribute_def_id = %s ' ||
                            'LEFT JOIN attribute_value %s_t ON %s_t.card_id = %s.ref_id AND %s_t.attribute_def_id = %s ',
                            (jsonb_array_length(_params) - 1)::text, _alias,
                            _alias, _alias, _alias, _alias, _sort_order_def_id::text,
                            _alias, _alias, _alias, _alias, _title_def_id::text);
                        _order_parts := array_append(_order_parts,
                            format('(%s_so.value)::numeric %s NULLS LAST', _alias, _order_dir_uc));
                        _order_parts := array_append(_order_parts,
                            format('lower(%s_t.value #>> ''{}'') %s NULLS LAST', _alias, _order_dir_uc));
                    ELSIF _attr_value_type = 'number' THEN
                        _order_joins := _order_joins || format(
                            ' LEFT JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(av.value) = ''number'' ' ||
                            'THEN (av.value)::text::numeric ELSE NULL END AS v ' ||
                            'FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
                            'WHERE av.card_id = c.id AND ad.name = ($1->>%s)) %s ON TRUE ',
                            (jsonb_array_length(_params) - 1)::text, _alias);
                        _order_parts := array_append(_order_parts,
                            format('%s.v %s NULLS LAST', _alias, _order_dir_uc));
                    ELSIF _attr_value_type = 'bool' THEN
                        _order_joins := _order_joins || format(
                            ' LEFT JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(av.value) = ''boolean'' ' ||
                            'THEN (av.value)::text::boolean ELSE NULL END AS v ' ||
                            'FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
                            'WHERE av.card_id = c.id AND ad.name = ($1->>%s)) %s ON TRUE ',
                            (jsonb_array_length(_params) - 1)::text, _alias);
                        _order_parts := array_append(_order_parts,
                            format('%s.v %s NULLS LAST', _alias, _order_dir_uc));
                    ELSIF _attr_value_type IN ('text', 'date') THEN
                        _order_joins := _order_joins || format(
                            ' LEFT JOIN LATERAL (SELECT lower(av.value #>> ''{}'') AS v ' ||
                            'FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
                            'WHERE av.card_id = c.id AND ad.name = ($1->>%s)) %s ON TRUE ',
                            (jsonb_array_length(_params) - 1)::text, _alias);
                        _order_parts := array_append(_order_parts,
                            format('%s.v %s NULLS LAST', _alias, _order_dir_uc));
                    ELSE
                        -- Unknown / card_ref[] → raw JSONB fallback.
                        _order_joins := _order_joins || format(
                            ' LEFT JOIN LATERAL (SELECT av.value AS v ' ||
                            'FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
                            'WHERE av.card_id = c.id AND ad.name = ($1->>%s)) %s ON TRUE ',
                            (jsonb_array_length(_params) - 1)::text, _alias);
                        _order_parts := array_append(_order_parts,
                            format('%s.v %s NULLS LAST', _alias, _order_dir_uc));
                    END IF;
                ELSE
                    RAISE EXCEPTION 'select_with_attributes: unsupported order field %', _order_field;
                END IF;
            END LOOP;
        END IF;

        IF cardinality(_order_parts) > 0 THEN
            _order_sql := 'ORDER BY ' || array_to_string(_order_parts, ', ');
        ELSE
            _order_sql := 'ORDER BY c.id';
        END IF;

        -- WHERE TRUE AND … : the `TRUE` seed means an empty _clauses
        -- array (or a future clause that becomes conditional) can never
        -- emit a bare, syntactically-invalid `WHERE` (A15b / BE-L4).
        _where_sql := 'WHERE TRUE';
        IF cardinality(_clauses) > 0 THEN
            _where_sql := _where_sql || ' AND ' || array_to_string(_clauses, ' AND ');
        END IF;

        IF _limit_v IS NOT NULL THEN
            _params := _params || jsonb_build_array(_limit_v);
            _limit_sql := format(' LIMIT ($1->>%s)::int',
                (jsonb_array_length(_params) - 1)::text);
        ELSE
            _limit_sql := '';
        END IF;
        IF _offset_v IS NOT NULL THEN
            _params := _params || jsonb_build_array(_offset_v);
            _offset_sql := format(' OFFSET ($1->>%s)::int',
                (jsonb_array_length(_params) - 1)::text);
        ELSE
            _offset_sql := '';
        END IF;

        -- Build the inner SELECT with row_number() OVER (the same
        -- ORDER BY) so the outer jsonb_agg can explicitly order on it.
        -- Both `_order_sql` and the window's ORDER BY reference the
        -- same column / alias set, keeping the requested order stable
        -- across the aggregator boundary. Postgres' jsonb_agg without
        -- an explicit ORDER BY would otherwise be free to reorder.
        _order_clause_inner := substring(_order_sql from 10); -- strip leading "ORDER BY "

        _final_sql :=
            'SELECT COALESCE(jsonb_agg(jsonb_build_object(' ||
            '  ''id'', sub.id::text, ' ||
            '  ''card_type_id'', sub.card_type_id::text, ' ||
            '  ''card_type_name'', sub.card_type_name, ' ||
            '  ''parent_card_id'', CASE WHEN sub.parent_card_id IS NULL THEN NULL ELSE to_jsonb(sub.parent_card_id::text) END, ' ||
            -- phase column is only meaningful for flow-bound value-cards
            -- (card_type.uses_phase=true). For everything else the
            -- column carries an unused default — emit NULL so the
            -- Go-side `omitempty` drops it from the wire entirely.
            '  ''phase'', CASE WHEN sub.uses_phase THEN sub.phase ELSE NULL END, ' ||
            '  ''attributes'', COALESCE(sub.attrs, ''{}''::jsonb), ' ||
            '  ''created_at'', to_jsonb(sub.created_at), ' ||
            '  ''last_activity_at'', CASE WHEN sub.last_activity_at IS NULL THEN NULL ELSE to_jsonb(sub.last_activity_at) END, ' ||
            '  ''deleted_at'', CASE WHEN sub.deleted_at IS NULL THEN NULL ELSE to_jsonb(sub.deleted_at) END, ' ||
            '  ''personal_sort_order'', CASE WHEN sub.personal_sort_order IS NULL THEN NULL ELSE to_jsonb(sub.personal_sort_order) END ' ||
            ') ORDER BY sub.rn), ''[]''::jsonb) ' ||
            'FROM (SELECT c.id, c.card_type_id, ct.name AS card_type_name, ct.uses_phase, c.parent_card_id, c.phase, ' ||
            '  c.deleted_at, COALESCE(attrs.values, ''{}''::jsonb) AS attrs, c.created_at, ' ||
            '  la.last_activity_at, ' ||
            '  ' || _personal_sort_select || ', ' ||
            '  row_number() OVER (ORDER BY ' || _order_clause_inner || ') AS rn ' ||
            'FROM card c JOIN card_type ct ON ct.id = c.card_type_id ' ||
            _personal_sort_join || ' ' ||
            _routed_join || ' ' ||
            _order_joins ||
            'LEFT JOIN LATERAL (SELECT jsonb_object_agg(ad.name, av.value) AS values ' ||
            '  FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id ' ||
            '  WHERE av.card_id = c.id) attrs ON TRUE ' ||
            'LEFT JOIN LATERAL (SELECT MAX(a.created_at) AS last_activity_at ' ||
            '  FROM activity a WHERE a.card_id = c.id) la ON TRUE ' ||
            _where_sql || ' ' ||
            _order_sql || _limit_sql || _offset_sql ||
            ') sub';

        EXECUTE _final_sql INTO _result_rows USING _params, card_select_with_attributes_batch.actor_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE(_result_rows, '[]'::jsonb));
    END LOOP;
END;
$$;

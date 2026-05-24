-- remap_predicate_tree — walk a predicate-tree JSONB value and rewrite
-- card_ref ids on every leaf node whose `attr` names a card_ref /
-- card_ref[] attribute.
--
-- Ported from projectstamp.remapPredicateNode (Phase 4 of
-- UNIFIED_HANDLER_PLAN.md). Used by copy_project_template to replace
-- the deferred `RAISE NOTICE` predicate passthrough.
--
-- Tree shapes recognised:
--
--   1. Connective node (v2 tree):
--        {"connective":"and|or", "children":[node, node, ...]}
--      Recurse into every element of `children`.
--
--   2. Leaf node (v1 + v2):
--        {"attr":"<name>", "op":"<op>", "values":[v1, v2, ...]}
--      When `attr` ∈ card_ref_attrs, remap any numeric / string-of-digits
--      element of `values` through the remap object.
--
--   3. toggle_groups (screen attribute, top-level is a JSON array):
--        [{"name":..., "items":[{"name":..., "predicate":<node>, ...},
--          ...]}, ...]
--      Recurse into every element of `items[]`, looking for a `predicate`
--      sub-node; recurse into that too. (Plain array roots are walked
--      element-wise.)
--
-- Anything else passes through verbatim. Unknown ops on a card_ref-attr
-- leaf still trigger value remap — the spec is "attr is card_ref-shaped"
-- not "op is in some allow-list" (the Go version filtered on op, but
-- since op-set is open-ended and any op on a card_ref attr that quotes
-- ids needs the rewrite, we gate on attr only).
--
-- remap parameter: JSONB object {"<old_id>": <new_id>, ...} where both
-- keys (string-encoded bigint) and values are the IDs from the
-- _remap TEMP TABLE. The caller (copy_project_template) builds this
-- via jsonb_object_agg(src_id::text, new_id).
CREATE OR REPLACE FUNCTION remap_predicate_tree(
    tree jsonb,
    remap jsonb,
    card_ref_attrs text[]
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    _typ text;
    _attr text;
    _values jsonb;
    _new_values jsonb;
    _new_children jsonb;
    _new_items jsonb;
    _el jsonb;
    _new_el jsonb;
    _v jsonb;
    _new_v jsonb;
    _n bigint;
    _key text;
    _mapped jsonb;
    _changed_children boolean;
    _changed_items boolean;
    _changed_values boolean;
BEGIN
    IF tree IS NULL THEN
        RETURN tree;
    END IF;

    _typ := jsonb_typeof(tree);

    -- Plain array root (the toggle_groups outer shape). Walk element-wise.
    IF _typ = 'array' THEN
        _new_children := '[]'::jsonb;
        _changed_children := false;
        FOR _el IN SELECT value FROM jsonb_array_elements(tree)
        LOOP
            _new_el := remap_predicate_tree(_el, remap, card_ref_attrs);
            IF _new_el::text IS DISTINCT FROM _el::text THEN
                _changed_children := true;
            END IF;
            _new_children := _new_children || jsonb_build_array(_new_el);
        END LOOP;
        IF _changed_children THEN
            RETURN _new_children;
        END IF;
        RETURN tree;
    END IF;

    -- Non-object scalars pass through.
    IF _typ <> 'object' THEN
        RETURN tree;
    END IF;

    -- Object: may carry any subset of {connective, children, attr, op,
    -- values, items, predicate, name, label, default_on, ...}. Walk the
    -- known structural keys; copy the rest through.
    _changed_children := false;
    _changed_items := false;
    _changed_values := false;

    -- 1. Recurse into children[] (connective nodes).
    IF tree ? 'children' AND jsonb_typeof(tree->'children') = 'array' THEN
        _new_children := '[]'::jsonb;
        FOR _el IN SELECT value FROM jsonb_array_elements(tree->'children')
        LOOP
            _new_el := remap_predicate_tree(_el, remap, card_ref_attrs);
            IF _new_el::text IS DISTINCT FROM _el::text THEN
                _changed_children := true;
            END IF;
            _new_children := _new_children || jsonb_build_array(_new_el);
        END LOOP;
    END IF;

    -- 2. Recurse into items[] (toggle_groups inner shape). Each item may
    --    carry a `predicate` sub-node that itself needs remapping.
    IF tree ? 'items' AND jsonb_typeof(tree->'items') = 'array' THEN
        _new_items := '[]'::jsonb;
        FOR _el IN SELECT value FROM jsonb_array_elements(tree->'items')
        LOOP
            _new_el := _el;
            IF jsonb_typeof(_el) = 'object' AND _el ? 'predicate' THEN
                _new_v := remap_predicate_tree(_el->'predicate', remap, card_ref_attrs);
                IF _new_v::text IS DISTINCT FROM (_el->'predicate')::text THEN
                    _new_el := jsonb_set(_el, '{predicate}', _new_v);
                END IF;
            END IF;
            -- An item may also contain `items` or `children` itself in
            -- exotic layouts; recurse to be safe.
            IF jsonb_typeof(_new_el) = 'object'
               AND (_new_el ? 'children' OR _new_el ? 'items') THEN
                _new_el := remap_predicate_tree(_new_el, remap, card_ref_attrs);
            END IF;
            IF _new_el::text IS DISTINCT FROM _el::text THEN
                _changed_items := true;
            END IF;
            _new_items := _new_items || jsonb_build_array(_new_el);
        END LOOP;
    END IF;

    -- 3. Leaf rewrite: attr + values pair where attr is a card_ref attr.
    IF tree ? 'attr' AND tree ? 'values'
       AND jsonb_typeof(tree->'values') = 'array' THEN
        _attr := tree->>'attr';
        IF _attr = ANY (card_ref_attrs) THEN
            _values := tree->'values';
            _new_values := '[]'::jsonb;
            FOR _v IN SELECT value FROM jsonb_array_elements(_values)
            LOOP
                _new_v := _v;
                IF jsonb_typeof(_v) = 'number' THEN
                    _n := (_v)::text::bigint;
                    _key := _n::text;
                    IF remap ? _key THEN
                        _mapped := remap->_key;
                        IF jsonb_typeof(_mapped) = 'number' THEN
                            _new_v := _mapped;
                        ELSIF jsonb_typeof(_mapped) = 'string' THEN
                            _new_v := to_jsonb((_mapped #>> '{}')::bigint);
                        END IF;
                    END IF;
                ELSIF jsonb_typeof(_v) = 'string' AND (_v #>> '{}') ~ '^-?\d+$' THEN
                    _key := _v #>> '{}';
                    IF remap ? _key THEN
                        _mapped := remap->_key;
                        IF jsonb_typeof(_mapped) = 'number' THEN
                            _new_v := _mapped;
                        ELSIF jsonb_typeof(_mapped) = 'string' THEN
                            _new_v := to_jsonb((_mapped #>> '{}')::bigint);
                        END IF;
                    END IF;
                END IF;
                IF _new_v::text IS DISTINCT FROM _v::text THEN
                    _changed_values := true;
                END IF;
                _new_values := _new_values || jsonb_build_array(_new_v);
            END LOOP;
        END IF;
    END IF;

    -- Reassemble only when something changed.
    IF NOT _changed_children AND NOT _changed_items AND NOT _changed_values THEN
        RETURN tree;
    END IF;

    _new_el := tree;
    IF _changed_children THEN
        _new_el := jsonb_set(_new_el, '{children}', _new_children);
    END IF;
    IF _changed_items THEN
        _new_el := jsonb_set(_new_el, '{items}', _new_items);
    END IF;
    IF _changed_values THEN
        _new_el := jsonb_set(_new_el, '{values}', _new_values);
    END IF;
    RETURN _new_el;
END;
$$;

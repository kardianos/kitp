-- tag.apply handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runApply into one PL/pgSQL body.
--
-- A tag is a CARD of type 'tag' carrying two built-in attributes:
--   * `path`              — slash-delimited label, e.g. "priority/high"
--   * `root_exclusive_at` — the prefix at which the tag is mutually
--                           exclusive with sibling tags (the same
--                           target may hold at most one tag whose
--                           pathRoot() == root_exclusive_at).
-- Apply mutates the target card's `tags` attribute (a card_ref[]
-- jsonb array of tag card ids). The mutual-exclusion rule is enforced
-- atomically in this function: applying priority/high then priority/low
-- on a task removes priority/high in the same transaction. That
-- guarantee was previously upheld by Go-side bookkeeping; replicated
-- here per the docstring "sibling tags at the same root are removed
-- atomically".
--
-- Per-row pipeline:
--   1. Cheap input validation (target_card_id, tag_card_id required).
--   2. Target card existence + 'tags' edge declared for its card_type.
--   3. Tag card existence + card_type='tag' + load path / root.
--   4. Project-scope check: the tag must either be global (no enclosing
--      project) or share the target's enclosing project. Failures →
--      'cross_project_ref'.
--   5. Load current tags array; add the new tag (idempotent).
--   6. Mutual-exclusion: when the new tag has root_exclusive_at = R,
--      remove every other currently-applied tag whose path's root
--      (everything before the first '/') equals R.
--   7. Insert activity row of kind='tag_apply' and upsert the new
--      attribute_value. The activity row carries value_old / value_new
--      as numeric jsonb arrays — matches the runApply CTE.
--
-- Result JSON shape matches `tag.ApplyOutput`:
--   {"ok": true, "activity_id": "123", "removed_tag_ids": ["7","9"]}
-- removed_tag_ids is a JSON array of strings (the reg.IDs custom
-- marshaller emits decimal-string ids for JS bigint safety) and is
-- omitted when nothing was removed.
CREATE OR REPLACE FUNCTION tag_apply_batch(
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
    _target_id bigint;
    _tag_id bigint;
    _target_ct bigint;
    _tag_ct_id bigint;
    _tags_attr_id bigint;
    _path_attr_id bigint;
    _root_attr_id bigint;
    _tag_path text;
    _tag_root text;
    _existing_path text;
    _existing_root_prefix text;
    _existing_id bigint;
    _old_arr bigint[];
    _cur_arr bigint[];
    _new_arr bigint[];
    _removed bigint[];
    _value_old jsonb;
    _value_new jsonb;
    _activity_id bigint;
    _target_project_id bigint;
    _tag_project_id bigint;
    _edge_ok boolean;
BEGIN
    -- Resolve the attribute_def ids we need over and over. These are
    -- seed-installed; lookup failure means the migration didn't run.
    SELECT id INTO _tags_attr_id FROM attribute_def WHERE name = 'tags';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tag.apply: ''tags'' attribute_def missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _path_attr_id FROM attribute_def WHERE name = 'path';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tag.apply: ''path'' attribute_def missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _root_attr_id FROM attribute_def WHERE name = 'root_exclusive_at';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tag.apply: ''root_exclusive_at'' attribute_def missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _tag_ct_id FROM card_type WHERE name = 'tag';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tag.apply: ''tag'' card_type missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode + validate presence.
        BEGIN
            _target_id := NULLIF(_raw->>'target_card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _target_id := NULL;
        END;
        BEGIN
            _tag_id := NULLIF(_raw->>'tag_card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _tag_id := NULL;
        END;

        IF _target_id IS NULL OR _target_id = 0
           OR _tag_id IS NULL OR _tag_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'tag.apply: target_card_id and tag_card_id are required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Target existence + 'tags' edge declared on its card_type.
        SELECT card_type_id INTO _target_ct FROM card WHERE id = _target_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('tag.apply: target card %s not found', _target_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT TRUE INTO _edge_ok FROM edge
            WHERE card_type_id = _target_ct AND attribute_def_id = _tags_attr_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'edge_violation'::text,
                format('tag.apply: card_type id=%s does not allow ''tags''', _target_ct),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Tag card existence + must be of card_type='tag'. Pick up
        --    path / root_exclusive_at in the same lookup.
        SELECT
            (SELECT av.value #>> '{}'
               FROM attribute_value av
              WHERE av.card_id = c.id AND av.attribute_def_id = _path_attr_id),
            (SELECT av.value #>> '{}'
               FROM attribute_value av
              WHERE av.card_id = c.id AND av.attribute_def_id = _root_attr_id)
          INTO _tag_path, _tag_root
        FROM card c
        WHERE c.id = _tag_id AND c.card_type_id = _tag_ct_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'tag_not_found'::text,
                format('tag.apply: tag card %s not found or not a tag', _tag_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _tag_path IS NULL THEN
            _tag_path := '';
        END IF;
        IF _tag_root IS NULL THEN
            _tag_root := '';
        END IF;

        -- 4. Project-scope check: tag must be global or share project.
        --    Both walks go through the shared capped card_enclosing_project
        --    helper (A1/A10) — NULL means "no enclosing project" (global).
        _target_project_id := card_enclosing_project(_target_id);
        _tag_project_id := card_enclosing_project(_tag_id);

        IF _tag_project_id IS NOT NULL
           AND (_target_project_id IS NULL OR _tag_project_id <> _target_project_id) THEN
            RETURN QUERY SELECT _idx, false, 'cross_project_ref'::text,
                format('attribute %L: value card %s belongs to project %s but target is in project %s',
                    'tags', _tag_id, _tag_project_id,
                    COALESCE(_target_project_id::text, '0')),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 5. Load current tags array. card_ref[] is stored as a JSON
        --    array of numeric ids; an absent row is treated as [].
        SELECT COALESCE(
            (SELECT array_agg((e.v)::text::bigint ORDER BY e.ord)
               FROM jsonb_array_elements(av.value) WITH ORDINALITY AS e(v, ord)),
            ARRAY[]::bigint[])
          INTO _old_arr
        FROM attribute_value av
        WHERE av.card_id = _target_id AND av.attribute_def_id = _tags_attr_id;
        IF NOT FOUND OR _old_arr IS NULL THEN
            _old_arr := ARRAY[]::bigint[];
        END IF;

        -- Idempotent add: include the new tag if not already present.
        _cur_arr := _old_arr;
        IF NOT (_tag_id = ANY(_cur_arr)) THEN
            _cur_arr := array_append(_cur_arr, _tag_id);
        END IF;

        -- 6. Mutual-exclusion: when root_exclusive_at is set, drop any
        --    other currently-applied tag whose path's root matches.
        --    pathRoot(p) = everything before the first '/'; for a
        --    pathless tag the root IS the path.
        _new_arr := ARRAY[]::bigint[];
        _removed := ARRAY[]::bigint[];
        IF _tag_root <> '' THEN
            FOREACH _existing_id IN ARRAY _cur_arr LOOP
                IF _existing_id = _tag_id THEN
                    _new_arr := array_append(_new_arr, _existing_id);
                    CONTINUE;
                END IF;
                SELECT av.value #>> '{}'
                  INTO _existing_path
                FROM attribute_value av
                WHERE av.card_id = _existing_id
                  AND av.attribute_def_id = _path_attr_id;
                IF NOT FOUND OR _existing_path IS NULL THEN
                    _existing_path := '';
                END IF;
                IF position('/' IN _existing_path) > 0 THEN
                    _existing_root_prefix := substring(_existing_path
                        FROM 1 FOR position('/' IN _existing_path) - 1);
                ELSE
                    _existing_root_prefix := _existing_path;
                END IF;
                IF _existing_root_prefix = _tag_root THEN
                    _removed := array_append(_removed, _existing_id);
                ELSE
                    _new_arr := array_append(_new_arr, _existing_id);
                END IF;
            END LOOP;
        ELSE
            _new_arr := _cur_arr;
        END IF;

        -- Build numeric jsonb arrays for the activity row.
        SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY ord), '[]'::jsonb)
          INTO _value_old
        FROM unnest(_old_arr) WITH ORDINALITY AS t(v, ord);
        SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY ord), '[]'::jsonb)
          INTO _value_new
        FROM unnest(_new_arr) WITH ORDINALITY AS t(v, ord);

        -- 7. Activity + upsert.
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_target_id, 'tag_apply', _tags_attr_id, _value_old, _value_new, actor_id)
        RETURNING id INTO _activity_id;

        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_target_id, _tags_attr_id, _value_new, _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- Build the result. removed_tag_ids is JSON array of strings
        -- because reg.IDs marshals each element as a string for JS
        -- bigint safety; omit when empty so the Go `omitempty` tag
        -- elides the field uniformly.
        IF array_length(_removed, 1) IS NULL OR array_length(_removed, 1) = 0 THEN
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
                    'removed_tag_ids', (
                        SELECT jsonb_agg(v::text ORDER BY ord)
                        FROM unnest(_removed) WITH ORDINALITY AS t(v, ord)
                    )
                );
        END IF;
    END LOOP;
END;
$$;

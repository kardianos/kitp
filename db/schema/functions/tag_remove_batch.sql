-- tag.remove handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runRemove into one PL/pgSQL body.
--
-- Removing a tag mutates the target card's `tags` attribute (a
-- card_ref[] of tag card ids). Idempotent: requesting removal of a
-- tag the target does not currently hold succeeds with an unchanged
-- value (matches the Go runRemove behaviour — it simply filters and
-- writes back).
--
-- Per-row pipeline:
--   1. Cheap input validation (target_card_id required; tag_card_id
--      required so callers don't accidentally clear the whole array).
--   2. Target card existence + 'tags' edge declared for its card_type.
--   3. Load current tags array.
--   4. Filter out the tag id; write activity + attribute_value upsert.
--
-- Result JSON shape matches `tag.RemoveOutput`:
--   {"ok": true, "activity_id": "123"}
-- The bigint id is cast to text per the wire convention.
CREATE OR REPLACE FUNCTION tag_remove_batch(
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
    _tags_attr_id bigint;
    _old_arr bigint[];
    _new_arr bigint[];
    _value_old jsonb;
    _value_new jsonb;
    _activity_id bigint;
    _edge_ok boolean;
    _existing_id bigint;
BEGIN
    SELECT id INTO _tags_attr_id FROM attribute_def WHERE name = 'tags';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tag.remove: ''tags'' attribute_def missing'
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

        IF _target_id IS NULL OR _target_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'tag.remove: target_card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _tag_id IS NULL OR _tag_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'tag.remove: tag_card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Target existence + 'tags' edge declared on its card_type.
        SELECT card_type_id INTO _target_ct FROM card WHERE id = _target_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('tag.remove: target card %s not found', _target_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT TRUE INTO _edge_ok FROM edge
            WHERE card_type_id = _target_ct AND attribute_def_id = _tags_attr_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'edge_violation'::text,
                format('tag.remove: card_type id=%s does not allow ''tags''', _target_ct),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Load current tags array.
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

        -- 4. Filter the tag id out.
        _new_arr := ARRAY[]::bigint[];
        FOREACH _existing_id IN ARRAY _old_arr LOOP
            IF _existing_id <> _tag_id THEN
                _new_arr := array_append(_new_arr, _existing_id);
            END IF;
        END LOOP;

        -- Build numeric jsonb arrays for the activity row.
        SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY ord), '[]'::jsonb)
          INTO _value_old
        FROM unnest(_old_arr) WITH ORDINALITY AS t(v, ord);
        SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY ord), '[]'::jsonb)
          INTO _value_new
        FROM unnest(_new_arr) WITH ORDINALITY AS t(v, ord);

        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_target_id, 'tag_remove', _tags_attr_id, _value_old, _value_new, actor_id)
        RETURNING id INTO _activity_id;

        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_target_id, _tags_attr_id, _value_new, _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'activity_id', _activity_id::text
            );
    END LOOP;
END;
$$;

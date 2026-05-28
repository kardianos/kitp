-- _resolve_me_tokens — rewrite the dynamic "@me" person-ref token in a
-- predicate-tree JSONB to a concrete person card id.
--
-- The advanced filter (and quick-chips) can store the reserved string value
-- "@me" on a person-typed card_ref leaf (assignee / originator) to mean "the
-- current viewer". Saved filters persist "@me" verbatim so a shared screen
-- resolves PER-VIEWER; card_select_with_attributes_batch runs this pre-pass on
-- the incoming tree (with the caller's person card id) right before compiling,
-- so card_compile_predicate itself never needs the actor — it only ever sees
-- concrete ids.
--
-- The walk is a generic deep string-replace: any JSON string exactly equal to
-- "@me" becomes the numeric `me_id`. "@me" is a reserved token the client only
-- ever emits as a person card_ref value (attribute names / ops are
-- [A-Za-z0-9_]+), so a blanket replace is safe. When the caller has no linked
-- person the batch handler skips this pass entirely and "@me" stays a string —
-- it then matches no card (correct: the viewer has no person identity).
CREATE OR REPLACE FUNCTION _resolve_me_tokens(node jsonb, me_id bigint)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    _key text;
    _val jsonb;
    _out jsonb;
    _elem jsonb;
BEGIN
    IF node IS NULL THEN
        RETURN node;
    END IF;
    CASE jsonb_typeof(node)
        WHEN 'string' THEN
            IF (node #>> '{}') = '@me' THEN
                RETURN to_jsonb(me_id);
            END IF;
            RETURN node;
        WHEN 'array' THEN
            _out := '[]'::jsonb;
            FOR _elem IN SELECT value FROM jsonb_array_elements(node)
            LOOP
                _out := _out || jsonb_build_array(_resolve_me_tokens(_elem, me_id));
            END LOOP;
            RETURN _out;
        WHEN 'object' THEN
            _out := '{}'::jsonb;
            FOR _key, _val IN SELECT key, value FROM jsonb_each(node)
            LOOP
                _out := _out || jsonb_build_object(_key, _resolve_me_tokens(_val, me_id));
            END LOOP;
            RETURN _out;
        ELSE
            RETURN node;
    END CASE;
END;
$$;

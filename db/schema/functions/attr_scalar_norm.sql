-- attr_scalar_norm — the stored form of a text or bool attribute value, or
-- NULL when the value can't be one (review 2026-11-03 #4b). attribute.update
-- and card.insert store it. A text value is a JSON string (a number or bool
-- is taken as its text); a bool is a JSON boolean (or the strings 'true' /
-- 'false'). An object or array is never a text or bool, so a text attribute
-- can't carry a shape another reader mistakes for its own (the activity feed
-- read {"comment_body_id": …} out of any attr_update row).
CREATE OR REPLACE FUNCTION attr_scalar_norm(_value_type text, _value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN _value_type = 'text' THEN
            CASE jsonb_typeof(_value)
                WHEN 'string' THEN _value
                WHEN 'number' THEN to_jsonb(_value #>> '{}')
                WHEN 'boolean' THEN to_jsonb(_value #>> '{}')
            END
        WHEN _value_type = 'bool' THEN
            CASE
                WHEN jsonb_typeof(_value) = 'boolean' THEN _value
                WHEN jsonb_typeof(_value) = 'string' AND lower(_value #>> '{}') IN ('true', 'false')
                    THEN to_jsonb(lower(_value #>> '{}') = 'true')
            END
        ELSE _value
    END
$$;

-- attr_scalar_norm — the stored form of a text, bool or number attribute
-- value, or NULL when the value can't be one (review 2026-11-03 #4b, round 2
-- #15). attribute.update and card.insert store it. A text value is a JSON
-- string (a number or bool is taken as its text); a bool is a JSON boolean
-- (or the strings 'true' / 'false'); a number is a whole JSON number (or a
-- string of digits such as a text input's "2", stored as the number) that
-- fits a bigint — the attribute_value_def_ref index reads every stored
-- number as one, so 2.5 could never be stored (it failed as an internal
-- error before). An object or
-- array is never one of these, so an attribute can't carry a shape another
-- reader mistakes for its own (the activity feed read {"comment_body_id": …}
-- out of any attr_update row; sort orders are read as numbers).
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
        WHEN _value_type = 'number' THEN
            CASE
                WHEN jsonb_typeof(_value) = 'number' AND (_value #>> '{}') ~ '^-?\d{1,18}$' THEN _value
                WHEN jsonb_typeof(_value) = 'string' AND btrim(_value #>> '{}') ~ '^-?\d{1,18}$'
                    THEN to_jsonb(btrim(_value #>> '{}')::bigint)
            END
        ELSE _value
    END
$$;

-- canon_card_ref normalises a JSON value for jsonb equality against
-- stored attribute_value rows. For card_ref / card_ref[] attributes,
-- a JSON-string-of-digits is rewritten to a JSON-number (and array
-- elements likewise). All other shapes pass through. Mirrors
-- schema.Snapshot.CanonicalizeValue / cardRefValueToNumber.
--
-- Helper for card_compile_predicate; called per leaf value. Recurses
-- once into card_ref[] arrays (each element handled as a scalar
-- card_ref).
CREATE OR REPLACE FUNCTION _canon_card_ref(
    raw jsonb,
    value_type text
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    _s text;
    _n bigint;
    _el jsonb;
    _new_el jsonb;
    _out jsonb;
    _changed boolean;
BEGIN
    IF raw IS NULL OR value_type IS NULL THEN
        RETURN raw;
    END IF;
    IF value_type = 'card_ref' THEN
        IF jsonb_typeof(raw) = 'string' THEN
            _s := raw #>> '{}';
            IF _s ~ '^-?[0-9]+$' THEN
                BEGIN
                    _n := _s::bigint;
                    RETURN to_jsonb(_n);
                EXCEPTION WHEN others THEN
                    RETURN raw;
                END;
            END IF;
        END IF;
        RETURN raw;
    ELSIF value_type = 'card_ref[]' THEN
        IF jsonb_typeof(raw) <> 'array' THEN
            RETURN raw;
        END IF;
        _out := '[]'::jsonb;
        _changed := false;
        FOR _el IN SELECT value FROM jsonb_array_elements(raw)
        LOOP
            _new_el := _canon_card_ref(_el, 'card_ref');
            IF _new_el::text IS DISTINCT FROM _el::text THEN
                _changed := true;
            END IF;
            _out := _out || jsonb_build_array(_new_el);
        END LOOP;
        IF _changed THEN RETURN _out; END IF;
        RETURN raw;
    END IF;
    RETURN raw;
END;
$$;

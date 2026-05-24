-- attribute_def.select handler (Phase 5 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runSelect into one PL/pgSQL body.
--
-- One input → one result row. Lists every attribute_def with the
-- card_types it is bound to via edge rows. The optional v1 input was
-- empty (single global snapshot); we accept optional `id` / `name`
-- filters in the input for future use without changing the wire shape
-- on existing callers (absent filters → full list).
--
-- Authz (RoleAuthenticated) runs pre-tx in Go.
--
-- Result JSON shape matches `attributedef.SelectOutput`:
--   {"rows": [{"id": "<bigint>", "name": "...", "value_type": "...",
--             "target_card_type_name": "...", "is_built_in": bool,
--             "bound_to": [{"card_type_id": "<bigint>",
--                           "card_type_name": "...",
--                           "is_required": bool,
--                           "is_built_in": bool,
--                           "ordering": int}]}]}
CREATE OR REPLACE FUNCTION attribute_def_select_batch(
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
    _id bigint;
    _has_id boolean;
    _name text;
    _has_name boolean;
    _payload jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _has_id := (_raw ? 'id') AND jsonb_typeof(_raw->'id') <> 'null';
        _id := NULL;
        IF _has_id THEN
            BEGIN
                _id := NULLIF(_raw->>'id', '')::bigint;
            EXCEPTION WHEN invalid_text_representation THEN
                _id := NULL;
            END;
            _has_id := _id IS NOT NULL;
        END IF;

        _has_name := (_raw ? 'name') AND jsonb_typeof(_raw->'name') <> 'null';
        _name := NULL;
        IF _has_name THEN
            _name := _raw->>'name';
            _has_name := _name IS NOT NULL AND _name <> '';
        END IF;

        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',         ad.id::text,
                    'name',       ad.name,
                    'value_type', ad.value_type,
                    'target_card_type_name',
                        COALESCE((SELECT ct.name FROM card_type ct
                                  WHERE ct.id = ad.target_card_type_id), ''),
                    'is_built_in', ad.is_built_in,
                    'bound_to', COALESCE((
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'card_type_id',   ct.id::text,
                                'card_type_name', ct.name,
                                'is_required',    e.is_required,
                                'is_built_in',    ct.is_built_in,
                                'ordering',       e.ordering
                            ) ORDER BY e.ordering, ct.name
                        )
                        FROM edge e
                        JOIN card_type ct ON ct.id = e.card_type_id
                        WHERE e.attribute_def_id = ad.id
                    ), '[]'::jsonb)
                ) ORDER BY ad.name
            )
            FROM attribute_def ad
            WHERE (NOT _has_id   OR ad.id = _id)
              AND (NOT _has_name OR ad.name = _name)
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

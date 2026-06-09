-- flow.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runFlowList into one PL/pgSQL body.
--
-- Per-input pipeline:
--   1. Parse optional scope_card_id + attribute_def_id filters (0 / null /
--      absent → "no filter on this column").
--   2. Run the SELECT joined to attribute_def for the display name.
--
-- The shape mirrors the legacy SQL exactly so the existing
-- TestFlowSetAndList integration test keeps passing without edits.
--
-- Authz (RoleAuthenticated) runs pre-tx in Go.
--
-- Result JSON shape matches `flow.ListOutput`:
--   {"rows": [{"id": "<bigint>", "name": "...", "doc": "...",
--             "attribute_def_id": "<bigint>", "attribute_def_name": "...",
--             "scope_card_id": "<bigint>",
--             "default_create_status_id": "<bigint>",
--             "created_at": "..."}]}
CREATE OR REPLACE FUNCTION flow_list_batch(
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
    _scope_card_id bigint;
    _attr_def_id bigint;
    _payload jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _scope_card_id := COALESCE(NULLIF(_raw->>'scope_card_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _scope_card_id := 0;
        END;
        BEGIN
            _attr_def_id := COALESCE(NULLIF(_raw->>'attribute_def_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _attr_def_id := 0;
        END;

        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',                       f.id::text,
                    'name',                     f.name,
                    'doc',                      COALESCE(f.doc, ''),
                    'attribute_def_id',         f.attribute_def_id::text,
                    'attribute_def_name',       ad.name,
                    -- The card_type this flow's governed attribute_def is bound
                    -- to (status → task, comm_status → comm). The screen lists
                    -- THAT card_type, so the filter bar scopes its editor /
                    -- chips / axes to it — no hardcoded card_type per layout.
                    -- A status attribute is REQUIRED on exactly the entity type
                    -- whose lifecycle it governs (task.status / comm.comm_status
                    -- are is_required), so prefer the required binding when the
                    -- def happens to be bound (optionally) to other types too;
                    -- ct.id only breaks a genuine tie deterministically.
                    'attribute_def_card_type_name', COALESCE((
                        SELECT ct.name FROM edge e
                        JOIN card_type ct ON ct.id = e.card_type_id
                        WHERE e.attribute_def_id = f.attribute_def_id
                        ORDER BY e.is_required DESC, ct.id
                        LIMIT 1
                    ), ''),
                    'scope_card_id',            f.scope_card_id::text,
                    -- Joined display name for the scope project card (its `title`
                    -- attribute), so the UI shows a name rather than a raw id.
                    'scope_project_title',      COALESCE((
                        SELECT av.value #>> '{}'
                        FROM attribute_value av
                        JOIN attribute_def adt ON adt.id = av.attribute_def_id
                        WHERE av.card_id = f.scope_card_id AND adt.name = 'title'
                    ), ''),
                    'default_create_status_id', COALESCE(f.default_create_status_id, 0)::text,
                    -- Joined display name for the default-create status card.
                    'default_create_status_name', COALESCE((
                        SELECT av.value #>> '{}'
                        FROM attribute_value av
                        JOIN attribute_def adt ON adt.id = av.attribute_def_id
                        WHERE av.card_id = f.default_create_status_id AND adt.name = 'title'
                    ), ''),
                    'created_at',
                        to_char(f.created_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ) ORDER BY f.scope_card_id, ad.name, f.id
            )
            FROM flow f
            JOIN attribute_def ad ON ad.id = f.attribute_def_id
            WHERE (_scope_card_id = 0 OR f.scope_card_id = _scope_card_id)
              AND (_attr_def_id  = 0 OR f.attribute_def_id = _attr_def_id)
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

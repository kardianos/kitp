-- bundle.list handler — the feature bundles and presets this install
-- ships (the bundle table, materialised from db/schema/bundles/), and —
-- when project_id is given — which features that project has.
--
-- Input:  {"project_id": "<id>"}   (optional; omit for the new-project dialog)
-- Result: {
--   "features": [{"key","title","doc","sort","enabled","conflict"}, …],
--   "presets":  [{"key","title","doc","sort","features":[…]}, …]
-- }
-- enabled  — some card in the project came from this bundle (card_origin).
-- conflict — the bundle can't be added: not enabled, and the project
--            already drives one of the bundle's flow attributes itself.
--            '' when addable; otherwise the reason, ready to show.
--
-- Visibility: a project the caller can't see reads as no project (every
-- feature disabled), never as an error that would confirm it exists.
CREATE OR REPLACE FUNCTION bundle_list_batch(
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
    _project_id bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _project_id := NULLIF(NULLIF(_raw->>'project_id', ''), '0')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _project_id := NULL;
        END;
        IF _project_id IS NOT NULL AND NOT card_visible_to(actor_id, _project_id) THEN
            _project_id := NULL;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'features', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'key', b.key,
                        'title', b.title,
                        'doc', b.doc,
                        'sort', b.sort_order,
                        'enabled', COALESCE(en.hit, false),
                        'conflict', CASE
                            WHEN COALESCE(en.hit, false) OR cf.attr IS NULL THEN ''
                            ELSE format('This project already has its own %s flow.', cf.attr)
                        END
                    ) ORDER BY b.sort_order, b.key)
                    FROM bundle b
                    LEFT JOIN LATERAL (
                        SELECT true AS hit
                        FROM card_origin co
                        WHERE _project_id IS NOT NULL
                          AND co.project_id = _project_id AND co.bundle_key = b.key
                        LIMIT 1
                    ) en ON true
                    LEFT JOIN LATERAL (
                        SELECT ad.name AS attr
                        FROM flow src
                        JOIN flow tgt ON tgt.attribute_def_id = src.attribute_def_id
                                     AND tgt.scope_card_id = _project_id
                        JOIN attribute_def ad ON ad.id = src.attribute_def_id
                        WHERE _project_id IS NOT NULL
                          AND src.scope_card_id = b.source_project_id
                        ORDER BY ad.name
                        LIMIT 1
                    ) cf ON true
                    WHERE b.kind = 'feature' AND b.source_project_id IS NOT NULL
                ), '[]'::jsonb),
                'presets', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'key', b.key,
                        'title', b.title,
                        'doc', b.doc,
                        'sort', b.sort_order,
                        'features', b.features
                    ) ORDER BY b.sort_order, b.key)
                    FROM bundle b
                    WHERE b.kind = 'preset'
                ), '[]'::jsonb)
            );
    END LOOP;
END;
$$;

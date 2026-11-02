-- portal.rebuild handler — queue a portal for the portal.build job (e.g.
-- after a layout change, or to retry a failed build). Builds are
-- otherwise triggered by publication changes.
--
-- Input:  {"id": "<portal id>"}
-- Result: {"queued": true}
--
-- Authz: admin only (dispatcher AllowedRoles).
CREATE OR REPLACE FUNCTION portal_rebuild_batch(
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
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF workspace_area_off('sites') THEN
            RETURN QUERY SELECT _idx, false, 'area_off'::text,
                'portal.rebuild: Sites is switched off for this workspace'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        BEGIN
            _id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _id := 0;
        END;
        PERFORM 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'portal'
        WHERE c.id = _id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'portal_not_found'::text,
                format('portal.rebuild: portal %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;
        PERFORM portal_mark_dirty(_id);
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('queued', true);
    END LOOP;
END;
$$;

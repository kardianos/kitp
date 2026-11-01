-- bundle.apply handler — add one or more feature bundles to an existing
-- project, in the order given (see bundle_apply for the merge rules).
--
-- Input:  {"project_id": "<id>", "keys": ["publishing", …]}
-- Result: {"results": [{"key","status","copied","existing","message"}, …]}
--
-- An unknown key or a conflict fails the row ('bundle_unknown' /
-- 'bundle_conflict'), which rolls the batch back: asking for a feature
-- that can't be added is an error, not a partial success.
--
-- Authz: the dispatcher gates on card.update of the project (managers /
-- admins hold it on project cards; see bundle.go).
CREATE OR REPLACE FUNCTION bundle_apply_batch(
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
    _key text;
    _r jsonb;
    _results jsonb;
    _failed jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _project_id := COALESCE(NULLIF(_raw->>'project_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _project_id := 0;
        END;
        IF _project_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'bundle.apply: project_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF jsonb_typeof(_raw->'keys') IS DISTINCT FROM 'array'
           OR jsonb_array_length(_raw->'keys') = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'bundle.apply: keys must name at least one feature'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        PERFORM 1
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
        WHERE c.id = _project_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'project_not_found'::text,
                format('bundle.apply: project %s not found', _project_id), NULL::jsonb;
            CONTINUE;
        END IF;

        _results := '[]'::jsonb;
        _failed := NULL;
        FOR _key IN SELECT jsonb_array_elements_text(_raw->'keys')
        LOOP
            _r := bundle_apply(_project_id, _key, actor_id);
            _results := _results || jsonb_build_array(_r);
            IF _r->>'status' IN ('conflict', 'unknown') THEN
                _failed := _r;
                EXIT;
            END IF;
        END LOOP;

        IF _failed IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false,
                CASE WHEN _failed->>'status' = 'conflict' THEN 'bundle_conflict' ELSE 'bundle_unknown' END,
                _failed->>'message', NULL::jsonb;
            CONTINUE;
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('results', _results);
    END LOOP;
END;
$$;

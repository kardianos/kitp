-- bundle_apply — merge one feature bundle into a project (the shared core
-- of bundle.apply and project.compose).
--
-- Looks up the bundle's hidden source project (bundle table, materialised
-- by store.ApplySchema from db/schema/bundles/<key>.hcsv) and
-- merge-copies it into project_id via copy_project_template_merge with
-- origin = the bundle key, so every copied card records its provenance.
--
-- Features ADD, they never modify: a bundle that has never been applied to
-- the project is refused ('conflict') when one of its flows binds an
-- attribute the project already drives with a flow of its own (e.g. the
-- conversations bundle on a project stamped from a template that carries a
-- comm flow). Half-applying would leave orphan status cards outside the
-- project's flow. A bundle applied before is a re-apply: it maps onto what
-- is there and adds only items (and flow steps) that are missing — a
-- newer bundle version's additions, or nothing.
--
-- An advisory lock on (project, bundle) serialises concurrent applies.
--
-- Returns {"key", "status", "copied", "existing", "message"} where status
-- is 'applied' (first time), 'updated' (re-apply), 'conflict' or
-- 'unknown' (no such feature bundle). Never raises for those cases; the
-- callers decide whether a conflict fails the request.
CREATE OR REPLACE FUNCTION bundle_apply(project_id bigint, bundle_key text, actor_id bigint)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    _source bigint;
    _title text;
    _applied_before boolean;
    _conflict text;
    _r jsonb;
BEGIN
    SELECT b.source_project_id, b.title INTO _source, _title
    FROM bundle b
    WHERE b.key = bundle_apply.bundle_key AND b.kind = 'feature';
    IF NOT FOUND OR _source IS NULL THEN
        RETURN jsonb_build_object('key', bundle_key, 'status', 'unknown',
            'copied', 0, 'existing', 0,
            'message', format('no feature bundle %L', bundle_key));
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('kitp.bundle:' || project_id::text || ':' || bundle_key, 0));

    SELECT EXISTS (
        SELECT 1 FROM card_origin co
        WHERE co.project_id = bundle_apply.project_id
          AND co.bundle_key = bundle_apply.bundle_key
    ) INTO _applied_before;

    IF NOT _applied_before THEN
        SELECT ad.name INTO _conflict
        FROM flow src
        JOIN flow tgt ON tgt.attribute_def_id = src.attribute_def_id
                     AND tgt.scope_card_id = bundle_apply.project_id
        JOIN attribute_def ad ON ad.id = src.attribute_def_id
        WHERE src.scope_card_id = _source
        ORDER BY ad.name
        LIMIT 1;
        IF _conflict IS NOT NULL THEN
            RETURN jsonb_build_object('key', bundle_key, 'status', 'conflict',
                'copied', 0, 'existing', 0,
                'message', format('%s can''t be added: this project already has its own %s flow',
                                  _title, _conflict));
        END IF;
    END IF;

    _r := copy_project_template_merge(_source, project_id, actor_id, bundle_key);
    RETURN jsonb_build_object(
        'key', bundle_key,
        'status', CASE WHEN _applied_before THEN 'updated' ELSE 'applied' END,
        'copied', COALESCE((_r->>'copied')::int, 0),
        'existing', COALESCE((_r->>'existing')::int, 0),
        'message', '');
END;
$$;

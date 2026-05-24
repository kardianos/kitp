-- comm_log.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runCommLogList into one PL/pgSQL body. Admin-only
-- (gated Go-side via authzAdmin).
--
-- Per-row pipeline:
--   1. Validation: project_id is required.
--   2. Decode optional kind / since / limit; cap limit at 1000, default 200.
--   3. Emit comm_log rows for the project + matching kind + at >= since
--      (defaults to now() - interval '24 hours' when empty), joined
--      with the channel's title attribute_value so the admin UI can
--      label the row even after channel rename / delete.
--
-- Result JSON shape matches `comm.CommLogListOutput`.
CREATE OR REPLACE FUNCTION comm_log_list_batch(
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
    _kind text;
    _since text;
    _limit int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _project_id := NULLIF(_raw->>'project_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _project_id := NULL;
        END;
        IF _project_id IS NULL OR _project_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_log.list: project_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        _kind := COALESCE(_raw->>'kind', '');
        _since := COALESCE(_raw->>'since', '');
        _limit := COALESCE(NULLIF(_raw->>'limit', '')::int, 200);
        IF _limit <= 0 THEN
            _limit := 200;
        END IF;
        IF _limit > 1000 THEN
            _limit := 1000;
        END IF;

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(row_obj ORDER BY at_ts DESC, log_id DESC)
                FROM (
                    SELECT cl.id AS log_id, cl.at AS at_ts,
                           jsonb_build_object(
                               'id',           cl.id::text,
                               'channel_id',   COALESCE(cl.channel_id, 0)::text,
                               'channel_name', COALESCE((
                                   SELECT av.value #>> '{}'
                                   FROM attribute_value av
                                   JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                   WHERE av.card_id = cl.channel_id AND ad.name = 'title'
                               ), ''),
                               'kind',         cl.kind,
                               'detail',       cl.detail,
                               'at',           to_char(cl.at AT TIME ZONE 'UTC',
                                                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                           ) AS row_obj
                    FROM comm_log cl
                    WHERE cl.project_id = _project_id
                      AND (_kind = '' OR cl.kind = _kind)
                      AND cl.at >= COALESCE(NULLIF(_since, '')::timestamptz,
                                            now() - interval '24 hours')
                    ORDER BY cl.at DESC, cl.id DESC
                    LIMIT _limit
                ) sub
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

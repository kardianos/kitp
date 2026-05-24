-- activity_sink.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runSinkList into one PL/pgSQL body.
--
-- One input → one result row. Lists every activity_sink card under
-- input.project_id, joined with activity_sink_secret (so
-- has_client_secret reflects storage without exposing the encrypted
-- bytes) and activity_sink_state (last_activity_id pointer +
-- last_pushed_at + last_pushed_count + last_error from the pump).
--
-- Authz (admin) runs pre-tx in Go.
--
-- Result JSON shape matches `activitysink.SinkListOutput`:
--   {"rows": [{"id": "<bigint>", "name": "...", ...,
--             "has_client_secret": bool, "last_activity_id": "<bigint>",
--             "last_pushed_at": "...", "last_pushed_count": "<bigint>",
--             "last_error": "...", "created_at": "..."}]}
CREATE OR REPLACE FUNCTION activity_sink_list_batch(
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
    _payload jsonb;
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
                'activity_sink.list: project_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        WITH sink_attrs AS (
            SELECT c.id AS sink_id, c.created_at,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              JOIN attribute_def ad ON ad.id = av.attribute_def_id
                              WHERE av.card_id = c.id AND ad.name='title'),'')                AS title,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              JOIN attribute_def ad ON ad.id = av.attribute_def_id
                              WHERE av.card_id = c.id AND ad.name='sink_kind'),'')             AS sink_kind,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              JOIN attribute_def ad ON ad.id = av.attribute_def_id
                              WHERE av.card_id = c.id AND ad.name='msgraph_tenant_id'),'')     AS msgraph_tenant_id,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              JOIN attribute_def ad ON ad.id = av.attribute_def_id
                              WHERE av.card_id = c.id AND ad.name='msgraph_client_id'),'')     AS msgraph_client_id,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              JOIN attribute_def ad ON ad.id = av.attribute_def_id
                              WHERE av.card_id = c.id AND ad.name='msgraph_team_id'),'')       AS msgraph_team_id,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              JOIN attribute_def ad ON ad.id = av.attribute_def_id
                              WHERE av.card_id = c.id AND ad.name='msgraph_channel_id'),'')    AS msgraph_channel_id,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              JOIN attribute_def ad ON ad.id = av.attribute_def_id
                              WHERE av.card_id = c.id AND ad.name='activity_filter'),'')       AS activity_filter,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              JOIN attribute_def ad ON ad.id = av.attribute_def_id
                              WHERE av.card_id = c.id AND ad.name='channel_status'),'enabled') AS channel_status,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              JOIN attribute_def ad ON ad.id = av.attribute_def_id
                              WHERE av.card_id = c.id AND ad.name='channel_fault_reason'),'')  AS channel_fault_reason
            FROM card c
            JOIN card_type ct ON ct.id = c.card_type_id
            WHERE ct.name = 'activity_sink'
              AND c.parent_card_id = _project_id
              AND c.deleted_at IS NULL
        )
        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',                   sa.sink_id::text,
                    'name',                 sa.title,
                    'sink_kind',            sa.sink_kind,
                    'msgraph_tenant_id',    sa.msgraph_tenant_id,
                    'msgraph_client_id',    sa.msgraph_client_id,
                    'msgraph_team_id',      sa.msgraph_team_id,
                    'msgraph_channel_id',   sa.msgraph_channel_id,
                    'activity_filter',      sa.activity_filter,
                    'channel_status',       sa.channel_status,
                    'channel_fault_reason', sa.channel_fault_reason,
                    'has_client_secret',    (ss.client_secret IS NOT NULL),
                    'last_activity_id',     COALESCE(st.last_activity_id, 0)::text,
                    'last_pushed_at',
                        CASE WHEN st.last_pushed_at IS NULL THEN ''
                             ELSE to_char(st.last_pushed_at AT TIME ZONE 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                        END,
                    'last_pushed_count',    COALESCE(st.last_pushed_count, 0)::text,
                    'last_error',           COALESCE(st.last_error, ''),
                    'created_at',
                        to_char(sa.created_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ) ORDER BY sa.title, sa.sink_id
            )
            FROM sink_attrs sa
            LEFT JOIN activity_sink_secret ss ON ss.sink_card_id = sa.sink_id
            LEFT JOIN activity_sink_state  st ON st.sink_card_id = sa.sink_id
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

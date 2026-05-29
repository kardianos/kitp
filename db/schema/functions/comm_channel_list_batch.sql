-- comm_channel.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runChannelList into one PL/pgSQL body.
-- Admin-only (gated Go-side via authzAdmin).
--
-- Per-row pipeline:
--   1. Validation: project_id is required.
--   2. List comm_channel cards under the project (soft-deleted
--      excluded). For each: hoist its title / channel_type / imap_* /
--      smtp_* / from_address / intake_status / channel_status /
--      channel_fault_reason attribute_values inline; join the paired
--      comm_secret row to surface has_imap_password /
--      has_smtp_password without exposing encrypted bytes.
--
-- Result JSON shape matches `comm.ChannelListOutput`.
CREATE OR REPLACE FUNCTION comm_channel_list_batch(
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
    _project_id bigint;
BEGIN
    FOR _idx, _project_id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'project_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _project_id IS NULL OR _project_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.list: project_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(channel_obj ORDER BY title, channel_id)
                FROM (
                    SELECT
                        c.id AS channel_id,
                        COALESCE((
                            SELECT av.value #>> '{}'
                            FROM attribute_value av
                            JOIN attribute_def ad ON ad.id = av.attribute_def_id
                            WHERE av.card_id = c.id AND ad.name='title'
                        ), '') AS title,
                        jsonb_build_object(
                            'id',                   c.id::text,
                            'name',                 COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='title'
                            ), ''),
                            'channel_type',         COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='channel_type'
                            ), ''),
                            'imap_host',            COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='imap_host'
                            ), ''),
                            'imap_port',            COALESCE((
                                SELECT (av.value)::text::int
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='imap_port'
                                  AND jsonb_typeof(av.value)='number'
                            ), 0),
                            'imap_username',        COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='imap_username'
                            ), ''),
                            'smtp_host',            COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='smtp_host'
                            ), ''),
                            'smtp_port',            COALESCE((
                                SELECT (av.value)::text::int
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='smtp_port'
                                  AND jsonb_typeof(av.value)='number'
                            ), 0),
                            'smtp_username',        COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='smtp_username'
                            ), ''),
                            'from_address',         COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='from_address'
                            ), ''),
                            'intake_status_id',     COALESCE((
                                SELECT (av.value)::text::bigint
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='intake_status'
                                  AND jsonb_typeof(av.value)='number'
                            ), 0)::text,
                            'channel_status',       COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='channel_status'
                            ), 'enabled'),
                            'channel_fault_reason', COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='channel_fault_reason'
                            ), ''),
                            'signature_mode',       COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name='signature_mode'
                            ), ''),
                            'has_imap_password',    (cs.imap_password IS NOT NULL),
                            'has_smtp_password',    (cs.smtp_password IS NOT NULL),
                            'created_at',           to_char(c.created_at AT TIME ZONE 'UTC',
                                                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                        ) AS channel_obj
                    FROM card c
                    JOIN card_type ct ON ct.id = c.card_type_id
                    LEFT JOIN comm_secret cs ON cs.channel_card_id = c.id
                    WHERE ct.name = 'comm_channel'
                      AND c.parent_card_id = _project_id
                      AND c.deleted_at IS NULL
                ) channels
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

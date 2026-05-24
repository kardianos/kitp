-- comm.list_for_task handler (Phase 5 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runCommListForTask + loadRepliesByID +
-- decodeCardRefArray into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: task_id is required.
--   2. List comm cards under the task — soft-deleted excluded, gated
--      by the per-actor visibility predicate (B7) — that walks the
--      parent_card_id chain up to the enclosing project. Each comm
--      row is built into a JSONB object with its title / thread_id /
--      channel_ref / comm_status, plus hydrated replies and
--      recipients (both extracted from their stored card_ref[]
--      attribute_value lists; legacy string-form ids are tolerated
--      and canonicalised to numbers).
--
-- Result JSON shape matches `comm.CommListForTaskOutput`:
--   {"rows": [{
--      "id": "<bigint>", "title": "...", "thread_id": "...",
--      "channel_id": "<bigint>", "comm_status": "<bigint>",
--      "recipients": ["<bigint>", ...],
--      "replies": [{
--         "id": "<bigint>", "to": "...", "from": "...",
--         "subject": "...", "body_text": "...",
--         "delivery_status": "...", "created_at": "RFC3339"
--      }]
--   }]}
CREATE OR REPLACE FUNCTION comm_list_for_task_batch(
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
    _task_id bigint;
BEGIN
    FOR _idx, _task_id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'task_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _task_id IS NULL OR _task_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm.list_for_task: task_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(comm_row ORDER BY comm_id)
                FROM (
                    SELECT
                        c.id AS comm_id,
                        jsonb_build_object(
                            'id',          c.id::text,
                            'title',       COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name = 'title'
                            ), ''),
                            'thread_id',   COALESCE((
                                SELECT av.value #>> '{}'
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name = 'thread_id'
                            ), ''),
                            'channel_id',  COALESCE((
                                SELECT (av.value)::text::bigint
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name = 'channel_ref'
                                  AND jsonb_typeof(av.value) = 'number'
                            ), 0)::text,
                            'comm_status', COALESCE((
                                SELECT (av.value)::text::bigint
                                FROM attribute_value av
                                JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                WHERE av.card_id = c.id AND ad.name = 'comm_status'
                                  AND jsonb_typeof(av.value) = 'number'
                            ), 0)::text,
                            'recipients',  (
                                -- Decode comm_recipients card_ref[] —
                                -- tolerate stored ints + numeric strings,
                                -- emit as a JSON array of stringified
                                -- bigints (the Go reg.IDs type).
                                SELECT COALESCE(jsonb_agg(
                                    CASE
                                        WHEN jsonb_typeof(e.v) = 'number'
                                            THEN to_jsonb(((e.v)::text::bigint)::text)
                                        WHEN jsonb_typeof(e.v) = 'string'
                                             AND (e.v #>> '{}') ~ '^-?[0-9]+$'
                                            THEN to_jsonb(((e.v #>> '{}')::bigint)::text)
                                        ELSE NULL
                                    END
                                    ORDER BY e.ord
                                ) FILTER (WHERE
                                    jsonb_typeof(e.v) = 'number'
                                    OR (jsonb_typeof(e.v) = 'string'
                                        AND (e.v #>> '{}') ~ '^-?[0-9]+$')
                                ), '[]'::jsonb)
                                FROM jsonb_array_elements(
                                    COALESCE((
                                        SELECT av.value
                                        FROM attribute_value av
                                        JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                        WHERE av.card_id = c.id AND ad.name = 'comm_recipients'
                                    ), '[]'::jsonb)
                                ) WITH ORDINALITY AS e(v, ord)
                            ),
                            'replies', COALESCE((
                                -- Resolve replies card_ref[] then hydrate
                                -- each reply_body card; preserve the
                                -- stored order; skip ids that don't
                                -- resolve to a live reply_body card.
                                SELECT jsonb_agg(reply_obj ORDER BY ord)
                                FROM (
                                    SELECT e.ord,
                                           jsonb_build_object(
                                               'id',              rb.id::text,
                                               'to',              COALESCE((
                                                   SELECT av.value #>> '{}'
                                                   FROM attribute_value av
                                                   JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                                   WHERE av.card_id = rb.id AND ad.name = 'reply_to'
                                               ), ''),
                                               'from',            COALESCE((
                                                   SELECT av.value #>> '{}'
                                                   FROM attribute_value av
                                                   JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                                   WHERE av.card_id = rb.id AND ad.name = 'reply_from'
                                               ), ''),
                                               'subject',         COALESCE((
                                                   SELECT av.value #>> '{}'
                                                   FROM attribute_value av
                                                   JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                                   WHERE av.card_id = rb.id AND ad.name = 'reply_subject'
                                               ), ''),
                                               'body_text',       COALESCE((
                                                   SELECT av.value #>> '{}'
                                                   FROM attribute_value av
                                                   JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                                   WHERE av.card_id = rb.id AND ad.name = 'reply_body_text'
                                               ), ''),
                                               'delivery_status', COALESCE((
                                                   SELECT av.value #>> '{}'
                                                   FROM attribute_value av
                                                   JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                                   WHERE av.card_id = rb.id AND ad.name = 'delivery_status'
                                               ), ''),
                                               'created_at',      to_char(rb.created_at AT TIME ZONE 'UTC',
                                                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                                           ) AS reply_obj
                                    FROM jsonb_array_elements(
                                        COALESCE((
                                            SELECT av.value
                                            FROM attribute_value av
                                            JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                            WHERE av.card_id = c.id AND ad.name = 'replies'
                                        ), '[]'::jsonb)
                                    ) WITH ORDINALITY AS e(v, ord)
                                    JOIN card rb ON rb.id = CASE
                                        WHEN jsonb_typeof(e.v) = 'number'
                                            THEN (e.v)::text::bigint
                                        WHEN jsonb_typeof(e.v) = 'string'
                                             AND (e.v #>> '{}') ~ '^-?[0-9]+$'
                                            THEN (e.v #>> '{}')::bigint
                                        ELSE NULL
                                    END
                                    WHERE rb.deleted_at IS NULL
                                ) hydrated
                            ), '[]'::jsonb)
                        ) AS comm_row
                    FROM card c
                    JOIN card_type ct ON ct.id = c.card_type_id
                    WHERE ct.name = 'comm'
                      AND c.parent_card_id = _task_id
                      AND c.deleted_at IS NULL
                      AND EXISTS (
                        WITH RECURSIVE up(id, parent_card_id, card_type_id) AS (
                            SELECT card.id, card.parent_card_id, card.card_type_id
                            FROM card WHERE card.id = c.id
                            UNION ALL
                            SELECT p.id, p.parent_card_id, p.card_type_id
                            FROM card p JOIN up ON p.id = up.parent_card_id
                        )
                        SELECT 1
                        FROM user_account caller
                        JOIN user_role ur
                          ON ur.user_id = caller.id
                          OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
                        WHERE caller.id = comm_list_for_task_batch.actor_id
                          AND (
                            ur.scope_card_id IS NULL
                            OR ur.scope_card_id IN (
                                SELECT up.id
                                FROM up JOIN card_type ct2 ON ct2.id = up.card_type_id
                                WHERE ct2.name = 'project'
                            )
                          )
                      )
                ) commrows
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

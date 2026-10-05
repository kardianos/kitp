-- activity_subscription.sinks handler — the email activity_sinks the
-- caller can subscribe to.
--
-- Every live activity_sink with sink_kind = 'email' under a live project
-- the caller can see (DI-6: the caller — or, for an agent, its parent —
-- holds a global role or one scoped to that project). The account page's
-- "Add subscription" picker lists these as "Project — Sink".
--
-- Result JSON shape matches `activitysink.SubscriptionSinksOutput`:
--   {"rows": [{"sink_id": "<bigint>", "sink_name": "...", "project_id": "<bigint>",
--              "project_name": "...", "channel_name": "...", "sink_status": "..."}]}
CREATE OR REPLACE FUNCTION activity_subscription_sinks_batch(
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
    _title_def bigint;
    _kind_def bigint;
    _status_def bigint;
    _channel_ref_def bigint;
    _idx int;
    _payload jsonb;
BEGIN
    SELECT id INTO _title_def       FROM attribute_def WHERE name = 'title';
    SELECT id INTO _kind_def        FROM attribute_def WHERE name = 'sink_kind';
    SELECT id INTO _status_def      FROM attribute_def WHERE name = 'channel_status';
    SELECT id INTO _channel_ref_def FROM attribute_def WHERE name = 'channel_ref';

    FOR _idx IN
        SELECT (r.ord - 1)::int
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        WITH sinks AS (
            SELECT sink.id AS sink_id, proj.id AS project_id
            FROM card sink
            JOIN card_type ct ON ct.id = sink.card_type_id AND ct.name = 'activity_sink'
            JOIN card proj ON proj.id = sink.parent_card_id AND proj.deleted_at IS NULL
            JOIN attribute_value kind ON kind.card_id = sink.id
                                     AND kind.attribute_def_id = _kind_def
                                     AND kind.value = to_jsonb('email'::text)
            WHERE sink.deleted_at IS NULL
              AND EXISTS (
                  SELECT 1
                  FROM user_account caller
                  JOIN user_role ur
                    ON ur.user_id = caller.id
                    OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
                  WHERE caller.id = activity_subscription_sinks_batch.actor_id
                    AND (ur.scope_card_id IS NULL OR ur.scope_card_id = proj.id)
              )
        ),
        named_sinks AS (
            SELECT s.sink_id, s.project_id,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              WHERE av.card_id = s.sink_id AND av.attribute_def_id = _title_def), '') AS sink_name,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              WHERE av.card_id = s.project_id AND av.attribute_def_id = _title_def), '') AS project_name,
                   COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                              WHERE av.card_id = s.sink_id AND av.attribute_def_id = _status_def), 'enabled') AS sink_status,
                   COALESCE((SELECT ca.value #>> '{}'
                               FROM attribute_value cr
                               JOIN attribute_value ca ON ca.card_id = (cr.value)::text::bigint
                                                      AND ca.attribute_def_id = _title_def
                              WHERE cr.card_id = s.sink_id AND cr.attribute_def_id = _channel_ref_def
                                AND jsonb_typeof(cr.value) = 'number'), '') AS channel_name
            FROM sinks s
        )
        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'sink_id',      n.sink_id::text,
                    'sink_name',    n.sink_name,
                    'project_id',   n.project_id::text,
                    'project_name', n.project_name,
                    'channel_name', n.channel_name,
                    'sink_status',  n.sink_status
                ) ORDER BY lower(n.project_name), lower(n.sink_name), n.sink_id
            )
            FROM named_sinks n
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

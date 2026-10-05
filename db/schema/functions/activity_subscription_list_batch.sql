-- activity_subscription.list handler — the caller's own notification
-- subscriptions.
--
-- Returns every live activity_subscription whose `subscriber` is the
-- caller's linked person card, under a live sink, in a project the caller
-- can still see (DI-6: a global role or a role scoped to that project —
-- the sink's parent IS the project, so the ancestor walk collapses to that
-- one card). Optional input.project_id narrows to one project. Joined
-- with the sink / project / comm channel titles and the pump's
-- activity_sink_state row (last delivery, last error, rollup clock).
--
-- Result JSON shape matches `activitysink.SubscriptionListOutput`:
--   {"rows": [{"id": "<bigint>", "name": "...", "sink_id": "<bigint>", ...}]}
CREATE OR REPLACE FUNCTION activity_subscription_list_batch(
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
    _person_id bigint;
    _title_def bigint;
    _subscriber_def bigint;
    _filter_def bigint;
    _predicate_def bigint;
    _rollup_def bigint;
    _status_def bigint;
    _fault_def bigint;
    _channel_ref_def bigint;
    _idx int;
    _raw jsonb;
    _project_id bigint;
    _payload jsonb;
BEGIN
    SELECT uap.person_card_id INTO _person_id
      FROM user_account_person uap
      WHERE uap.user_account_id = activity_subscription_list_batch.actor_id;
    SELECT id INTO _title_def       FROM attribute_def WHERE name = 'title';
    SELECT id INTO _subscriber_def  FROM attribute_def WHERE name = 'subscriber';
    SELECT id INTO _filter_def      FROM attribute_def WHERE name = 'activity_filter';
    SELECT id INTO _predicate_def   FROM attribute_def WHERE name = 'predicate';
    SELECT id INTO _rollup_def      FROM attribute_def WHERE name = 'rollup_minutes';
    SELECT id INTO _status_def      FROM attribute_def WHERE name = 'channel_status';
    SELECT id INTO _fault_def       FROM attribute_def WHERE name = 'channel_fault_reason';
    SELECT id INTO _channel_ref_def FROM attribute_def WHERE name = 'channel_ref';

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _project_id := COALESCE(NULLIF(_raw->>'project_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity_subscription.list: project_id must be a numeric id'::text, NULL::jsonb;
            CONTINUE;
        END;

        -- Seed from the caller's subscriber rows: the (attribute_def_id,
        -- value) btree finds exactly this person's subscription cards.
        WITH subs AS (
            SELECT sub.id, sub.created_at, sink.id AS sink_id, proj.id AS project_id
            FROM attribute_value owner
            JOIN card sub ON sub.id = owner.card_id AND sub.deleted_at IS NULL
            JOIN card_type sct ON sct.id = sub.card_type_id AND sct.name = 'activity_subscription'
            JOIN card sink ON sink.id = sub.parent_card_id AND sink.deleted_at IS NULL
            JOIN card proj ON proj.id = sink.parent_card_id AND proj.deleted_at IS NULL
            WHERE _person_id IS NOT NULL
              AND owner.attribute_def_id = _subscriber_def
              AND owner.value = to_jsonb(_person_id)
              AND owner.value_type_id < 1000
              AND (_project_id = 0 OR proj.id = _project_id)
              AND EXISTS (
                  SELECT 1
                  FROM user_account caller
                  JOIN user_role ur
                    ON ur.user_id = caller.id
                    OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
                  WHERE caller.id = activity_subscription_list_batch.actor_id
                    AND (ur.scope_card_id IS NULL OR ur.scope_card_id = proj.id)
              )
        )
        SELECT jsonb_build_object('rows', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id',                   s.id::text,
                    'name',                 COALESCE((SELECT av.value #>> '{}' FROM attribute_value av WHERE av.card_id = s.id AND av.attribute_def_id = _title_def), ''),
                    'sink_id',              s.sink_id::text,
                    'sink_name',            COALESCE((SELECT av.value #>> '{}' FROM attribute_value av WHERE av.card_id = s.sink_id AND av.attribute_def_id = _title_def), ''),
                    'sink_status',          COALESCE((SELECT av.value #>> '{}' FROM attribute_value av WHERE av.card_id = s.sink_id AND av.attribute_def_id = _status_def), 'enabled'),
                    'project_id',           s.project_id::text,
                    'project_name',         COALESCE((SELECT av.value #>> '{}' FROM attribute_value av WHERE av.card_id = s.project_id AND av.attribute_def_id = _title_def), ''),
                    'channel_name',         COALESCE((SELECT ca.value #>> '{}'
                                                        FROM attribute_value cr
                                                        JOIN attribute_value ca ON ca.card_id = (cr.value)::text::bigint
                                                                               AND ca.attribute_def_id = _title_def
                                                       WHERE cr.card_id = s.sink_id AND cr.attribute_def_id = _channel_ref_def
                                                         AND jsonb_typeof(cr.value) = 'number'), ''),
                    'activity_filter',      COALESCE((SELECT av.value #>> '{}' FROM attribute_value av WHERE av.card_id = s.id AND av.attribute_def_id = _filter_def), ''),
                    'card_filter',          COALESCE((SELECT av.value #>> '{}' FROM attribute_value av WHERE av.card_id = s.id AND av.attribute_def_id = _predicate_def), ''),
                    'rollup_minutes',       COALESCE((SELECT (av.value)::text::numeric::int FROM attribute_value av WHERE av.card_id = s.id AND av.attribute_def_id = _rollup_def AND jsonb_typeof(av.value) = 'number'), 0),
                    'channel_status',       COALESCE((SELECT av.value #>> '{}' FROM attribute_value av WHERE av.card_id = s.id AND av.attribute_def_id = _status_def), 'enabled'),
                    'channel_fault_reason', COALESCE((SELECT av.value #>> '{}' FROM attribute_value av WHERE av.card_id = s.id AND av.attribute_def_id = _fault_def), ''),
                    'last_pushed_at',
                        CASE WHEN st.last_pushed_at IS NULL THEN ''
                             ELSE to_char(st.last_pushed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                        END,
                    'last_pushed_count',    COALESCE(st.last_pushed_count, 0)::text,
                    'last_error',           COALESCE(st.last_error, ''),
                    'pending_since',
                        CASE WHEN st.pending_since IS NULL THEN ''
                             ELSE to_char(st.pending_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                        END,
                    'created_at',
                        to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ) ORDER BY s.project_id, s.id
            )
            FROM subs s
            LEFT JOIN activity_sink_state st ON st.sink_card_id = s.id
        ), '[]'::jsonb))
        INTO _payload;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

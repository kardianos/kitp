-- activity_sink.set handler (Phase 3 of UNIFIED_HANDLER_PLAN.md). Folds
-- runSinkSet + validateSinkSet + sinkFieldWrites + upsertSinkSecret
-- into one PL/pgSQL body.
--
-- Mirrors comm_channel.set's shape: insert an activity_sink card under
-- the project, write per-attribute rows for the MS Graph + filter +
-- channel-status fields via a set-based ordinality join (one activity
-- + attribute_value upsert per attribute, written in two statements),
-- then upsert the paired activity_sink_secret row using pgcrypto's
-- pgp_sym_encrypt with the per-connection `app.comm_secret_key` GUC.
--
-- Per-row pipeline:
--   1. Validation: name + sink_kind + project_id required.
--      sink_kind must be 'msgraph_teams'. project_id must exist + be
--      a project. On update (id != 0) the sink card must exist, be of
--      card_type='activity_sink', and live under the same project.
--      Optional channel_status must be one of the three valid values.
--      Optional activity_filter must parse as JSON.
--   2. Insert sink card (id=0) + card_create activity; otherwise reuse
--      the supplied id.
--   3. Set-based write of the field attributes — title + sink_kind are
--      always written; optional fields are only written when present
--      (PATCH semantics matching the Go path). When channel_status is
--      'enabled' we additionally clear channel_fault_reason.
--   4. Upsert activity_sink_secret. NULL secret (key absent) preserves
--      the existing value; non-NULL encrypts and replaces.
--
-- Result JSON shape matches `activitysink.SinkSetOutput`:
--   {"sink_id": "<bigint>"}
--
-- Authz (admin gate) runs pre-tx in Go.
CREATE OR REPLACE FUNCTION activity_sink_set_batch(
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
    _sink_ct_id bigint;
    _title_def bigint;
    _sink_kind_def bigint;
    _tenant_def bigint;
    _client_id_def bigint;
    _team_def bigint;
    _channel_def bigint;
    _filter_def bigint;
    _status_def bigint;
    _fault_def bigint;
    _idx int;
    _raw jsonb;
    _id bigint;
    _project_id bigint;
    _name text;
    _sink_kind text;
    _tenant_id text;
    _client_id text;
    _client_secret text;
    _client_secret_present boolean;
    _team_id text;
    _channel_id text;
    _activity_filter text;
    _status text;
    _parent_kind text;
    _existing_kind text;
    _existing_parent bigint;
    _sink_id bigint;
    _writes jsonb;
BEGIN
    -- Hoist constants used every row.
    SELECT id INTO _sink_ct_id FROM card_type WHERE name = 'activity_sink';
    IF _sink_ct_id IS NULL THEN
        RAISE EXCEPTION 'activity_sink.set: card_type activity_sink missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _title_def     FROM attribute_def WHERE name = 'title';
    SELECT id INTO _sink_kind_def FROM attribute_def WHERE name = 'sink_kind';
    SELECT id INTO _tenant_def    FROM attribute_def WHERE name = 'msgraph_tenant_id';
    SELECT id INTO _client_id_def FROM attribute_def WHERE name = 'msgraph_client_id';
    SELECT id INTO _team_def      FROM attribute_def WHERE name = 'msgraph_team_id';
    SELECT id INTO _channel_def   FROM attribute_def WHERE name = 'msgraph_channel_id';
    SELECT id INTO _filter_def    FROM attribute_def WHERE name = 'activity_filter';
    SELECT id INTO _status_def    FROM attribute_def WHERE name = 'channel_status';
    SELECT id INTO _fault_def     FROM attribute_def WHERE name = 'channel_fault_reason';
    IF _title_def IS NULL OR _sink_kind_def IS NULL OR _tenant_def IS NULL
       OR _client_id_def IS NULL OR _team_def IS NULL OR _channel_def IS NULL
       OR _filter_def IS NULL OR _status_def IS NULL OR _fault_def IS NULL THEN
        RAISE EXCEPTION 'activity_sink.set: one of the sink attribute_defs is missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _id := 0;
        END;
        BEGIN
            _project_id := COALESCE(NULLIF(_raw->>'project_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _project_id := 0;
        END;
        _name := _raw->>'name';
        _sink_kind := _raw->>'sink_kind';
        _tenant_id := COALESCE(_raw->>'msgraph_tenant_id', '');
        _client_id := COALESCE(_raw->>'msgraph_client_id', '');
        _team_id := COALESCE(_raw->>'msgraph_team_id', '');
        _channel_id := COALESCE(_raw->>'msgraph_channel_id', '');
        _activity_filter := COALESCE(_raw->>'activity_filter', '');
        _status := COALESCE(_raw->>'channel_status', '');
        -- omit-vs-clear distinction for the secret: key absent → preserve;
        -- key present (even empty) → write through (pgp_sym_encrypt of "").
        _client_secret_present := (_raw ? 'msgraph_client_secret')
                                   AND jsonb_typeof(_raw->'msgraph_client_secret') <> 'null';
        IF _client_secret_present THEN
            _client_secret := _raw->>'msgraph_client_secret';
        ELSE
            _client_secret := NULL;
        END IF;

        -- 1. Validation.
        IF _name IS NULL OR _name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity_sink.set: name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _sink_kind IS NULL OR _sink_kind = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity_sink.set: sink_kind is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _sink_kind <> 'msgraph_teams' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('activity_sink.set: sink_kind %L is not supported (v1: %L only)',
                    _sink_kind, 'msgraph_teams'),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _project_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity_sink.set: project_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT ct.name INTO _parent_kind
          FROM card c JOIN card_type ct ON ct.id = c.card_type_id
          WHERE c.id = _project_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'project_not_found'::text,
                format('activity_sink.set: project_id %s not found', _project_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _parent_kind <> 'project' THEN
            RETURN QUERY SELECT _idx, false, 'parent_not_project'::text,
                format('activity_sink.set: project_id %s is %L, not a project',
                    _project_id, _parent_kind),
                NULL::jsonb;
            CONTINUE;
        END IF;

        IF _id <> 0 THEN
            SELECT ct.name, c.parent_card_id
              INTO _existing_kind, _existing_parent
              FROM card c JOIN card_type ct ON ct.id = c.card_type_id
              WHERE c.id = _id;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'sink_not_found'::text,
                    format('activity_sink.set: sink %s not found', _id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _existing_kind <> 'activity_sink' THEN
                RETURN QUERY SELECT _idx, false, 'wrong_card_type'::text,
                    format('activity_sink.set: card %s is %L, not activity_sink',
                        _id, _existing_kind),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _existing_parent IS NULL OR _existing_parent <> _project_id THEN
                RETURN QUERY SELECT _idx, false, 'wrong_project'::text,
                    format('activity_sink.set: sink %s is not under project %s',
                        _id, _project_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        IF _status <> '' AND _status NOT IN ('enabled', 'disabled-admin', 'disabled-fault') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('activity_sink.set: channel_status %L is not one of ''enabled'' / ''disabled-admin'' / ''disabled-fault''',
                    _status),
                NULL::jsonb;
            CONTINUE;
        END IF;

        IF _activity_filter <> '' AND btrim(_activity_filter) <> '' THEN
            DECLARE
                _ignored jsonb;
            BEGIN
                _ignored := _activity_filter::jsonb;
            EXCEPTION WHEN invalid_text_representation OR datatype_mismatch THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('activity_sink.set: activity_filter is not valid JSON: %s', SQLERRM),
                    NULL::jsonb;
                CONTINUE;
            END;
        END IF;

        -- 2. Insert / reuse the sink card.
        IF _id = 0 THEN
            INSERT INTO card (card_type_id, parent_card_id)
            VALUES (_sink_ct_id, _project_id)
            RETURNING id INTO _sink_id;
            INSERT INTO activity (card_id, kind, actor_id)
            VALUES (_sink_id, 'card_create', activity_sink_set_batch.actor_id);
        ELSE
            _sink_id := _id;
        END IF;

        -- 3. Set-based attribute writes. Assemble a JSONB array of
        --    (ord, attr_def_id, value) triples for every field the
        --    caller supplied; title + sink_kind are unconditional.
        --    When the new status is 'enabled' we also clear
        --    channel_fault_reason (matches sinkFieldWrites in Go).
        WITH writes(ord, attr_def_id, value) AS (
            SELECT row_number() OVER () AS ord, attr_def_id, value
            FROM (
                VALUES
                    (_title_def,     to_jsonb(_name)),
                    (_sink_kind_def, to_jsonb(_sink_kind))
                UNION ALL
                SELECT _tenant_def,    to_jsonb(_tenant_id)
                WHERE _tenant_id <> ''
                UNION ALL
                SELECT _client_id_def, to_jsonb(_client_id)
                WHERE _client_id <> ''
                UNION ALL
                SELECT _team_def,      to_jsonb(_team_id)
                WHERE _team_id <> ''
                UNION ALL
                SELECT _channel_def,   to_jsonb(_channel_id)
                WHERE _channel_id <> ''
                UNION ALL
                SELECT _filter_def,    to_jsonb(_activity_filter)
                WHERE _activity_filter <> ''
                UNION ALL
                SELECT _status_def,    to_jsonb(_status)
                WHERE _status <> ''
                UNION ALL
                SELECT _fault_def,     to_jsonb(''::text)
                WHERE _status = 'enabled'
            ) AS w(attr_def_id, value)
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _sink_id, 'attr_update', w.attr_def_id, NULL, w.value,
                   activity_sink_set_batch.actor_id
            FROM writes w
            ORDER BY w.ord
            RETURNING id, attribute_def_id, value_new
        )
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        SELECT _sink_id, ia.attribute_def_id, ia.value_new, ia.id
        FROM ins_activity ia
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- 4. Upsert activity_sink_secret. Match the legacy
        --    upsertSinkSecret semantics:
        --      key absent → preserve existing bytes
        --      key present and empty → encrypt the empty string (clears)
        --      key present and non-empty → encrypt the new value
        IF _client_secret_present THEN
            INSERT INTO activity_sink_secret (sink_card_id, client_secret)
            VALUES (_sink_id,
                pgp_sym_encrypt(_client_secret, current_setting('app.comm_secret_key')))
            ON CONFLICT (sink_card_id) DO UPDATE SET
                client_secret =
                    pgp_sym_encrypt(_client_secret, current_setting('app.comm_secret_key')),
                updated_at = now();
        ELSE
            -- Ensure a row exists even when no secret is supplied so
            -- subsequent updates have a target row. Preserves any
            -- existing encrypted bytes via COALESCE.
            INSERT INTO activity_sink_secret (sink_card_id, client_secret)
            VALUES (_sink_id, NULL)
            ON CONFLICT (sink_card_id) DO UPDATE SET
                client_secret = COALESCE(activity_sink_secret.client_secret, NULL),
                updated_at = activity_sink_secret.updated_at;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('sink_id', _sink_id::text);
    END LOOP;
END;
$$;

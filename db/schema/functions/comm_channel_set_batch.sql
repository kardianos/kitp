-- comm_channel.set handler (Phase 4 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runChannelSet + validateChannelSet + channelFieldWrites
-- + upsertCommSecret into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Cheap presence validation (name + channel_type + project_id;
--      channel_type must be 'email' in v1) and tri-state status value.
--   2. Parent project existence + card_type='project' guard. When id != 0
--      the existing channel must exist, be a comm_channel, and live
--      under the same project.
--   3. Optional intake_status_id: when supplied must point at a
--      card_type='status' card.
--   4. INSERT (when id=0) or take the supplied id; on insert also
--      stamp a card_create activity.
--   5. Set-based ordinality-join write of every supplied field:
--      title is always written; the rest skip when their incoming
--      value is the zero value (mirrors the Go path's PATCH-style
--      semantics). When status='enabled' an extra row clears
--      channel_fault_reason.
--   6. comm_secret upsert. Encrypts only the password fields the
--      caller supplied — omitted (NULL) passwords are preserved via
--      COALESCE on the existing row. pgp_sym_encrypt + the
--      `app.comm_secret_key` GUC match the legacy Go path; key is
--      set per-connection by store.setCommSecretKey (AfterConnect
--      hook in main.go / testutil.go).
--
-- Password sentinel: the legacy Go used a *string pointer to
-- distinguish "omitted" (nil) from "clear" (empty string). The wire
-- carries `null` for the former and `""` for the latter; this
-- function reads the raw JSONB and respects that distinction
-- explicitly (jsonb_typeof + null check). The Go-side ChannelSetInput
-- struct keeps the pointer field shape so omitempty marshals
-- correctly — only the function body changed.
--
-- Result JSON shape matches `comm.ChannelSetOutput`:
--   {"channel_id": "<bigint>"}
CREATE OR REPLACE FUNCTION comm_channel_set_batch(
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
    _channel_id bigint;
    _project_id bigint;
    _name text;
    _channel_type text;
    _from_address text;
    _imap_host text;
    _imap_port int;
    _imap_username text;
    _smtp_host text;
    _smtp_port int;
    _smtp_username text;
    _intake_status_id bigint;
    _status text;
    _imap_pwd_raw jsonb;
    _smtp_pwd_raw jsonb;
    _imap_pwd text;
    _smtp_pwd text;
    _imap_set boolean;
    _smtp_set boolean;
    _channel_ct_id bigint;
    _parent_kind text;
    _existing_kind text;
    _existing_parent bigint;
    _intake_kind text;
    _activity_id bigint;
BEGIN
    SELECT id INTO _channel_ct_id FROM card_type WHERE name = 'comm_channel';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'comm_channel.set: card_type comm_channel missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode + cheap field presence checks.
        BEGIN
            _channel_id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _channel_id := 0;
        END;
        BEGIN
            _project_id := NULLIF(_raw->>'project_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _project_id := NULL;
        END;
        _name         := COALESCE(_raw->>'name', '');
        _channel_type := COALESCE(_raw->>'channel_type', '');
        _imap_host    := COALESCE(_raw->>'imap_host', '');
        _imap_port    := COALESCE((_raw->>'imap_port')::int, 0);
        _imap_username:= COALESCE(_raw->>'imap_username', '');
        _smtp_host    := COALESCE(_raw->>'smtp_host', '');
        _smtp_port    := COALESCE((_raw->>'smtp_port')::int, 0);
        _smtp_username:= COALESCE(_raw->>'smtp_username', '');
        _from_address := COALESCE(_raw->>'from_address', '');
        _status       := COALESCE(_raw->>'channel_status', '');
        BEGIN
            _intake_status_id := COALESCE(NULLIF(_raw->>'intake_status_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _intake_status_id := 0;
        END;

        -- Password fields: presence in the JSONB blob is the omit
        -- signal. _raw ? 'key' returns false when the JSON object has
        -- no entry under that key; that is the "leave unchanged" form.
        IF _raw ? 'imap_password' THEN
            _imap_pwd_raw := _raw->'imap_password';
            IF jsonb_typeof(_imap_pwd_raw) = 'null' THEN
                _imap_set := false;
            ELSE
                _imap_set := true;
                _imap_pwd := _imap_pwd_raw #>> '{}';
            END IF;
        ELSE
            _imap_set := false;
        END IF;
        IF _raw ? 'smtp_password' THEN
            _smtp_pwd_raw := _raw->'smtp_password';
            IF jsonb_typeof(_smtp_pwd_raw) = 'null' THEN
                _smtp_set := false;
            ELSE
                _smtp_set := true;
                _smtp_pwd := _smtp_pwd_raw #>> '{}';
            END IF;
        ELSE
            _smtp_set := false;
        END IF;

        -- 1a. Required fields.
        IF _name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.set: name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _channel_type = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.set: channel_type is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _channel_type <> 'email' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm_channel.set: channel_type %L is not supported (v1: email only)', _channel_type),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _project_id IS NULL OR _project_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.set: project_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _status <> '' AND _status NOT IN ('enabled', 'disabled-admin', 'disabled-fault') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm_channel.set: channel_status %L is not one of ''enabled'' / ''disabled-admin'' / ''disabled-fault''', _status),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Parent project: exists + card_type='project'.
        SELECT ct.name INTO _parent_kind
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _project_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'project_not_found'::text,
                format('comm_channel.set: project_id %s not found', _project_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _parent_kind <> 'project' THEN
            RETURN QUERY SELECT _idx, false, 'parent_not_project'::text,
                format('comm_channel.set: project_id %s is a %L card, not a project', _project_id, _parent_kind),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2b. When updating: target card must exist, be a comm_channel,
        --     and live under the supplied project.
        IF _channel_id <> 0 THEN
            SELECT ct.name, c.parent_card_id INTO _existing_kind, _existing_parent
            FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _channel_id;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'channel_not_found'::text,
                    format('comm_channel.set: channel %s not found', _channel_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _existing_kind <> 'comm_channel' THEN
                RETURN QUERY SELECT _idx, false, 'wrong_card_type'::text,
                    format('comm_channel.set: card %s is %L, not comm_channel', _channel_id, _existing_kind),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _existing_parent IS NULL OR _existing_parent <> _project_id THEN
                RETURN QUERY SELECT _idx, false, 'wrong_project'::text,
                    format('comm_channel.set: channel %s is not under project %s', _channel_id, _project_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 3. Optional intake_status_id: must be a status card if set.
        IF _intake_status_id <> 0 THEN
            SELECT ct.name INTO _intake_kind
            FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _intake_status_id;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'intake_status_not_found'::text,
                    format('comm_channel.set: intake_status_id %s not found', _intake_status_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _intake_kind <> 'status' THEN
                RETURN QUERY SELECT _idx, false, 'intake_status_wrong_type'::text,
                    format('comm_channel.set: intake_status_id %s is %L, not status', _intake_status_id, _intake_kind),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 4. Insert (id=0) or use existing id.
        IF _channel_id = 0 THEN
            INSERT INTO card (card_type_id, parent_card_id)
            VALUES (_channel_ct_id, _project_id)
            RETURNING id INTO _channel_id;
            INSERT INTO activity (card_id, kind, actor_id)
            VALUES (_channel_id, 'card_create', comm_channel_set_batch.actor_id);
        END IF;

        -- 5. Multi-attribute write via the ordinality-join pattern.
        --    Build the field list inline, filtered by per-field
        --    presence rules. title + channel_type are always written;
        --    other text/number fields skip when the incoming value is
        --    the zero value (PATCH semantics). When status='enabled'
        --    we also clear channel_fault_reason.
        WITH writes(ord, attr_name, value) AS (
            SELECT * FROM (VALUES
                (1,  'title',                to_jsonb(_name),                  true),
                (2,  'channel_type',         to_jsonb(_channel_type),          true),
                (3,  'imap_host',            to_jsonb(_imap_host),             _imap_host <> ''),
                (4,  'imap_port',            to_jsonb(_imap_port),             _imap_port <> 0),
                (5,  'imap_username',        to_jsonb(_imap_username),         _imap_username <> ''),
                (6,  'smtp_host',            to_jsonb(_smtp_host),             _smtp_host <> ''),
                (7,  'smtp_port',            to_jsonb(_smtp_port),             _smtp_port <> 0),
                (8,  'smtp_username',        to_jsonb(_smtp_username),         _smtp_username <> ''),
                (9,  'from_address',         to_jsonb(_from_address),          _from_address <> ''),
                (10, 'intake_status',        to_jsonb(_intake_status_id),      _intake_status_id <> 0),
                (11, 'channel_status',       to_jsonb(_status),                _status <> ''),
                (12, 'channel_fault_reason', to_jsonb(''::text),               _status = 'enabled')
            ) AS v(ord, attr_name, value, include)
            WHERE v.include
        ),
        resolved AS (
            SELECT w.ord, ad.id AS attr_def_id, w.value
            FROM writes w
            JOIN attribute_def ad ON ad.name = w.attr_name
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _channel_id, 'attr_update', r.attr_def_id, NULL, r.value,
                   comm_channel_set_batch.actor_id
            FROM resolved r
            ORDER BY r.ord
            RETURNING id, attribute_def_id, value_new
        )
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        SELECT _channel_id, ia.attribute_def_id, ia.value_new, ia.id
        FROM ins_activity ia
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- 6. comm_secret upsert. Encrypts only the password fields the
        --    caller supplied; omitted (null / missing) values preserve
        --    the stored ciphertext via COALESCE on update.
        INSERT INTO comm_secret (channel_card_id, imap_password, smtp_password)
        VALUES (
            _channel_id,
            CASE WHEN _imap_set
                 THEN pgp_sym_encrypt(_imap_pwd, current_setting('app.comm_secret_key'))
                 ELSE NULL END,
            CASE WHEN _smtp_set
                 THEN pgp_sym_encrypt(_smtp_pwd, current_setting('app.comm_secret_key'))
                 ELSE NULL END
        )
        ON CONFLICT (channel_card_id) DO UPDATE SET
            imap_password = COALESCE(
                CASE WHEN _imap_set
                     THEN pgp_sym_encrypt(_imap_pwd, current_setting('app.comm_secret_key'))
                     ELSE NULL END,
                comm_secret.imap_password),
            smtp_password = COALESCE(
                CASE WHEN _smtp_set
                     THEN pgp_sym_encrypt(_smtp_pwd, current_setting('app.comm_secret_key'))
                     ELSE NULL END,
                comm_secret.smtp_password),
            updated_at = now();

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'channel_id', _channel_id::text
            );
    END LOOP;
END;
$$;

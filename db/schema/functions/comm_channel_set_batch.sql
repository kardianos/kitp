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
    -- Sending (docs/MAIL_INTAKE_AND_CALENDARS.md, "Sending").
    _send_method text;
    _send_domain text;
    _send_region text;
    _send_stream text;
    _send_url    text;
    _send_set    boolean;
    _send_secret text;
    _old_method  text;
    _imap_off    boolean;
    _smtp_port int;
    _smtp_username text;
    _intake_status_id bigint;
    _status text;
    _signature_mode text;
    _intake_mode text;
    _reply_quote text;
    _relay_replies text;
    _email_attachments text;
    _creating boolean;
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
        _signature_mode := COALESCE(_raw->>'signature_mode', '');
        _intake_mode    := COALESCE(_raw->>'intake_mode', '');
        _reply_quote    := COALESCE(_raw->>'reply_quote', '');
        _relay_replies  := COALESCE(_raw->>'relay_replies', '');
        _email_attachments := COALESCE(_raw->>'email_attachments', '');
        _send_method := COALESCE(_raw->>'send_method', '');
        _send_domain := lower(btrim(COALESCE(_raw->>'send_domain', '')));
        _send_region := COALESCE(_raw->>'send_region', '');
        _send_stream := btrim(COALESCE(_raw->>'send_stream', ''));
        _send_url    := btrim(COALESCE(_raw->>'send_url', ''));
        -- imap_enabled false stops polling: the IMAP settings are cleared.
        _imap_off := jsonb_typeof(_raw->'imap_enabled') = 'boolean' AND NOT (_raw->>'imap_enabled')::boolean;
        -- send_secret: like the passwords, absent or null leaves it.
        _send_set := _raw ? 'send_secret' AND jsonb_typeof(_raw->'send_secret') = 'string';
        _send_secret := CASE WHEN _send_set THEN _raw->>'send_secret' END;
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
        IF _signature_mode <> '' AND _signature_mode NOT IN ('none', 'comm_name', 'user_name') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm_channel.set: signature_mode %L is not one of ''none'' / ''comm_name'' / ''user_name''', _signature_mode),
                NULL::jsonb;
            CONTINUE;
        END IF;
        -- The account's own address, bare: it is the envelope sender and
        -- the From of everything sent, and the name comes from the
        -- account's title. "Support <support@x>" made every staff reply
        -- fail (review 2026-11-03 round 4 #8).
        _from_address := btrim(_from_address);
        IF _from_address <> '' AND NOT email_plain(_from_address) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.set: from_address must be a plain address such as support@example.com (the account''s name is its title)'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;
        -- What new (unmatched) mail does, and whether replies quote the
        -- conversation (docs/CONVERSATIONS.md).
        IF _intake_mode <> '' AND _intake_mode NOT IN ('task', 'thread', 'ignore') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm_channel.set: intake_mode %L is not one of ''task'' / ''thread'' / ''ignore''', _intake_mode),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _reply_quote <> '' AND _reply_quote NOT IN ('off', 'last', 'all') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm_channel.set: reply_quote %L is not one of ''off'' / ''last'' / ''all''', _reply_quote),
                NULL::jsonb;
            CONTINUE;
        END IF;
        -- Whether an emailed reply is sent on to the rest of the thread, and
        -- whether files on incoming mail are kept
        -- (docs/MAIL_INTAKE_AND_CALENDARS.md).
        IF _relay_replies <> '' AND _relay_replies NOT IN ('on', 'off') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm_channel.set: relay_replies %L is not one of ''on'' / ''off''', _relay_replies),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _email_attachments <> '' AND _email_attachments NOT IN ('keep', 'drop') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm_channel.set: email_attachments %L is not one of ''keep'' / ''drop''', _email_attachments),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- How it sends, and what that needs.
        IF _send_method <> '' AND _send_method NOT IN ('smtp', 'mailgun', 'postmark', 'webhook', 'none') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comm_channel.set: send_method %L is not one of ''smtp'' / ''mailgun'' / ''postmark'' / ''webhook'' / ''none''', _send_method),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _send_region <> '' AND _send_region NOT IN ('us', 'eu') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.set: send_region is ''us'' or ''eu'' (Mailgun''s API)'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _send_domain <> '' AND (_send_domain !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' OR length(_send_domain) > 253) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.set: send_domain must be a domain name such as mg.example.com'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _send_stream <> '' AND _send_stream !~ '^[A-Za-z0-9_-]{1,64}$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.set: send_stream is a Postmark message stream id such as outbound'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        -- The webhook goes over https only: it carries every message whole.
        IF _send_url <> '' AND (_send_url !~* '^https://[^/\s?#@]+(/[^\s]*)?$' OR length(_send_url) > 2048) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.set: send_url must be an https:// URL'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        -- An explicit "" clears it, as with the passwords.
        IF _send_set AND length(_send_secret) > 1024 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm_channel.set: send_secret is at most 1024 characters'::text, NULL::jsonb;
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

        -- 4. Insert (id=0) or use existing id. A new account sends replies
        --    on unless told otherwise; an existing one without the setting
        --    reads as off, so this never switches on for an account that
        --    was already running.
        _creating := _channel_id = 0;
        IF _creating AND _relay_replies = '' THEN
            _relay_replies := 'on';
        END IF;
        IF _channel_id = 0 THEN
            INSERT INTO card (card_type_id, parent_card_id)
            VALUES (_channel_ct_id, _project_id)
            RETURNING id INTO _channel_id;
            INSERT INTO activity (card_id, kind, actor_id)
            VALUES (_channel_id, 'card_create', comm_channel_set_batch.actor_id);
        END IF;

        -- A key belongs to its provider: changing the send method without
        -- a new secret clears the old one (a Mailgun key is no Postmark
        -- token), so the account can't send until it has its own.
        SELECT COALESCE(NULLIF(av.value #>> '{}', ''), 'smtp') INTO _old_method
        FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'send_method'
        WHERE av.card_id = _channel_id;
        _old_method := COALESCE(_old_method, 'smtp');

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
                (12, 'channel_fault_reason', to_jsonb(''::text),               _status = 'enabled'),
                (13, 'signature_mode',       to_jsonb(_signature_mode),        _signature_mode <> ''),
                (14, 'intake_mode',          to_jsonb(_intake_mode),           _intake_mode <> ''),
                (15, 'reply_quote',          to_jsonb(_reply_quote),           _reply_quote <> ''),
                (16, 'relay_replies',        to_jsonb(_relay_replies),         _relay_replies <> ''),
                (17, 'email_attachments',    to_jsonb(_email_attachments),     _email_attachments <> ''),
                (18, 'send_method',          to_jsonb(_send_method),           _send_method <> ''),
                (19, 'send_domain',          to_jsonb(_send_domain),           _send_domain <> ''),
                (20, 'send_region',          to_jsonb(_send_region),           _send_region <> ''),
                (21, 'send_stream',          to_jsonb(_send_stream),           _send_stream <> ''),
                (22, 'send_url',             to_jsonb(_send_url),              _send_url <> '')
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
        INSERT INTO comm_secret (channel_card_id, imap_password, smtp_password, send_secret)
        VALUES (
            _channel_id,
            CASE WHEN _imap_set
                 THEN pgp_sym_encrypt(_imap_pwd, current_setting('app.comm_secret_key'))
                 ELSE NULL END,
            CASE WHEN _smtp_set
                 THEN pgp_sym_encrypt(_smtp_pwd, current_setting('app.comm_secret_key'))
                 ELSE NULL END,
            CASE WHEN _send_set AND _send_secret <> ''
                 THEN pgp_sym_encrypt(_send_secret, current_setting('app.comm_secret_key'))
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
            send_secret = CASE
                WHEN _send_set AND _send_secret = '' THEN NULL
                WHEN _send_set THEN pgp_sym_encrypt(_send_secret, current_setting('app.comm_secret_key'))
                WHEN _send_method <> '' AND _send_method <> _old_method THEN NULL
                ELSE comm_secret.send_secret END,
            updated_at = now();

        -- 6b. Polling stopped: the IMAP settings go, so the poller leaves
        --     the account alone (POST and SMTP routes still deliver).
        IF _imap_off THEN
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _channel_id, 'attr_update', av.attribute_def_id, av.value, NULL, comm_channel_set_batch.actor_id
            FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
            WHERE av.card_id = _channel_id AND ad.name IN ('imap_host', 'imap_port', 'imap_username');
            DELETE FROM attribute_value av USING attribute_def ad
            WHERE ad.id = av.attribute_def_id AND av.card_id = _channel_id
              AND ad.name IN ('imap_host', 'imap_port', 'imap_username');
            UPDATE comm_secret SET imap_password = NULL, updated_at = now() WHERE channel_card_id = _channel_id;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'channel_id', _channel_id::text
            );
    END LOOP;
END;
$$;

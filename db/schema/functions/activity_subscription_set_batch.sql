-- activity_subscription.set handler — create / update the CALLER's own
-- personal notification subscription.
--
-- An activity_subscription card parents under an EMAIL activity_sink
-- (which names the project comm_channel the mail goes out through). The
-- card carries:
--   title            — the subscription's display name
--   subscriber       — card_ref → the caller's person card (never on the
--                      wire: always the calling user)
--   activity_filter  — event filter JSON (activitysink.Predicate DSL)
--   predicate        — card filter JSON (the screen-filter predicate
--                      tree, '@me' = the subscriber)
--   rollup_minutes   — hold window; 0 = deliver on the next pump tick
--   channel_status   — 'enabled' | 'disabled-admin' (user paused) |
--                      'disabled-fault' (pump tripped, e.g. a bounce)
--   channel_fault_reason
--
-- Ownership: role_grant lets every project tier invoke this process, so
-- the function itself enforces "subscriber = caller's person" on update
-- (admins exempt). The generic card.* processes on this card_type stay
-- admin-only, so attribute.update can't be used to edit someone else's.
--
-- PATCH semantics: name / activity_filter / card_filter / rollup_minutes
-- / enabled are written when the key is present and left alone when
-- absent (create defaults: '', '', 0, enabled). Only attributes whose
-- value actually changes write an activity row (with value_old), so a
-- full-form save doesn't spam the project's activity stream.
--
-- A new subscription's activity_sink_state pointer starts at the current
-- max(activity.id): it delivers only what happens AFTER it was created.
--
-- Result JSON shape matches `activitysink.SubscriptionSetOutput`:
--   {"subscription_id": "<bigint>"}
CREATE OR REPLACE FUNCTION activity_subscription_set_batch(
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
    _sub_ct_id bigint;
    _title_def bigint;
    _subscriber_def bigint;
    _filter_def bigint;
    _predicate_def bigint;
    _rollup_def bigint;
    _status_def bigint;
    _fault_def bigint;
    _sink_kind_def bigint;
    _email_def bigint;
    _is_admin boolean;
    _person_id bigint;
    _idx int;
    _raw jsonb;
    _id bigint;
    _sink_id bigint;
    _sink_present boolean;
    _name text;
    _name_present boolean;
    _activity_filter text;
    _activity_filter_present boolean;
    _card_filter text;
    _card_filter_present boolean;
    _rollup int;
    _rollup_present boolean;
    _enabled boolean;
    _enabled_present boolean;
    _cur_fault text;
    _owner bigint;
    _parent_sink bigint;
    _sub_id bigint;
    _creating boolean;
BEGIN
    SELECT id INTO _sub_ct_id FROM card_type WHERE name = 'activity_subscription';
    IF _sub_ct_id IS NULL THEN
        RAISE EXCEPTION 'activity_subscription.set: card_type activity_subscription missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _title_def      FROM attribute_def WHERE name = 'title';
    SELECT id INTO _subscriber_def FROM attribute_def WHERE name = 'subscriber';
    SELECT id INTO _filter_def     FROM attribute_def WHERE name = 'activity_filter';
    SELECT id INTO _predicate_def  FROM attribute_def WHERE name = 'predicate';
    SELECT id INTO _rollup_def     FROM attribute_def WHERE name = 'rollup_minutes';
    SELECT id INTO _status_def     FROM attribute_def WHERE name = 'channel_status';
    SELECT id INTO _fault_def      FROM attribute_def WHERE name = 'channel_fault_reason';
    SELECT id INTO _sink_kind_def  FROM attribute_def WHERE name = 'sink_kind';
    SELECT id INTO _email_def      FROM attribute_def WHERE name = 'email';
    IF _title_def IS NULL OR _subscriber_def IS NULL OR _filter_def IS NULL
       OR _predicate_def IS NULL OR _rollup_def IS NULL OR _status_def IS NULL
       OR _fault_def IS NULL OR _sink_kind_def IS NULL OR _email_def IS NULL THEN
        RAISE EXCEPTION 'activity_subscription.set: one of the subscription attribute_defs is missing'
            USING ERRCODE = 'P0001';
    END IF;

    _is_admin := EXISTS (
        SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
        WHERE ur.user_id = activity_subscription_set_batch.actor_id
          AND r.name = 'admin' AND ur.scope_card_id IS NULL
    );
    SELECT uap.person_card_id INTO _person_id
      FROM user_account_person uap
      WHERE uap.user_account_id = activity_subscription_set_batch.actor_id;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
            _sink_id := COALESCE(NULLIF(_raw->>'sink_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity_subscription.set: id / sink_id must be numeric ids'::text, NULL::jsonb;
            CONTINUE;
        END;
        _creating := (_id = 0);
        _sink_present := _sink_id <> 0;
        _name_present := (_raw ? 'name') AND jsonb_typeof(_raw->'name') <> 'null';
        _name := btrim(COALESCE(_raw->>'name', ''));
        _activity_filter_present := (_raw ? 'activity_filter')
                                    AND jsonb_typeof(_raw->'activity_filter') <> 'null';
        _activity_filter := COALESCE(_raw->>'activity_filter', '');
        _card_filter_present := (_raw ? 'card_filter')
                                AND jsonb_typeof(_raw->'card_filter') <> 'null';
        _card_filter := COALESCE(_raw->>'card_filter', '');
        _rollup_present := (_raw ? 'rollup_minutes')
                           AND jsonb_typeof(_raw->'rollup_minutes') <> 'null';
        _enabled_present := (_raw ? 'enabled') AND jsonb_typeof(_raw->'enabled') <> 'null';

        -- 1. Shape validation.
        IF _creating AND NOT _sink_present THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity_subscription.set: sink_id is required to create a subscription'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF (_creating OR _name_present) AND _name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity_subscription.set: name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _rollup_present THEN
            IF jsonb_typeof(_raw->'rollup_minutes') <> 'number'
               OR (_raw->>'rollup_minutes')::numeric <> trunc((_raw->>'rollup_minutes')::numeric)
               OR (_raw->>'rollup_minutes')::numeric < 0
               OR (_raw->>'rollup_minutes')::numeric > 1440 THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'activity_subscription.set: rollup_minutes must be an integer between 0 and 1440'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
            _rollup := (_raw->>'rollup_minutes')::int;
        END IF;
        IF _enabled_present THEN
            IF jsonb_typeof(_raw->'enabled') <> 'boolean' THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'activity_subscription.set: enabled must be a boolean'::text, NULL::jsonb;
                CONTINUE;
            END IF;
            _enabled := (_raw->>'enabled')::boolean;
        ELSIF _creating THEN
            _enabled_present := true;
            _enabled := true;
        END IF;
        BEGIN
            IF btrim(_activity_filter) <> '' THEN
                PERFORM _activity_filter::jsonb;
            END IF;
        EXCEPTION WHEN invalid_text_representation OR datatype_mismatch THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('activity_subscription.set: activity_filter is not valid JSON: %s', SQLERRM),
                NULL::jsonb;
            CONTINUE;
        END;
        BEGIN
            IF btrim(_card_filter) <> '' THEN
                PERFORM _card_filter::jsonb;
            END IF;
        EXCEPTION WHEN invalid_text_representation OR datatype_mismatch THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('activity_subscription.set: card_filter is not valid JSON: %s', SQLERRM),
                NULL::jsonb;
            CONTINUE;
        END;

        -- 2. Resolve the target (sink on create, subscription on update).
        IF _creating THEN
            IF NOT EXISTS (
                SELECT 1 FROM card s JOIN card_type ct ON ct.id = s.card_type_id
                WHERE s.id = _sink_id AND ct.name = 'activity_sink' AND s.deleted_at IS NULL
            ) THEN
                RETURN QUERY SELECT _idx, false, 'sink_not_found'::text,
                    format('activity_subscription.set: activity sink %s not found', _sink_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                          WHERE av.card_id = _sink_id AND av.attribute_def_id = _sink_kind_def), '')
               <> 'email' THEN
                RETURN QUERY SELECT _idx, false, 'sink_not_email'::text,
                    format('activity_subscription.set: sink %s is not an email sink; only email sinks take personal subscriptions', _sink_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _person_id IS NULL THEN
                RETURN QUERY SELECT _idx, false, 'no_person'::text,
                    'activity_subscription.set: your account has no linked person card to subscribe as'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF COALESCE(NULLIF(btrim((SELECT av.value #>> '{}' FROM attribute_value av
                                        WHERE av.card_id = _person_id AND av.attribute_def_id = _email_def)), ''),
                        NULLIF(btrim((SELECT ua.email FROM user_account ua
                                       WHERE ua.id = activity_subscription_set_batch.actor_id)), '')) IS NULL THEN
                RETURN QUERY SELECT _idx, false, 'no_email'::text,
                    'activity_subscription.set: your account has no email address to deliver to'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
        ELSE
            SELECT s.parent_card_id INTO _parent_sink
              FROM card s JOIN card_type ct ON ct.id = s.card_type_id
              WHERE s.id = _id AND ct.name = 'activity_subscription' AND s.deleted_at IS NULL;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'subscription_not_found'::text,
                    format('activity_subscription.set: subscription %s not found', _id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
            IF _sink_present AND _sink_id <> _parent_sink THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'activity_subscription.set: a subscription cannot move to another sink'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
            SELECT (av.value)::text::bigint INTO _owner
              FROM attribute_value av
              WHERE av.card_id = _id AND av.attribute_def_id = _subscriber_def
                AND jsonb_typeof(av.value) = 'number';
            IF NOT _is_admin AND (_owner IS NULL OR _person_id IS NULL OR _owner <> _person_id) THEN
                RETURN QUERY SELECT _idx, false, 'not_owner'::text,
                    format('activity_subscription.set: subscription %s belongs to someone else', _id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 3. Insert the card on create.
        IF _creating THEN
            INSERT INTO card (card_type_id, parent_card_id)
            VALUES (_sub_ct_id, _sink_id)
            RETURNING id INTO _sub_id;
            INSERT INTO activity (card_id, kind, actor_id)
            VALUES (_sub_id, 'card_create', activity_subscription_set_batch.actor_id);
            -- Start at the present: never replay the project's history.
            INSERT INTO activity_sink_state (sink_card_id, last_activity_id)
            VALUES (_sub_id, (SELECT COALESCE(max(a.id), 0) FROM activity a))
            ON CONFLICT (sink_card_id) DO NOTHING;
            _cur_fault := '';
        ELSE
            _sub_id := _id;
            _cur_fault := COALESCE((SELECT av.value #>> '{}' FROM attribute_value av
                                     WHERE av.card_id = _sub_id AND av.attribute_def_id = _fault_def), '');
        END IF;

        -- 4. Set-based write of the CHANGED attributes only (value_old
        --    carried so the activity stream renders "old → new").
        WITH want(ord, attr_def_id, value) AS (
            SELECT row_number() OVER () AS ord, attr_def_id, value
            FROM (
                SELECT _title_def AS attr_def_id, to_jsonb(_name) AS value
                WHERE _name_present OR _creating
                UNION ALL
                SELECT _subscriber_def, to_jsonb(_person_id)
                WHERE _creating
                UNION ALL
                SELECT _filter_def, to_jsonb(_activity_filter)
                WHERE _activity_filter_present
                UNION ALL
                SELECT _predicate_def, to_jsonb(_card_filter)
                WHERE _card_filter_present
                UNION ALL
                SELECT _rollup_def, to_jsonb(_rollup)
                WHERE _rollup_present
                UNION ALL
                SELECT _status_def,
                       to_jsonb(CASE WHEN _enabled THEN 'enabled' ELSE 'disabled-admin' END)
                WHERE _enabled_present
                UNION ALL
                SELECT _fault_def, to_jsonb(''::text)
                WHERE _enabled_present AND _enabled AND _cur_fault <> ''
            ) AS w
        ),
        changed AS (
            SELECT w.ord, w.attr_def_id, w.value, cur.value AS old_value
            FROM want w
            LEFT JOIN attribute_value cur
              ON cur.card_id = _sub_id AND cur.attribute_def_id = w.attr_def_id
            WHERE cur.value IS DISTINCT FROM w.value
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _sub_id, 'attr_update', c.attr_def_id, c.old_value, c.value,
                   activity_subscription_set_batch.actor_id
            FROM changed c
            ORDER BY c.ord
            RETURNING id, attribute_def_id, value_new
        )
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        SELECT _sub_id, ia.attribute_def_id, ia.value_new, ia.id
        FROM ins_activity ia
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('subscription_id', _sub_id::text);
    END LOOP;
END;
$$;

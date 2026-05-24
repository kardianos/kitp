-- comm.set_recipients handler (Phase 3 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runCommSetRecipients + writeCommRecipients
-- into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Decode + cheap presence checks (comm_id required).
--   2. Comm existence + card_type='comm' guard.
--   3. Bulk validate every recipient_person_id refers to a live person
--      card. A single missing / wrong-type id fails the whole row with
--      code='invalid_recipient' (matching the legacy contract).
--   4. Dedup the id list preserving first-seen order (mirrors the Go
--      dedupInt64 helper). Empty list is legal — clears the attribute.
--   5. Build canonical numeric jsonb array, write the comm_recipients
--      attribute_value + paired activity row.
--
-- Result JSON shape matches `comm.CommSetRecipientsOutput`:
--   {"count": <int>}
-- No bigint ids in the output — count is a JSON number, no `,string`
-- tag required.
CREATE OR REPLACE FUNCTION comm_set_recipients_batch(
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
    _comm_id bigint;
    _recipients jsonb;
    _ct_name text;
    _ids bigint[];
    _bad_id bigint;
    _bad_name text;
    _missing_id bigint;
    _value_norm jsonb;
    _comm_recipients_def_id bigint;
    _activity_id bigint;
    _bad_msg text;
BEGIN
    -- Hoist: attribute_def lookup is constant across the loop.
    SELECT id INTO _comm_recipients_def_id
    FROM attribute_def WHERE name = 'comm_recipients';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'comm.set_recipients: attribute_def comm_recipients missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode.
        BEGIN
            _comm_id := NULLIF(_raw->>'comm_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _comm_id := NULL;
        END;
        _recipients := COALESCE(_raw->'recipient_person_ids', '[]'::jsonb);

        IF _comm_id IS NULL OR _comm_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm.set_recipients: comm_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF jsonb_typeof(_recipients) <> 'array' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm.set_recipients: recipient_person_ids must be a JSON array'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Comm existence + card_type=comm.
        SELECT ct.name INTO _ct_name
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _comm_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'comm_not_found'::text,
                format('comm.set_recipients: comm %s not found', _comm_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ct_name <> 'comm' THEN
            RETURN QUERY SELECT _idx, false, 'wrong_card_type'::text,
                format('comm.set_recipients: card %s is %L, not comm', _comm_id, _ct_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Decode + dedup recipient ids (preserve first-seen order via
        --    ORDINALITY). Accepts JSON number or numeric-string forms.
        --    A malformed element fails the row.
        _bad_msg := NULL;
        DECLARE
            _el jsonb;
            _id bigint;
        BEGIN
            _ids := ARRAY[]::bigint[];
            FOR _el IN SELECT e.v
                       FROM jsonb_array_elements(_recipients) WITH ORDINALITY AS e(v, ord)
                       ORDER BY ord
            LOOP
                IF jsonb_typeof(_el) = 'number' THEN
                    _id := (_el)::text::bigint;
                ELSIF jsonb_typeof(_el) = 'string'
                      AND (_el #>> '{}') ~ '^-?\d+$' THEN
                    _id := ((_el #>> '{}')::bigint);
                ELSE
                    _bad_msg := format(
                        'comm.set_recipients: recipient id not a number or numeric string: %s',
                        _el::text);
                    EXIT;
                END IF;
                -- First-seen dedup.
                IF NOT (_id = ANY(_ids)) THEN
                    _ids := array_append(_ids, _id);
                END IF;
            END LOOP;
        END;
        IF _bad_msg IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, _bad_msg, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Bulk validate every id is a person card. One scan; first
        --    bad id wins. Matches the per-row Go validation that
        --    returned 'person N not found' / 'card N is "X", not person'.
        IF array_length(_ids, 1) IS NOT NULL THEN
            _missing_id := NULL;
            _bad_id := NULL;
            _bad_name := NULL;
            SELECT m.want, c.id, ct.name
              INTO _missing_id, _bad_id, _bad_name
            FROM unnest(_ids) AS m(want)
            LEFT JOIN card c ON c.id = m.want AND c.deleted_at IS NULL
            LEFT JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id IS NULL OR ct.name <> 'person'
            ORDER BY m.want
            LIMIT 1;
            IF FOUND THEN
                IF _bad_id IS NULL THEN
                    RETURN QUERY SELECT _idx, false, 'invalid_recipient'::text,
                        format('comm.set_recipients: person %s not found', _missing_id),
                        NULL::jsonb;
                ELSE
                    RETURN QUERY SELECT _idx, false, 'invalid_recipient'::text,
                        format('comm.set_recipients: card %s is %L, not person', _bad_id, _bad_name),
                        NULL::jsonb;
                END IF;
                CONTINUE;
            END IF;
        END IF;

        -- 5. Build canonical numeric jsonb array (preserves stored
        --    order). Empty list -> []. The activity row + upsert mirror
        --    writeAttributeValue.
        IF array_length(_ids, 1) IS NULL THEN
            _value_norm := '[]'::jsonb;
        ELSE
            SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY ord), '[]'::jsonb)
              INTO _value_norm
            FROM unnest(_ids) WITH ORDINALITY AS t(v, ord);
        END IF;

        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_comm_id, 'attr_update', _comm_recipients_def_id, NULL, _value_norm,
                comm_set_recipients_batch.actor_id)
        RETURNING id INTO _activity_id;

        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_comm_id, _comm_recipients_def_id, _value_norm, _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'count', COALESCE(array_length(_ids, 1), 0)
            );
    END LOOP;
END;
$$;

-- comm.set_ack handler — set the per-thread `acked` flag on a comm card.
--
-- ACK is thread-level (on the comm), not per-message: a received inbound
-- reply clears it (imap.go appendReceivedReply writes acked=false) so the
-- thread surfaces in the "Needs ACK" filter; this handler is the explicit
-- operator acknowledgement that the thread has been handled (acked=true),
-- or a manual re-open (acked=false).
--
-- Per-row pipeline:
--   1. Decode + cheap presence checks (comm_id required; acked defaults true).
--   2. Comm existence + card_type='comm' guard.
--   3. Write the `acked` attribute_value + paired attr_update activity row.
--
-- Result JSON shape matches `comm.CommSetAckOutput`:
--   {"acked": <bool>}
CREATE OR REPLACE FUNCTION comm_set_ack_batch(
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
    _acked boolean;
    _ct_name text;
    _value_norm jsonb;
    _acked_def_id bigint;
    _activity_id bigint;
BEGIN
    -- Hoist: attribute_def lookup is constant across the loop.
    SELECT id INTO _acked_def_id
    FROM attribute_def WHERE name = 'acked';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'comm.set_ack: attribute_def acked missing'
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
        -- acked defaults to true (the common "mark handled" case) when omitted.
        IF _raw ? 'acked' AND jsonb_typeof(_raw->'acked') = 'boolean' THEN
            _acked := (_raw->>'acked')::boolean;
        ELSE
            _acked := true;
        END IF;

        IF _comm_id IS NULL OR _comm_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comm.set_ack: comm_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Comm existence + card_type=comm.
        SELECT ct.name INTO _ct_name
        FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = _comm_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'comm_not_found'::text,
                format('comm.set_ack: comm %s not found', _comm_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ct_name <> 'comm' THEN
            RETURN QUERY SELECT _idx, false, 'wrong_card_type'::text,
                format('comm.set_ack: card %s is %L, not comm', _comm_id, _ct_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Write the bool value + paired activity row (mirrors
        --    writeAttributeValue).
        _value_norm := to_jsonb(_acked);

        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
        VALUES (_comm_id, 'attr_update', _acked_def_id, NULL, _value_norm,
                comm_set_ack_batch.actor_id)
        RETURNING id INTO _activity_id;

        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        VALUES (_comm_id, _acked_def_id, _value_norm, _activity_id)
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('acked', _acked);
    END LOOP;
END;
$$;

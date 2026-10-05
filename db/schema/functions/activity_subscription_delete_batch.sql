-- activity_subscription.delete handler — soft-delete the caller's own
-- notification subscription.
--
-- Per-row pipeline:
--   1. id required; the card must be a live activity_subscription.
--   2. Ownership: its `subscriber` must be the caller's linked person card
--      (admins exempt, so they can clean up a departed user's rows).
--   3. Soft-delete (deleted_at = now()) + a card_delete activity row, and
--      drop the delivery state row (the pump stops enumerating the unit
--      as soon as deleted_at is set; the state row is just bookkeeping).
--
-- Result JSON shape matches `activitysink.SubscriptionDeleteOutput`:
--   {"deleted": true}
CREATE OR REPLACE FUNCTION activity_subscription_delete_batch(
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
    _subscriber_def bigint;
    _is_admin boolean;
    _person_id bigint;
    _idx int;
    _raw jsonb;
    _id bigint;
    _owner bigint;
BEGIN
    SELECT id INTO _subscriber_def FROM attribute_def WHERE name = 'subscriber';
    IF _subscriber_def IS NULL THEN
        RAISE EXCEPTION 'activity_subscription.delete: attribute_def subscriber missing'
            USING ERRCODE = 'P0001';
    END IF;
    _is_admin := EXISTS (
        SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
        WHERE ur.user_id = activity_subscription_delete_batch.actor_id
          AND r.name = 'admin' AND ur.scope_card_id IS NULL
    );
    SELECT uap.person_card_id INTO _person_id
      FROM user_account_person uap
      WHERE uap.user_account_id = activity_subscription_delete_batch.actor_id;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _id := 0;
        END;
        IF _id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'activity_subscription.delete: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM card s JOIN card_type ct ON ct.id = s.card_type_id
            WHERE s.id = _id AND ct.name = 'activity_subscription' AND s.deleted_at IS NULL
        ) THEN
            RETURN QUERY SELECT _idx, false, 'subscription_not_found'::text,
                format('activity_subscription.delete: subscription %s not found', _id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        _owner := NULL;
        SELECT (av.value)::text::bigint INTO _owner
          FROM attribute_value av
          WHERE av.card_id = _id AND av.attribute_def_id = _subscriber_def
            AND jsonb_typeof(av.value) = 'number';
        IF NOT _is_admin AND (_owner IS NULL OR _person_id IS NULL OR _owner <> _person_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_owner'::text,
                format('activity_subscription.delete: subscription %s belongs to someone else', _id),
                NULL::jsonb;
            CONTINUE;
        END IF;

        UPDATE card SET deleted_at = now() WHERE id = _id AND deleted_at IS NULL;
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_id, 'card_delete', activity_subscription_delete_batch.actor_id);
        DELETE FROM activity_sink_state WHERE sink_card_id = _id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('deleted', true);
    END LOOP;
END;
$$;

-- card.merge handler — fold one or more duplicate `loser` cards into a
-- `survivor` of the SAME card_type, repointing every card_ref / card_ref[]
-- reference and soft-deleting the losers (see card_merge_into). Generic across
-- card types (duplicate milestones / components / tags / persons). The
-- person-specific path (user_account_person reconciliation, login-conflict
-- guard, email backfill) lives in person_merge_batch, which shares the same
-- card_merge_into primitive.
--
-- Per-row input: {"survivor_id": "<bigint>", "loser_ids": ["<bigint>", ...]}.
-- Validation: survivor + every loser must exist, be non-deleted, distinct from
-- the survivor, and share the survivor's card_type.
--
-- Result JSON shape matches `card.MergeOutput`:
--   {"ok": true, "survivor_id": "<bigint>", "merged_count": N, "repointed": M}
CREATE OR REPLACE FUNCTION card_merge_batch(
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
    _survivor bigint;
    _losers bigint[];
    _loser bigint;
    _surv_ct bigint;
    _ct bigint;
    _repointed int;
    _bad_code text;
    _bad_msg text;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _bad_code := NULL;
        _bad_msg := NULL;

        BEGIN
            _survivor := NULLIF(_raw->>'survivor_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _survivor := NULL;
        END;

        -- Parse loser_ids[] (numeric strings or numbers), deduped.
        SELECT COALESCE(array_agg(DISTINCT x), '{}'::bigint[]) INTO _losers
        FROM (
            SELECT (e.v #>> '{}')::bigint AS x
            FROM jsonb_array_elements(COALESCE(_raw->'loser_ids', '[]'::jsonb)) AS e(v)
            WHERE (e.v #>> '{}') ~ '^-?\d+$'
        ) q;

        IF _survivor IS NULL OR _survivor = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.merge: survivor_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF array_length(_losers, 1) IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.merge: loser_ids must be a non-empty array'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _survivor = ANY(_losers) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.merge: survivor_id cannot also be a loser'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT card_type_id INTO _surv_ct FROM card
        WHERE id = _survivor AND deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('card.merge: survivor %s not found or deleted', _survivor), NULL::jsonb;
            CONTINUE;
        END IF;

        -- Every loser must exist, be live, and share the survivor's card_type.
        FOREACH _loser IN ARRAY _losers LOOP
            SELECT card_type_id INTO _ct FROM card
            WHERE id = _loser AND deleted_at IS NULL;
            IF NOT FOUND THEN
                _bad_code := 'card_not_found';
                _bad_msg := format('card.merge: loser %s not found or deleted', _loser);
                EXIT;
            END IF;
            IF _ct <> _surv_ct THEN
                _bad_code := 'card_type_mismatch';
                _bad_msg := format('card.merge: loser %s is a different card_type than survivor %s', _loser, _survivor);
                EXIT;
            END IF;
        END LOOP;
        IF _bad_code IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false, _bad_code, _bad_msg, NULL::jsonb;
            CONTINUE;
        END IF;

        _repointed := card_merge_into(_survivor, _losers, actor_id);

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'survivor_id', _survivor::text,
                'merged_count', array_length(_losers, 1),
                'repointed', _repointed
            );
    END LOOP;
END;
$$;

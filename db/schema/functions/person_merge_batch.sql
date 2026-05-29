-- person.merge handler — merge duplicate person cards (contact / assignee /
-- user that turned out to be the same human) into one survivor. Layers the
-- person-specific concerns on top of the shared card_merge_into primitive:
--
--   1. Validate survivor + losers are all live `person` cards, distinct.
--   2. LOGIN guard: at most ONE record in the set (survivor ∪ losers) may carry
--      a user_account_person link. Merging two logins is really a user-account
--      merge (sessions / tokens / agents / roles / oidc_sub) and is out of scope
--      here — >1 link rejects with 'merge_login_conflict' so an admin resolves
--      the duplicate logins first. The sole link (if on a loser) moves to the
--      survivor.
--   3. Backfill the survivor's email from the first loser that has one, when the
--      survivor's own email is blank (so a merged contact's email isn't lost).
--   4. card_merge_into: repoint every assignee / originator / comm_recipients
--      (and any other person card_ref) loser -> survivor, soft-delete losers,
--      emit merge activity.
--
-- Per-row input: {"survivor_id": "<bigint>", "loser_ids": ["<bigint>", ...]}.
-- Result JSON shape matches `person.MergeOutput`:
--   {"ok": true, "survivor_id": "<bigint>", "merged_count": N, "repointed": M,
--    "moved_login": bool}
CREATE OR REPLACE FUNCTION person_merge_batch(
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
    _person_ct bigint;
    _ct bigint;
    _link_count int;
    _moved_login boolean;
    _repointed int;
    _email_def bigint;
    _surv_email text;
    _loser_email text;
    _act bigint;
    _bad_code text;
    _bad_msg text;
BEGIN
    SELECT id INTO _person_ct FROM card_type WHERE name = 'person';
    SELECT id INTO _email_def FROM attribute_def WHERE name = 'email';

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _bad_code := NULL;
        _bad_msg := NULL;
        _moved_login := false;

        BEGIN
            _survivor := NULLIF(_raw->>'survivor_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _survivor := NULL;
        END;
        SELECT COALESCE(array_agg(DISTINCT x), '{}'::bigint[]) INTO _losers
        FROM (
            SELECT (e.v #>> '{}')::bigint AS x
            FROM jsonb_array_elements(COALESCE(_raw->'loser_ids', '[]'::jsonb)) AS e(v)
            WHERE (e.v #>> '{}') ~ '^-?\d+$'
        ) q;

        IF _survivor IS NULL OR _survivor = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'person.merge: survivor_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF array_length(_losers, 1) IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'person.merge: loser_ids must be a non-empty array'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _survivor = ANY(_losers) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'person.merge: survivor_id cannot also be a loser'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- Survivor must be a live person card.
        SELECT card_type_id INTO _ct FROM card WHERE id = _survivor AND deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('person.merge: survivor %s not found or deleted', _survivor), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ct <> _person_ct THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('person.merge: survivor %s is not a person card', _survivor), NULL::jsonb;
            CONTINUE;
        END IF;

        -- Each loser must be a live person card.
        FOREACH _loser IN ARRAY _losers LOOP
            SELECT card_type_id INTO _ct FROM card WHERE id = _loser AND deleted_at IS NULL;
            IF NOT FOUND THEN
                _bad_code := 'card_not_found';
                _bad_msg := format('person.merge: loser %s not found or deleted', _loser);
                EXIT;
            END IF;
            IF _ct <> _person_ct THEN
                _bad_code := 'validation';
                _bad_msg := format('person.merge: loser %s is not a person card', _loser);
                EXIT;
            END IF;
        END LOOP;
        IF _bad_code IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false, _bad_code, _bad_msg, NULL::jsonb;
            CONTINUE;
        END IF;

        -- LOGIN guard: at most one linked user_account across the whole set.
        SELECT count(*) INTO _link_count
        FROM user_account_person
        WHERE person_card_id = _survivor OR person_card_id = ANY(_losers);
        IF _link_count > 1 THEN
            RETURN QUERY SELECT _idx, false, 'merge_login_conflict'::text,
                'person.merge: more than one of these people has a login (user_account). '
                || 'Resolve the duplicate logins first; merging user accounts (sessions, tokens, '
                || 'agents, roles) is not supported here.'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- Move a sole loser-held link to the survivor (no-op if it's already on
        -- the survivor; the unique person_card_id holds since survivor has none).
        IF _link_count = 1 THEN
            UPDATE user_account_person SET person_card_id = _survivor
            WHERE person_card_id = ANY(_losers);
            _moved_login := FOUND;
        END IF;

        -- Backfill the survivor's email when blank, from the first loser with one.
        IF _email_def IS NOT NULL THEN
            SELECT COALESCE(av.value #>> '{}', '') INTO _surv_email
            FROM attribute_value av
            WHERE av.card_id = _survivor AND av.attribute_def_id = _email_def;
            IF COALESCE(_surv_email, '') = '' THEN
                SELECT av.value #>> '{}' INTO _loser_email
                FROM unnest(_losers) WITH ORDINALITY AS l(id, ord)
                JOIN attribute_value av
                  ON av.card_id = l.id AND av.attribute_def_id = _email_def
                WHERE COALESCE(av.value #>> '{}', '') <> ''
                ORDER BY l.ord
                LIMIT 1;
                IF _loser_email IS NOT NULL THEN
                    INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                    VALUES (_survivor, 'attr_update', _email_def, NULL, to_jsonb(_loser_email), actor_id)
                    RETURNING id INTO _act;
                    INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                    VALUES (_survivor, _email_def, to_jsonb(_loser_email), _act)
                    ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                        SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
                END IF;
            END IF;
        END IF;

        -- Shared graph merge: repoint person refs, soft-delete losers, activity.
        _repointed := card_merge_into(_survivor, _losers, actor_id);

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'survivor_id', _survivor::text,
                'merged_count', array_length(_losers, 1),
                'repointed', _repointed,
                'moved_login', _moved_login
            );
    END LOOP;
END;
$$;

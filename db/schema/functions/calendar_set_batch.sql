-- calendar.set — create (id absent / 0) or update one of the caller's
-- calendar feeds: title, card filter (predicate: the screen-filter JSON,
-- '@me' = the owner; '' = every task they can see), past_days and
-- future_days (0–3650; defaults 30 / 365). The owner is always the caller's
-- person card; on update only the owner (or a workspace admin) may change
-- it. Only changed attributes are written, each with an activity row.
-- docs/MAIL_INTAKE_AND_CALENDARS.md §8.
CREATE OR REPLACE FUNCTION calendar_set_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _person bigint;
    _cal_ct bigint := (SELECT id FROM card_type WHERE name = 'calendar');
    _title_def bigint := (SELECT id FROM attribute_def WHERE name = 'title');
    _sub_def bigint := (SELECT id FROM attribute_def WHERE name = 'subscriber');
    _pred_def bigint := (SELECT id FROM attribute_def WHERE name = 'predicate');
    _past_def bigint := (SELECT id FROM attribute_def WHERE name = 'past_days');
    _future_def bigint := (SELECT id FROM attribute_def WHERE name = 'future_days');
    _id bigint;
    _creating boolean;
    _title text;
    _pred text;
    _past int;
    _future int;
BEGIN
    IF _cal_ct IS NULL OR _past_def IS NULL OR _future_def IS NULL THEN
        RAISE EXCEPTION 'calendar.set: the calendar card_type is missing (migration 0024)' USING ERRCODE = 'P0001';
    END IF;
    SELECT uap.person_card_id INTO _person FROM user_account_person uap
    WHERE uap.user_account_id = calendar_set_batch.actor_id;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'id', '0') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'calendar.set: id must be a card id'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _id := COALESCE(NULLIF(_raw->>'id', ''), '0')::bigint;
        _creating := _id = 0;
        _title := btrim(COALESCE(_raw->>'title', ''));
        _pred := COALESCE(_raw->>'predicate', '');

        IF _person IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'no_person'::text,
                'calendar.set: your account has no linked person card to own a calendar'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF (_creating OR _raw ? 'title') AND (_title = '' OR length(_title) > 200) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'calendar.set: a title (up to 200 characters) is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF (_raw ? 'past_days' AND COALESCE(_raw->>'past_days', '') !~ '^\d{1,4}$')
           OR (_raw ? 'future_days' AND COALESCE(_raw->>'future_days', '') !~ '^\d{1,4}$') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'calendar.set: past_days and future_days are whole days, 0 to 3650'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _past := COALESCE(NULLIF(_raw->>'past_days', '')::int, CASE WHEN _creating THEN 30 END);
        _future := COALESCE(NULLIF(_raw->>'future_days', '')::int, CASE WHEN _creating THEN 365 END);
        IF COALESCE(_past, 0) > 3650 OR COALESCE(_future, 0) > 3650 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'calendar.set: past_days and future_days are whole days, 0 to 3650'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF btrim(_pred) <> '' THEN
            BEGIN
                IF jsonb_typeof(_pred::jsonb) <> 'object' THEN
                    RAISE EXCEPTION 'the filter must be a JSON object';
                END IF;
                PERFORM card_compile_predicate(_resolve_me_tokens(_pred::jsonb, _person), '[]'::jsonb, ARRAY[]::bigint[], _person);
            EXCEPTION WHEN OTHERS THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    format('calendar.set: the filter is not valid: %s', CASE WHEN SQLSTATE = 'P0001' THEN SQLERRM ELSE 'it can''t be read' END), NULL::jsonb;
                CONTINUE;
            END;
        END IF;

        -- At most 50 calendars each (review 2026-11-03 round 4: nothing
        -- capped it).
        IF _creating AND (SELECT count(*) FROM card c
                          JOIN attribute_value sv ON sv.card_id = c.id AND sv.attribute_def_id = _sub_def
                          WHERE c.card_type_id = _cal_ct AND c.deleted_at IS NULL
                            AND sv.value = to_jsonb(_person)) >= 50 THEN
            RETURN QUERY SELECT _idx, false, 'limit'::text,
                'calendar.set: you can have at most 50 calendars'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _creating THEN
            INSERT INTO card (card_type_id, parent_card_id) VALUES (_cal_ct, NULL) RETURNING card.id INTO _id;
            INSERT INTO activity (card_id, kind, actor_id) VALUES (_id, 'card_create', calendar_set_batch.actor_id);
        ELSIF NOT calendar_owned_by(_id, calendar_set_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('calendar.set: calendar %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;

        WITH want(ord, attr_def_id, value) AS (
            SELECT row_number() OVER () AS ord, w.attr_def_id, w.value FROM (
                SELECT _title_def AS attr_def_id, to_jsonb(_title) AS value WHERE _creating OR _raw ? 'title'
                UNION ALL SELECT _sub_def, to_jsonb(_person) WHERE _creating
                UNION ALL SELECT _pred_def, to_jsonb(_pred) WHERE _raw ? 'predicate'
                UNION ALL SELECT _past_def, to_jsonb(_past) WHERE _past IS NOT NULL
                UNION ALL SELECT _future_def, to_jsonb(_future) WHERE _future IS NOT NULL
            ) w
        ),
        changed AS (
            SELECT w.ord, w.attr_def_id, w.value, cur.value AS old_value
            FROM want w
            LEFT JOIN attribute_value cur ON cur.card_id = _id AND cur.attribute_def_id = w.attr_def_id
            WHERE cur.value IS DISTINCT FROM w.value
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _id, 'attr_update', c.attr_def_id, c.old_value, c.value, calendar_set_batch.actor_id
            FROM changed c ORDER BY c.ord
            RETURNING activity.id, attribute_def_id, value_new
        )
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        SELECT _id, ia.attribute_def_id, ia.value_new, ia.id FROM ins_activity ia
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('id', _id::text);
    END LOOP;
END;
$$;

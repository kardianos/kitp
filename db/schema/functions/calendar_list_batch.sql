-- calendar.list — the caller's calendar feeds (owner = their person card),
-- each with its filter, window and secret URLs (comment, the token's first
-- characters, last fetched and by which app, last error — the token itself
-- is never stored). docs/MAIL_INTAKE_AND_CALENDARS.md §8.
CREATE OR REPLACE FUNCTION calendar_list_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _person bigint;
BEGIN
    SELECT uap.person_card_id INTO _person FROM user_account_person uap
    WHERE uap.user_account_id = calendar_list_batch.actor_id;
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('calendars', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', c.id::text,
                'title', COALESCE((SELECT v.value #>> '{}' FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                   WHERE v.card_id = c.id AND d.name = 'title'), ''),
                'predicate', COALESCE((SELECT v.value #>> '{}' FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                       WHERE v.card_id = c.id AND d.name = 'predicate' AND jsonb_typeof(v.value) = 'string'), ''),
                'past_days', COALESCE((SELECT (v.value)::text::int FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                       WHERE v.card_id = c.id AND d.name = 'past_days' AND jsonb_typeof(v.value) = 'number'), 30),
                'future_days', COALESCE((SELECT (v.value)::text::int FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
                                         WHERE v.card_id = c.id AND d.name = 'future_days' AND jsonb_typeof(v.value) = 'number'), 365),
                'urls', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', a.id::text,
                        'comment', a.comment,
                        'hint', a.hint,
                        'created_at', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'last_used_at', COALESCE(to_char(a.last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
                        'last_client', a.last_client,
                        'last_error', a.last_error,
                        'last_error_at', COALESCE(to_char(a.last_error_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
                    ) ORDER BY a.id)
                    FROM card_access a WHERE a.card_id = c.id AND a.purpose = 'calendar'), '[]'::jsonb)
            ) ORDER BY c.id)
            FROM card c
            JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'calendar'
            JOIN attribute_value sv ON sv.card_id = c.id
            JOIN attribute_def sd ON sd.id = sv.attribute_def_id AND sd.name = 'subscriber'
            WHERE c.deleted_at IS NULL AND _person IS NOT NULL
              AND jsonb_typeof(sv.value) = 'number' AND (sv.value)::text::bigint = _person
        ), '[]'::jsonb));
    END LOOP;
END;
$$;

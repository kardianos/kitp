-- personal_cap_full — whether a person already holds as many of one kind of
-- personal card as they may: 200 personal screens, 200 watch lists, 50
-- calendars, 500 personal views (filter cards private to them). NULL for a
-- type without a cap is false.
--
-- Screens, watch lists and views are counted by private_to, whatever their
-- parent (a screen moved under a project dropped out of a count that looked
-- only at parentless ones); calendars by their subscriber. Only live cards
-- count, so card.undelete checks again. A transaction advisory lock on
-- (type, person) comes first, so two creates at once can't both pass on
-- the last place (review 2026-11-03 round 5 #11).
CREATE OR REPLACE FUNCTION personal_cap_full(p_type text, p_person bigint)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
    _cap int;
    _n bigint;
BEGIN
    _cap := CASE p_type
        WHEN 'screen' THEN 200
        WHEN 'watch_list' THEN 200
        WHEN 'calendar' THEN 50
        WHEN 'filter' THEN 500
    END;
    IF _cap IS NULL OR p_person IS NULL THEN
        RETURN false;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('kitp.personal_cap:' || p_type || ':' || p_person, 0));
    IF p_type = 'calendar' THEN
        SELECT count(*) INTO _n
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'calendar'
        JOIN attribute_value sv ON sv.card_id = c.id
         AND sv.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'subscriber')
        WHERE c.deleted_at IS NULL
          AND sv.value_type_id < 50 AND sv.value = to_jsonb(p_person);
    ELSE
        SELECT count(*) INTO _n
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = p_type
        WHERE c.deleted_at IS NULL AND c.private_to = p_person;
    END IF;
    RETURN _n >= _cap;
END;
$$;

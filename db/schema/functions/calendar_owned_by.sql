-- calendar_owned_by — whether a user may manage a calendar card: its
-- `subscriber` is their linked person card, or they are a workspace admin
-- (so a departed user's calendars can be cleaned up). False for anything
-- that isn't a live calendar. docs/MAIL_INTAKE_AND_CALENDARS.md §8.
CREATE OR REPLACE FUNCTION calendar_owned_by(_cal bigint, _actor bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'calendar'
        WHERE c.id = _cal AND c.deleted_at IS NULL
          AND (user_is_global_admin(_actor)
               OR EXISTS (SELECT 1 FROM attribute_value av
                          JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'subscriber'
                          JOIN user_account_person uap ON uap.user_account_id = _actor
                          WHERE av.card_id = c.id AND jsonb_typeof(av.value) = 'number'
                            AND (av.value)::text::bigint = uap.person_card_id)))
$$;

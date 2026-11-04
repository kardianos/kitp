-- account_person — the person card an account acts as for its own things:
-- its watch lists, personal screens and views, and every private card
-- (card.private_to; docs/PERSONAL_SCREENS.md). Its own linked person, or for
-- a personal agent its owner's (an agent sees and writes for its owner).
-- NULL when there is none: such an account has no personal things. A
-- workspace agent (owned by System, user_account 1) has none: through
-- System's person every workspace agent, and System, read and deleted each
-- other's personal things (review 2026-11-03 round 3 #2).
CREATE OR REPLACE FUNCTION account_person(_actor bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT uap.person_card_id
    FROM user_account ua
    JOIN user_account_person uap
      ON uap.user_account_id = CASE WHEN NOT ua.is_agent THEN ua.id
                                    WHEN ua.parent_user_id <> 1 THEN ua.parent_user_id END
    JOIN card p ON p.id = uap.person_card_id AND p.deleted_at IS NULL
    WHERE ua.id = _actor
    ORDER BY uap.person_card_id
    LIMIT 1
$$;

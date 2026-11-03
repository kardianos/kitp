-- watch_owner — the person card whose watch lists an account uses: its own
-- linked person, or for an agent its owner's (an agent bookmarks for its
-- owner, as it writes for them). NULL when there is none: such an account
-- has no watch lists. docs/WATCH_LISTS.md.
CREATE OR REPLACE FUNCTION watch_owner(_actor bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT uap.person_card_id
    FROM user_account ua
    JOIN user_account_person uap
      ON uap.user_account_id = CASE WHEN ua.is_agent THEN ua.parent_user_id ELSE ua.id END
    JOIN card p ON p.id = uap.person_card_id AND p.deleted_at IS NULL
    WHERE ua.id = _actor
    ORDER BY uap.person_card_id
    LIMIT 1
$$;

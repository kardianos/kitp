-- card_private_ok — whether, as far as privacy goes, an account may see or
-- write a card: the card isn't private (card.private_to NULL), or it is
-- private to the account's person (account_person: its login, or an agent's
-- owner). docs/PERSONAL_SCREENS.md. The listing reads that can surface
-- private cards AND it next to their role check; VisibilityClause and
-- card_visible_to apply the same rule themselves.
CREATE OR REPLACE FUNCTION card_private_ok(_card bigint, _actor bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM card c
        WHERE c.id = _card AND c.private_to IS NOT NULL
          AND c.private_to IS DISTINCT FROM account_person(_actor))
$$;

-- card_live — whether a card and every card above it are undeleted. A file
-- on a deleted task, or on a live task under a deleted project, is as gone
-- as the card: its download, listing and copying all ask this (review
-- 2026-11-03 round 4 #16), as portal serving does. The walk is
-- card_ancestors' (depth-capped).
CREATE OR REPLACE FUNCTION card_live(card bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM card_ancestors(card_live.card) up
        JOIN card x ON x.id = up.id
        WHERE x.deleted_at IS NOT NULL)
$$;

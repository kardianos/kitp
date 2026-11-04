-- publication_withdraw — take a page (and the portals' copies of it) off
-- every portal, so it disappears from the sites on their next build; it
-- goes live again the next time it enters a publishing status. Returns the
-- number of portals touched. card.delete no longer calls it: a deleted
-- card's pages keep their publications (the build and serving skip pages
-- under a deleted card) so card.undelete brings them back (review
-- 2026-11-03 round 2 #19).
CREATE OR REPLACE FUNCTION publication_withdraw(page_id bigint)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
    _portal bigint;
    _n int := 0;
BEGIN
    FOR _portal IN SELECT p.portal_id FROM publication p WHERE p.card_id = page_id
    LOOP
        PERFORM portal_mark_dirty(_portal);
        _n := _n + 1;
    END LOOP;
    DELETE FROM publication WHERE card_id = page_id;
    RETURN _n;
END;
$$;

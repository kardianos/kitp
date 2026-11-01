-- publication_withdraw — take a page (and the portals' copies of it) off
-- every portal; card.delete calls it when a page is deleted, so a deleted
-- page disappears from the sites on their next build. Restoring the page
-- doesn't republish it: it goes live again the next time it enters a
-- publishing status. Returns the number of portals touched.
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

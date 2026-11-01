-- publication_after_write — the publishing hook attribute.update calls
-- after every successful write (one cheap lookup when it doesn't apply):
--   - a page's publish_status changed → publication_sync (publish /
--     withdraw / leave pinned, per the page's new status);
--   - any attribute of a portal card changed (title, root page, host,
--     public) → the portal is rebuilt.
-- Other writes are ignored: editing a page's body or title never changes
-- what a portal shows until the page re-enters a publishing status.
CREATE OR REPLACE FUNCTION publication_after_write(card_id bigint, attr_name text, actor_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    _ct text;
BEGIN
    SELECT ct.name INTO _ct
    FROM card c JOIN card_type ct ON ct.id = c.card_type_id
    WHERE c.id = publication_after_write.card_id;
    IF _ct = 'page' AND attr_name = 'publish_status' THEN
        PERFORM publication_sync(card_id, actor_id);
    ELSIF _ct = 'portal' THEN
        PERFORM portal_mark_dirty(card_id);
    END IF;
END;
$$;

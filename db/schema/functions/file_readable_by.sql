-- file_readable_by — whether an account may have a stored file's bytes:
--   - it uploaded the file itself;
--   - its agent or owner (account_principal, as cas_held_by and import jobs
--     compare; round 3 #20) uploaded it in the last day and it has never
--     been attached — an upload in flight, handed from one to the other.
--     Past that, an agent reads it only where its own grants reach: a
--     principal match for every file let an agent scoped to one project
--     read everything its owner ever uploaded (round 4 #11), and one for
--     every unattached file still let it read its owner's old CSV imports
--     and files whose attachments were deleted, by sequential id (round 5,
--     worth a look);
--   - or it is attached (live) to a live card whose bytes the account may
--     download — the byte routes' rule (attachment/http.go
--     requireAttachmentAccess, DI-3): `card.update` on the card's project,
--     the card and those above it undeleted (card_live, round 4 #16), not
--     in an area that is off nor someone else's private card.
--
-- Anything that hands over a file's bytes by file id asks this:
-- attachment.create (attaching a file to your own card makes it yours to
-- download) and the CSV import's reads. Seeing a card is not enough — a
-- viewer may not download its files, so may not copy them either (review
-- 2026-11-03 B4, round 2 #10).
CREATE OR REPLACE FUNCTION file_readable_by(reader bigint, file bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM file f WHERE f.id = file_readable_by.file AND f.created_by = reader)
        OR EXISTS (SELECT 1 FROM file f
                   WHERE f.id = file_readable_by.file
                     AND account_principal(f.created_by) = account_principal(reader)
                     AND f.created_at > now() - interval '1 day'
                     AND NOT EXISTS (SELECT 1 FROM attachment a WHERE a.file_id = f.id))
        OR EXISTS (
            SELECT 1
            FROM attachment a
            JOIN card c ON c.id = a.card_id AND c.deleted_at IS NULL
            JOIN card_type ct ON ct.id = c.card_type_id
            WHERE a.file_id = file_readable_by.file AND a.deleted_at IS NULL
              AND card_live(a.card_id)
              AND NOT card_in_off_area(a.card_id)
              AND card_private_ok(a.card_id, reader)
              AND user_has_grant(reader, 'project', 'card.update',
                      CASE WHEN ct.name = 'project' THEN a.card_id
                           ELSE card_enclosing_project(a.card_id) END))
$$;

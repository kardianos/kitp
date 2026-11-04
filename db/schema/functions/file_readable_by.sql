-- file_readable_by — whether an account may have a stored file's bytes: it
-- uploaded the file (it, or for an agent its owner — account_principal, the
-- rule cas_held_by and import jobs use; round 3 #20), or the file is
-- attached (live) to a card whose bytes
-- the account may download — the byte routes' rule (attachment/http.go
-- requireAttachmentAccess, DI-3): `card.update` on the card's project, the
-- card not in an area that is off nor someone else's private card.
--
-- Anything that hands over a file's bytes by file id asks this:
-- attachment.create (attaching a file to your own card makes it yours to
-- download) and the CSV import's reads. Seeing a card is not enough — a
-- viewer may not download its files, so may not copy them either (review
-- 2026-11-03 B4, round 2 #10).
CREATE OR REPLACE FUNCTION file_readable_by(reader bigint, file bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM file f WHERE f.id = file_readable_by.file
                   AND account_principal(f.created_by) = account_principal(reader))
        OR EXISTS (
            SELECT 1
            FROM attachment a
            JOIN card c ON c.id = a.card_id AND c.deleted_at IS NULL
            JOIN card_type ct ON ct.id = c.card_type_id
            WHERE a.file_id = file_readable_by.file AND a.deleted_at IS NULL
              AND NOT card_in_off_area(a.card_id)
              AND card_private_ok(a.card_id, reader)
              AND user_has_grant(reader, 'project', 'card.update',
                      CASE WHEN ct.name = 'project' THEN a.card_id
                           ELSE card_enclosing_project(a.card_id) END))
$$;

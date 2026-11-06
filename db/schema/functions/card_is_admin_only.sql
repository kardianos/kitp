-- card_is_admin_only — true for a card only a workspace admin writes through
-- the generic handlers (attribute.update, card.insert / .delete / .undelete /
-- .merge / .move): a mail account (comm_channel) or an activity sink. Their own
-- handlers (comm_channel.set, activity_sink.set) are workspace-admin only, and
-- their server, port, username and From decide where kitp logs in with the
-- stored password, so a project-scoped admin's card.update grant must not
-- reach them another way (review 2026-11-06 #2).
CREATE OR REPLACE FUNCTION card_is_admin_only(card_id bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id
        WHERE c.id = card_is_admin_only.card_id
          AND ct.name IN ('comm_channel', 'activity_sink'))
$$;

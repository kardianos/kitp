-- person_referable — whether an account may name a person on a card in a
-- project: as a task's originator or assignee (any card_ref to person), or
-- as a thread's recipient. A person card has no project, so the generic
-- cross-project check treats it as a wildcard; but what is named comes back
-- out — the export prints the person's name and email, a thread's To shows
-- the address, a digest the title, and comm.create mails them from the
-- project's account. So a person is referable when:
--   - the account can see the person (card_visible_to: a workspace-wide role
--     sees everyone — card.search offers people only to them); or
--   - the person's login holds a role in the project or workspace-wide (a
--     member); or
--   - the person is already named on a live card in the project (a contact
--     on one of its threads, an earlier originator).
-- (review 2026-11-06 #5). A NULL project: the card isn't in one; only sight
-- counts.
CREATE OR REPLACE FUNCTION person_referable(actor_id bigint, person_id bigint, project_id bigint)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF card_visible_to(person_referable.actor_id, person_referable.person_id) THEN
        RETURN true;
    END IF;
    IF person_referable.project_id IS NULL THEN
        RETURN false;
    END IF;
    IF EXISTS (
        SELECT 1 FROM user_account_person uap
        JOIN user_account ua ON ua.id = uap.user_account_id
            AND ua.deleted_at IS NULL AND ua.login_revoked_at IS NULL
        JOIN user_role ur ON ur.user_id = uap.user_account_id
        WHERE uap.person_card_id = person_referable.person_id
          AND (ur.scope_card_id IS NULL OR ur.scope_card_id = person_referable.project_id)
    ) THEN
        RETURN true;
    END IF;
    -- Two lookups, one per storage class, so each reaches its index: a
    -- card_ref is a scalar (the (attribute_def_id, value) btree, behind the
    -- value_type_id < 50 guard), a card_ref[] a list (the attribute_value_refs
    -- GIN). One CASE over both hid both indexes and read every person
    -- reference in the workspace on each call (review 2026-11-06 round 8
    -- L14). A task's project is its parent; the walk is for deeper cards.
    RETURN EXISTS (
        SELECT 1
        FROM attribute_value av
        JOIN card c ON c.id = av.card_id AND c.deleted_at IS NULL
        WHERE av.attribute_def_id IN (
                SELECT ad.id FROM attribute_def ad
                WHERE ad.value_type = 'card_ref'
                  AND ad.target_card_type_id = (SELECT id FROM card_type WHERE name = 'person'))
          AND av.value_type_id < 50
          AND av.value = to_jsonb(person_referable.person_id)
          AND (c.parent_card_id = person_referable.project_id
               OR card_enclosing_project(c.id) = person_referable.project_id)
    ) OR EXISTS (
        SELECT 1
        FROM attribute_value av
        JOIN card c ON c.id = av.card_id AND c.deleted_at IS NULL
        WHERE av.attribute_def_id IN (
                SELECT ad.id FROM attribute_def ad
                WHERE ad.value_type = 'card_ref[]'
                  AND ad.target_card_type_id = (SELECT id FROM card_type WHERE name = 'person'))
          AND jsonb_typeof(av.value) = 'array'
          AND av.value @> jsonb_build_array(person_referable.person_id)
          AND (c.parent_card_id = person_referable.project_id
               OR card_enclosing_project(c.id) = person_referable.project_id)
    );
END
$$;

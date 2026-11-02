-- activity_hidden — whether an activity row is hidden by an area that is
-- switched off (docs/AREAS.md). A row is hidden with its card
-- (card_in_off_area), and also when it records something of another area
-- than its card's: an approval vote (approval_decision) is recorded on the
-- task but belongs to Approvals, so it goes while Approvals is off in the
-- task's project (review A8). Every activity read — the feeds, activity
-- sinks — ANDs NOT this.
CREATE OR REPLACE FUNCTION activity_hidden(kind text, card_id bigint)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF card_in_off_area(activity_hidden.card_id) THEN
        RETURN true;
    END IF;
    IF activity_hidden.kind = 'approval_decision'
       AND EXISTS (SELECT 1 FROM project_area WHERE state = 'off' AND area_key = 'approvals') THEN
        RETURN area_state(COALESCE(card_enclosing_project(activity_hidden.card_id), 0), 'approvals') = 'off';
    END IF;
    RETURN false;
END
$$;

-- activity_hidden — whether an activity row is hidden by an area that is
-- switched off (docs/AREAS.md). A row is hidden with its card
-- (card_in_off_area), and also when it records something of another area
-- than its card's: an approval vote (approval_decision) is recorded on the
-- task but belongs to Approvals, so it goes while Approvals is off in the
-- task's project (review A8) — and so does an edit of a vote's reason (a
-- comment_edit whose value_new.activity_id is an approval_decision), which
-- carries the reason's new text (review 2026-11-03 round 3 #14). Every
-- activity read — the feeds, activity sinks, exports — ANDs NOT this.
CREATE OR REPLACE FUNCTION activity_hidden(kind text, card_id bigint, value_new jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF card_in_off_area(activity_hidden.card_id) THEN
        RETURN true;
    END IF;
    IF activity_hidden.kind IN ('approval_decision', 'comment_edit')
       AND EXISTS (SELECT 1 FROM project_area WHERE state = 'off' AND area_key = 'approvals') THEN
        IF activity_hidden.kind = 'comment_edit' AND NOT EXISTS (
            SELECT 1 FROM activity d
            WHERE d.kind = 'approval_decision'
              AND d.id = CASE WHEN (activity_hidden.value_new->>'activity_id') ~ '^[0-9]{1,18}$'
                              THEN (activity_hidden.value_new->>'activity_id')::bigint END) THEN
            RETURN false;
        END IF;
        RETURN area_state(COALESCE(card_enclosing_project(activity_hidden.card_id), 0), 'approvals') = 'off';
    END IF;
    RETURN false;
END
$$;

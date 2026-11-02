-- card_in_off_area — true when a card belongs to an area that is switched
-- off (docs/AREAS.md): the card, or any card above it (a comm on a task,
-- an attachment's page), has an item type of an area whose project_area
-- row (in the project the card chains up to) or workspace_area row says
-- 'off'. Such a card is hidden completely: card_visible_to,
-- schema.VisibilityClause and every inline DI-6 read AND NOT this, and the
-- dispatcher refuses writes to it.
--
-- A message (reply_body) has no parent card: it belongs to the thread
-- whose `replies` lists it, so its chain continues from that thread — a
-- hidden thread's messages are hidden too (review A9).
--
-- Fast path: when no area is off anywhere, it answers false without
-- walking the card's parents. PL/pgSQL, so its plans are cached per
-- session (a plain-SQL function with subqueries is re-planned on every
-- call, which cost most of a visibility check; review A14).
-- schema.VisibilityClause and card_visible_to fold this same test into
-- their own parent walk instead of calling it; TestVisibilityAgrees keeps
-- the three in step.
--
-- NB: declared before card_visible_to in schema.hcsv.
CREATE OR REPLACE FUNCTION card_in_off_area(card_id bigint)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
    _start bigint := card_in_off_area.card_id;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM project_area WHERE state = 'off')
       AND NOT EXISTS (SELECT 1 FROM workspace_area WHERE state = 'off') THEN
        RETURN false;
    END IF;
    -- A message walks from its thread (a plain walk then, no extra branch
    -- per row for every other card).
    IF EXISTS (SELECT 1 FROM card r JOIN card_type rt ON rt.id = r.card_type_id
               WHERE r.id = card_in_off_area.card_id AND rt.name = 'reply_body') THEN
        SELECT rv.card_id INTO _start
        FROM attribute_value rv
        JOIN attribute_def rd ON rd.id = rv.attribute_def_id AND rd.name = 'replies'
        WHERE jsonb_typeof(rv.value) = 'array' AND rv.value @> to_jsonb(card_in_off_area.card_id)
        ORDER BY rv.card_id
        LIMIT 1;
        IF _start IS NULL THEN
            RETURN false;
        END IF;
    END IF;
    RETURN EXISTS (
        WITH RECURSIVE up(id, parent_card_id, card_type_id, depth) AS (
            SELECT c.id, c.parent_card_id, c.card_type_id, 0
            FROM card c WHERE c.id = _start
            UNION ALL
            SELECT p.id, p.parent_card_id, p.card_type_id, up.depth + 1
            FROM card p JOIN up ON p.id = up.parent_card_id
            WHERE up.depth < 16
        ),
        chain AS (
            SELECT up.id, ct.name FROM up JOIN card_type ct ON ct.id = up.card_type_id
        )
        SELECT 1
        FROM chain x
        JOIN area a ON a.card_types ? x.name
        WHERE (a.scope = 'workspace'
               AND EXISTS (SELECT 1 FROM workspace_area w WHERE w.area_key = a.key AND w.state = 'off'))
           OR (a.scope = 'project'
               AND EXISTS (SELECT 1 FROM project_area pa
                           WHERE pa.area_key = a.key AND pa.state = 'off'
                             AND pa.project_id IN (SELECT y.id FROM chain y WHERE y.name = 'project')))
    );
END
$$;

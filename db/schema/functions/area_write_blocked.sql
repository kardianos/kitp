-- area_write_blocked — the dispatcher's write check for areas: true when a
-- write of card type card_type_id, on card card_id (0 = none, e.g. an
-- insert) in project project_id (0 = none), would touch an area that is
-- off: the card type's own area is off (in that project, or workspace-
-- wide), or the card sits under a card of an off area.
CREATE OR REPLACE FUNCTION area_write_blocked(card_type_id bigint, card_id bigint, project_id bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM project_area WHERE state = 'off')
         AND NOT EXISTS (SELECT 1 FROM workspace_area WHERE state = 'off') THEN false
        ELSE (area_write_blocked.card_id <> 0 AND card_in_off_area(area_write_blocked.card_id))
          OR EXISTS (
              SELECT 1
              FROM card_type ct
              JOIN area a ON a.card_types ? ct.name
              WHERE ct.id = area_write_blocked.card_type_id
                AND ((a.scope = 'workspace'
                      AND EXISTS (SELECT 1 FROM workspace_area w WHERE w.area_key = a.key AND w.state = 'off'))
                  OR (a.scope = 'project'
                      AND EXISTS (SELECT 1 FROM project_area pa
                                  WHERE pa.area_key = a.key AND pa.state = 'off'
                                    AND pa.project_id = area_write_blocked.project_id))))
    END
$$;

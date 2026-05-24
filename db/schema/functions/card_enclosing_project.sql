-- card_enclosing_project — canonical "card → enclosing project"
-- resolver (BE-M3 / A10). Returns the id of the first
-- card_type='project' ancestor of `start` (including `start` itself),
-- or NULL when the chain has no project ancestor within the depth cap.
--
-- Built on card_ancestors so the depth cap lives in exactly one place.
-- Both the in-SQL write functions (card.insert / attribute.update /
-- comm.create / tag.apply / card.move / task.move) and the read-side
-- visibility predicate resolve scope through this one capped walk, so
-- the cap behaviour can't diverge between Go and SQL.
--
-- NB: declared after card_ancestors in schema.hcsv — this is a
-- SQL-language function, so its body references card_ancestors at
-- CREATE time and the callee must already exist.
CREATE OR REPLACE FUNCTION card_enclosing_project(start bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT a.id
    FROM card_ancestors(start) a
    JOIN card_type ct ON ct.id = a.card_type_id
    WHERE ct.name = 'project'
    ORDER BY a.depth
    LIMIT 1
$$;

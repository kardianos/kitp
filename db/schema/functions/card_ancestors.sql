-- card_ancestors — the single capped parent_card_id walk shared by
-- every card-tree ancestor lookup (BE-C1 / SEC-1 / A1).
--
-- Why this exists: the `WHERE depth < 16` cap (CLAUDE.md "Recursive
-- CTE depth cap"; 16 matches internal/api/authz.go's scopeWalkDepth)
-- was being hand-restated in every function that walked the tree, and
-- several walks shipped with NO cap at all — a malicious or accidental
-- parent_card_id cycle could pin a backend connection until
-- statement_timeout. Folding the walk into one helper means the cap is
-- declared exactly once and can never drift between call sites
-- (A15d / BE-L1).
--
-- Returns the chain from `start` (inclusive) up through
-- parent_card_id, one row per hop, with a 0-based `depth` column. The
-- recursive arm carries `WHERE depth < 16`, so the walk terminates
-- after at most 17 rows even if the chain contains a cycle (real
-- hierarchies sit at depth 3-4). STABLE (pure read); runs under the
-- caller's search_path so per-schema test pools resolve the right
-- `card` table.
CREATE OR REPLACE FUNCTION card_ancestors(start bigint)
RETURNS TABLE (
    id bigint,
    parent_card_id bigint,
    card_type_id bigint,
    depth int
) LANGUAGE sql STABLE AS $$
    WITH RECURSIVE chain AS (
        SELECT c.id, c.parent_card_id, c.card_type_id, 0 AS depth
        FROM card c WHERE c.id = start
        UNION ALL
        SELECT p.id, p.parent_card_id, p.card_type_id, ch.depth + 1
        FROM card p
        JOIN chain ch ON p.id = ch.parent_card_id
        WHERE ch.depth < 16
    )
    SELECT chain.id, chain.parent_card_id, chain.card_type_id, chain.depth
    FROM chain
$$;

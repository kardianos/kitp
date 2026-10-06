-- card_filter_ids — the subset of `ids` whose cards satisfy a predicate
-- tree (the screen-filter shape card_compile_predicate compiles).
--
-- Backs attribute_def.target_filter, the per-attribute "which cards may be
-- chosen" rule (e.g. assignee offers no contact or disabled person):
--   * card.search narrows a picker's candidates to the passing ids;
--   * attribute.update / card.insert reject a newly chosen card_ref value
--     that isn't in the result.
--
-- The tree is compiled ONCE, then EXECUTEd against the whole id list, so
-- callers pay one compile per call rather than one per card. The compiled
-- fragment references `c.id` and the `$1` params bag; `$2` is the id list.
--
-- A NULL / non-object / empty tree passes every id unchanged. Result order
-- is unspecified; callers test membership.
CREATE OR REPLACE FUNCTION card_filter_ids(tree jsonb, ids bigint[])
RETURNS bigint[] LANGUAGE plpgsql AS $$
DECLARE
    _compiled jsonb;
    _out bigint[];
BEGIN
    IF ids IS NULL OR cardinality(ids) = 0 THEN
        RETURN ARRAY[]::bigint[];
    END IF;
    IF tree IS NULL OR jsonb_typeof(tree) <> 'object' OR tree = '{}'::jsonb THEN
        RETURN ids;
    END IF;
    _compiled := card_compile_predicate(tree, '[]'::jsonb, ARRAY[]::bigint[]);
    EXECUTE format(
        'SELECT COALESCE(array_agg(c.id), ARRAY[]::bigint[]) FROM card c WHERE c.id = ANY($2) AND (%s)',
        _compiled->>'sql')
      INTO _out
      USING _compiled->'params', ids;
    RETURN _out;
END;
$$;

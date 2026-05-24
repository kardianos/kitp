-- _ph_push — the placeholder-bag append primitive for
-- card_compile_predicate (BE-H2 safe increment / A13).
--
-- Why this exists: every leaf of the predicate compiler used to append
-- a value to the JSONB params bag and then compute that value's
-- placeholder index by hand — `(_ph_count - 2)`, `(_ph_count - 1)`,
-- `(_ph_count - jsonb_array_length(_values) - 1)`, etc. That
-- hand-counted arithmetic is an off-by-one waiting to happen: add one
-- more appended value to a leaf and every downstream offset in that leaf
-- silently shifts, miscounting args and corrupting the emitted SQL.
--
-- _ph_push folds "append + report index" into one call so no leaf
-- computes an offset by hand. It returns the NEW params bag plus the
-- 0-based index the value now occupies (= the array length before the
-- append). Callers use it as:
--
--   SELECT p, i INTO params, _idx FROM _ph_push(params, val) AS r(p, i);
--
-- then reference _idx in the emitted `($1->_idx)` fragment. STABLE /
-- IMMUTABLE-ish (pure transform of its args); declared before
-- card_compile_predicate in schema.hcsv.
CREATE OR REPLACE FUNCTION _ph_push(params jsonb, val jsonb)
RETURNS TABLE (params_out jsonb, idx int)
LANGUAGE sql IMMUTABLE AS $$
    SELECT params || jsonb_build_array(val), jsonb_array_length(params)
$$;

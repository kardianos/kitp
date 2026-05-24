-- cas.missing_chunks handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runMissingChunks into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Decode the addresses[] string array (JSONB array of text). Empty
--      / missing -> result.missing = [].
--   2. Anti-join unnest(addresses) against cas_blob; absent addresses
--      come back in result.missing.
--
-- Duplicate-input semantics: the legacy Go body passed in.Addresses
-- straight to `unnest($1::text[])`, which means an address that appears
-- N times in the input came back N times in the output if it was
-- absent from cas_blob. We preserve that behaviour by retaining the
-- `WITH ORDINALITY` pass and not deduping; clients that want unique
-- results dedupe client-side. Matches the pattern in
-- cas_*_batch.sql helpers that explicitly carry ordinality so
-- duplicated inputs map to duplicated outputs.
--
-- Result JSON shape matches cas.MissingChunksOutput:
--   {"missing": ["addr1", "addr2", ...]}
CREATE OR REPLACE FUNCTION cas_missing_chunks_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (
    idx int,
    ok boolean,
    code text,
    message text,
    result jsonb
) LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _addrs_raw jsonb;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _addrs_raw := _raw->'addresses';
        IF _addrs_raw IS NULL OR jsonb_typeof(_addrs_raw) <> 'array'
           OR jsonb_array_length(_addrs_raw) = 0 THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('missing', '[]'::jsonb);
            CONTINUE;
        END IF;

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('missing', COALESCE((
                SELECT jsonb_agg(a.address ORDER BY a.ord)
                FROM jsonb_array_elements_text(_addrs_raw)
                     WITH ORDINALITY AS a(address, ord)
                WHERE NOT EXISTS (
                    SELECT 1 FROM cas_blob cb WHERE cb.address = a.address
                )
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

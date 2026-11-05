-- file.create handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side file.runCreate into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Filename presence + extension check. The richer Unicode
--      normalisation (NFC + bidi/zero-width strip + control trim) lives
--      in Go (textnorm.Filename, invoked via CreateInput.UnmarshalJSON
--      before the dispatcher hands the input here) — only the cheap
--      post-normalisation gate is repeated in PL/pgSQL so a malformed
--      payload that somehow bypasses the input struct still gets caught.
--   2. Chunk-list presence + per-chunk address/size validation.
--   3. mime_type defaulting to application/octet-stream.
--   4. Single-chunk files: sha256 = the lone chunk's CAS address so
--      dedup queries can index `file.sha256` without walking
--      file_chunk; multi-chunk files leave sha256 NULL (the comment in
--      file.go's old Go body explains the rationale — the dedup
--      feature only matters for typical email-size attachments).
--   5. INSERT file row + INSERT file_chunk[] straight from the chunks
--      array (jsonb_array_elements WITH ORDINALITY; set-based, review
--      2026-11-03 round 5 #1). FK on file_chunk.cas_address
--      surfaces a foreign_key_violation if the caller forgot to upload
--      a chunk first — that propagates as a tx-level abort the
--      dispatcher maps to code='fk_violation'.
--
-- Result JSON shape matches `file.CreateOutput`:
--   {"id": "<bigint>", "filename": "...", "mime_type": "...",
--    "size_bytes": <int>}
-- The bigint id is cast to text because Go uses `json:",string"` for
-- 64-bit ids (the dispatcher's wire convention).
CREATE OR REPLACE FUNCTION file_create_batch(
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
    _row jsonb;
    _filename text;
    _mime text;
    _chunks jsonb;
    _chunk_idx int;
    _addr text;
    _total bigint;
    _sha text;
    _new_id bigint;
    _rej_msg text;
    _readers bigint[];
BEGIN
    FOR _idx, _row IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _filename := COALESCE(_row->>'filename', '');
        _mime := COALESCE(_row->>'mime_type', '');
        IF _mime = '' THEN
            _mime := 'application/octet-stream';
        END IF;
        _chunks := _row->'chunks';

        IF _filename = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'file.create: filename is empty'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        -- Extension check mirrors textnorm.Filename's "must contain `.`
        -- with content on both sides". The Go-side normaliser already
        -- ran (via CreateInput.UnmarshalJSON) so this is a belt-and-
        -- braces guard, not the primary line of defence.
        IF position('.' IN _filename) = 0
           OR _filename ~ '^\.'
           OR _filename ~ '\.$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'file.create: filename must have an extension'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        IF _chunks IS NULL OR jsonb_typeof(_chunks) <> 'array'
           OR jsonb_array_length(_chunks) = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'file.create: at least one chunk is required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- At most 100,000 chunks a file (cas.missing_chunks' cap: 100 GB
        -- of 1 MB chunks).
        IF jsonb_array_length(_chunks) > 100000 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'file.create: a file has at most 100000 chunks'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- The chunks are read set-based, once each: appending to a jsonb
        -- array per chunk made a file of n chunks cost n² — 5,000 chunks
        -- ran past the timeout — and every chunk, repeats included, paid
        -- its own holder check (review 2026-11-03 round 5 #1). First the
        -- first chunk with no address or a bad size, then the first whose
        -- bytes the caller doesn't hold (cas_held_by's rule: knowing a
        -- hash isn't having the file, round 2 #21; the same answer as for
        -- bytes kitp doesn't have, round 3 #18), each distinct address
        -- probed once by key.
        SELECT c.seq,
               CASE WHEN c.addr = '' THEN format('file.create: chunks[%s].address is required', c.seq)
                    ELSE format('file.create: chunks[%s].size_bytes must be non-negative', c.seq) END
          INTO _chunk_idx, _rej_msg
        FROM (
            SELECT (e.ord - 1)::int AS seq,
                   COALESCE(e.v->>'address', '') AS addr,
                   COALESCE(NULLIF(e.v->>'size_bytes', ''), '0') AS size_raw
            FROM jsonb_array_elements(_chunks) WITH ORDINALITY AS e(v, ord)
        ) c
        WHERE c.addr = '' OR c.size_raw !~ '^[0-9]{1,18}$'
        ORDER BY c.seq
        LIMIT 1;
        IF FOUND THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, _rej_msg, NULL::jsonb;
            CONTINUE;
        END IF;
        _readers := COALESCE(_readers, cas_reader_principals(file_create_batch.actor_id));
        WITH c AS (
            SELECT (e.ord - 1)::int AS seq, e.v->>'address' AS addr
            FROM jsonb_array_elements(_chunks) WITH ORDINALITY AS e(v, ord)
        ),
        not_held AS (
            SELECT d.addr FROM (SELECT DISTINCT addr FROM c) d
            WHERE NOT EXISTS (SELECT 1 FROM cas_blob_holder h
                              WHERE h.address = d.addr AND h.user_id = ANY (_readers))
        )
        SELECT c.seq, c.addr INTO _chunk_idx, _addr
        FROM c JOIN not_held n ON n.addr = c.addr
        ORDER BY c.seq
        LIMIT 1;
        IF FOUND THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('file.create: chunk %s (%s) hasn''t been uploaded', _chunk_idx, _addr), NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT COALESCE(sum(COALESCE(NULLIF(e.v->>'size_bytes', ''), '0')::bigint), 0) INTO _total
        FROM jsonb_array_elements(_chunks) AS e(v);

        -- Single-chunk file: persist sha256 from the lone chunk's CAS
        -- address so dedup queries index a single column. Multi-chunk
        -- files leave sha256 NULL.
        IF jsonb_array_length(_chunks) = 1 THEN
            _sha := _chunks->0->>'address';
        ELSE
            _sha := NULL;
        END IF;

        INSERT INTO file (filename, size_bytes, mime_type, created_by, sha256)
        VALUES (_filename, _total, _mime, actor_id, _sha)
        RETURNING id INTO _new_id;
        INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size)
        SELECT _new_id, (e.ord - 1)::int, e.v->>'address',
               COALESCE(NULLIF(e.v->>'size_bytes', ''), '0')::bigint
        FROM jsonb_array_elements(_chunks) WITH ORDINALITY AS e(v, ord);

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'id', _new_id::text,
                'filename', _filename,
                'mime_type', _mime,
                'size_bytes', _total
            );
    END LOOP;
END;
$$;

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
--   5. INSERT file row + INSERT file_chunk[] from a jsonb_to_recordset
--      derived from the chunks array. FK on file_chunk.cas_address
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
    _chunk jsonb;
    _chunk_idx int;
    _addr text;
    _size bigint;
    _total bigint;
    _sha text;
    _new_id bigint;
    _norm_chunks jsonb;
    _rej_code text;
    _rej_msg text;
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

        -- Walk chunks, summing size and validating per-entry shape.
        -- Also build a normalised JSON array tagged with seq/cas_address/
        -- chunk_size so the INSERT can fan it out with one
        -- jsonb_to_recordset call.
        _total := 0;
        _rej_code := NULL;
        _rej_msg := NULL;
        _norm_chunks := '[]'::jsonb;
        _chunk_idx := 0;
        FOR _chunk IN SELECT value FROM jsonb_array_elements(_chunks)
        LOOP
            _addr := COALESCE(_chunk->>'address', '');
            BEGIN
                _size := COALESCE(NULLIF(_chunk->>'size_bytes', '')::bigint, 0);
            EXCEPTION WHEN invalid_text_representation THEN
                _size := -1;
            END;
            IF _addr = '' THEN
                _rej_code := 'validation';
                _rej_msg := format('file.create: chunks[%s].address is required', _chunk_idx);
                EXIT;
            END IF;
            IF _size < 0 THEN
                _rej_code := 'validation';
                _rej_msg := format('file.create: chunks[%s].size_bytes must be non-negative', _chunk_idx);
                EXIT;
            END IF;
            _total := _total + _size;
            _norm_chunks := _norm_chunks || jsonb_build_array(
                jsonb_build_object(
                    'seq', _chunk_idx,
                    'cas_address', _addr,
                    'chunk_size', _size
                )
            );
            _chunk_idx := _chunk_idx + 1;
        END LOOP;
        IF _rej_code IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false, _rej_code, _rej_msg, NULL::jsonb;
            CONTINUE;
        END IF;

        -- Single-chunk file: persist sha256 from the lone chunk's CAS
        -- address so dedup queries index a single column. Multi-chunk
        -- files leave sha256 NULL.
        IF jsonb_array_length(_chunks) = 1 THEN
            _sha := _norm_chunks->0->>'cas_address';
        ELSE
            _sha := NULL;
        END IF;

        WITH ins_file AS (
            INSERT INTO file (filename, size_bytes, mime_type, created_by, sha256)
            VALUES (_filename, _total, _mime, actor_id, _sha)
            RETURNING id
        ),
        ins_chunks AS (
            INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size)
            SELECT (SELECT id FROM ins_file), seq, cas_address, chunk_size
            FROM jsonb_to_recordset(_norm_chunks)
            AS x(seq int, cas_address text, chunk_size bigint)
            RETURNING file_id
        )
        SELECT id INTO _new_id FROM ins_file;

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

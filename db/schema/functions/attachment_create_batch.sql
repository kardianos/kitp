-- attachment.create handler (Phase 2/3 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runCreate into one PL/pgSQL body, with one
-- twist: thumbnail generation cannot move to PL/pgSQL (it needs
-- image.Decode + JPEG re-encode in Go), so the function writes the
-- attachment + activity rows with `thumb_file_id = NULL` and the
-- dispatcher's PostRun hook (see internal/dom/attachment/attachment.go
-- doThumbnails) decodes + inserts the thumb file + UPDATEs the
-- attachment row in the same request tx after the function returns.
--
-- Per-row pipeline:
--   1. Validation: card_id + file_id are required.
--   2. File lookup: filename / mime_type / size_bytes come from the
--      `file` row. Missing file -> code='not_found'.
--   3. INSERT attachment (thumb_file_id NULL) + INSERT activity row of
--      kind='attachment_create' carrying attachment_id / file_id /
--      filename in value_new.
--
-- Result JSON shape matches `attachment.CreateOutput`:
--   {"id":"<bigint>", "card_id":"<bigint>", "file_id":"<bigint>",
--    "filename":"...", "mime_type":"...", "size_bytes": <int>,
--    "thumb_file_id":"0", "kind":"image|pdf|other"}
-- The thumb_file_id is always "0" at this stage; PostRun overwrites
-- it on the Go side when a thumb is generated. bigint ids are cast to
-- text because the Go struct uses `json:",string"` for 64-bit ids.
--
-- Kind classification mirrors KindFromMime in
-- internal/dom/attachment/thumb.go — the lookup is case-insensitive
-- and trims whitespace so callers sending `IMAGE/PNG` still bucket as
-- image.
CREATE OR REPLACE FUNCTION attachment_create_batch(
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
    _card_id bigint;
    _file_id bigint;
    _filename text;
    _mime text;
    _size bigint;
    _kind text;
    _new_id bigint;
BEGIN
    FOR _idx, _row IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _card_id := NULLIF(_row->>'card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _card_id := NULL;
        END;
        BEGIN
            _file_id := NULLIF(_row->>'file_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _file_id := NULL;
        END;

        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attachment.create: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _file_id IS NULL OR _file_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attachment.create: file_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- Pull the source file's metadata up front. The activity payload
        -- + response carry the filename / mime / size; missing file is
        -- a per-row 'not_found' (same surface as the legacy Go body).
        SELECT f.filename, f.mime_type, f.size_bytes
        INTO _filename, _mime, _size
        FROM file f
        WHERE f.id = _file_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                format('attachment.create: file %s not found', _file_id)::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- INSERT attachment with thumb_file_id NULL — PostRun fills it
        -- in Go-side after image decode (see attachment.go doThumbnails).
        -- Activity row reuses the new attachment id via the CTE.
        WITH ins_attach AS (
            INSERT INTO attachment (card_id, file_id, thumb_file_id)
            VALUES (_card_id, _file_id, NULL)
            RETURNING id, card_id, file_id
        ),
        ins_act AS (
            INSERT INTO activity (card_id, kind, value_new, actor_id)
            SELECT a.card_id, 'attachment_create',
                   jsonb_build_object(
                       'attachment_id', a.id,
                       'file_id', a.file_id,
                       'filename', _filename
                   ),
                   actor_id
            FROM ins_attach a
            RETURNING id
        )
        SELECT id INTO _new_id FROM ins_attach;

        -- Classify mime → kind (image | pdf | other). Lowercase + trim
        -- to match KindFromMime's behaviour for the Go-side read path.
        _kind := CASE lower(btrim(_mime))
            WHEN 'image/png' THEN 'image'
            WHEN 'image/jpeg' THEN 'image'
            WHEN 'image/jpg' THEN 'image'
            WHEN 'image/gif' THEN 'image'
            WHEN 'image/webp' THEN 'image'
            WHEN 'application/pdf' THEN 'pdf'
            ELSE 'other'
        END;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'id', _new_id::text,
                'card_id', _card_id::text,
                'file_id', _file_id::text,
                'filename', _filename,
                'mime_type', _mime,
                'size_bytes', _size,
                'thumb_file_id', '0',
                'kind', _kind
            );
    END LOOP;
END;
$$;

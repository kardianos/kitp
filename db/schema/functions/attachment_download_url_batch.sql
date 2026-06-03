-- attachment.download_url handler.
--
-- Mints the per-attachment metadata the dispatcher's PostRun hook
-- (signDownloadURLs) needs to build a time-limited, HMAC-signed
-- download link. The URL + expires_at are filled in Go-side AFTER this
-- function returns — the signing secret lives in the process, not the
-- DB — so this body only validates the request and resolves the file
-- metadata for the requested mode.
--
-- Per-row pipeline:
--   1. Validation: id is required; mode defaults to 'download' and must
--      be one of download | view | thumb.
--   2. Resolve the source `file` row for the mode: thumb -> the
--      attachment's thumb_file_id, otherwise file_id. A missing /
--      soft-deleted attachment, or a thumb request against an
--      attachment with no thumbnail, surfaces 'not_found'.
--   3. Return {id, mode, filename, mime_type, size_bytes}. PostRun
--      appends 'url' and 'expires_at'.
--
-- Authz is NOT enforced here. attachment.download_url is registered
-- with AllowedRoles worker/manager/admin + ProcessName card.update and
-- a CardTypeID/ScopeCardID resolver pair (cardTypeFromDownloadURLInput
-- / scopeCardFromDownloadURLInput), so the dispatcher's pre-tx scope
-- pass runs the same card.update-on-project gate requireAttachmentAccess
-- applies to the streaming routes — see DI-5 / DI-6. The signature the
-- PostRun mints then becomes the capability the public /dl route trusts.
CREATE OR REPLACE FUNCTION attachment_download_url_batch(
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
    _id bigint;
    _mode text;
    _filename text;
    _mime text;
    _size bigint;
BEGIN
    FOR _idx, _id, _mode IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'id', '')::bigint,
               COALESCE(NULLIF(r.value->>'mode', ''), 'download')
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _id IS NULL OR _id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attachment.download_url: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _mode NOT IN ('download', 'view', 'thumb') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attachment.download_url: mode must be download, view, or thumb'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        IF _mode = 'thumb' THEN
            SELECT f.filename, f.mime_type, f.size_bytes
            INTO _filename, _mime, _size
            FROM attachment a
            JOIN file f ON f.id = a.thumb_file_id
            WHERE a.id = _id AND a.deleted_at IS NULL;
        ELSE
            SELECT f.filename, f.mime_type, f.size_bytes
            INTO _filename, _mime, _size
            FROM attachment a
            JOIN file f ON f.id = a.file_id
            WHERE a.id = _id AND a.deleted_at IS NULL;
        END IF;

        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                'attachment.download_url: attachment not found, deleted, or has no thumbnail'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'id',         _id::text,
                'mode',       _mode,
                'filename',   _filename,
                'mime_type',  _mime,
                'size_bytes', _size
            );
    END LOOP;
END;
$$;

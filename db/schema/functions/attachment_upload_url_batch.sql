-- attachment.upload_url handler.
--
-- Validates a request for a time-limited, HMAC-signed one-shot upload
-- link. The URL + expires_at are filled in Go-side by the dispatcher's
-- PostRun hook (signUploadURLs) AFTER this function returns — the
-- signing secret lives in the process, not the DB — so this body only
-- validates the request and echoes the normalised values the link will
-- bind.
--
-- Per-row pipeline:
--   1. Validation: card_id + filename are required; filename must carry
--      an extension (the same cheap gate file.create applies — checked
--      here so the agent learns of a bad name BEFORE it streams bytes).
--      mime_type defaults to application/octet-stream.
--   2. The target card must exist and not be soft-deleted
--      ('not_found' otherwise).
--   3. Return {card_id, filename, mime_type}. PostRun appends 'url' and
--      'expires_at'.
--
-- Authz is NOT enforced here. attachment.upload_url is registered with
-- AllowedRoles worker/manager/admin + ProcessName card.update and a
-- CardTypeID resolver, so the dispatcher's pre-tx scope pass runs the
-- same card.update-on-project gate attachment.create applies — see
-- DI-5 / DI-6. The public upload route re-dispatches file.create +
-- attachment.create as the signed actor, so that gate runs again when
-- the bytes land.
CREATE OR REPLACE FUNCTION attachment_upload_url_batch(
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
    _filename text;
    _mime text;
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
        _filename := COALESCE(_row->>'filename', '');
        _mime := COALESCE(NULLIF(_row->>'mime_type', ''), 'application/octet-stream');

        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attachment.upload_url: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _filename = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attachment.upload_url: filename is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF position('.' IN _filename) = 0
           OR _filename ~ '^\.'
           OR _filename ~ '\.$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attachment.upload_url: filename must have an extension'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        PERFORM 1 FROM card c WHERE c.id = _card_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                'attachment.upload_url: card not found or deleted'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'card_id',   _card_id::text,
                'filename',  _filename,
                'mime_type', _mime
            );
    END LOOP;
END;
$$;

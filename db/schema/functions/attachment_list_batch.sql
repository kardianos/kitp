-- attachment.list handler (Phase 5 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runList into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: card_id is required.
--   2. Aggregate joined attachment + file rows for the card (active
--      attachments only, newest first) into a single jsonb array.
--      Result shape mirrors attachment.ListOutput: {"rows": [{...}, ...]}.
--
-- Notes:
--   - thumb_file_id is emitted as a string (the Go OutputType tags it
--     `,string`); a NULL DB value collapses to "0" to match the
--     pre-migration Go COALESCE.
--   - The 'kind' display bucket is derived inline from mime_type
--     (image/* → image, application/pdf → pdf, anything else → other).
--     KindFromMime in Go applies the same rule. Keeping it in SQL
--     avoids a per-row callback into Go.
--   - No visibility filter: the attachment's owning card is treated as
--     the canonical visibility unit by the pre-tx authz pass (the
--     attachment.list handler is RoleAuthenticated; callers are
--     expected to fold their own card-visibility check up front).
--     Mirrors the pre-migration Go body.
CREATE OR REPLACE FUNCTION attachment_list_batch(
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
    _card_id bigint;
BEGIN
    FOR _idx, _card_id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'card_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attachment.list: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id',            a.id::text,
                        'card_id',       a.card_id::text,
                        'file_id',       a.file_id::text,
                        'filename',      f.filename,
                        'mime_type',     f.mime_type,
                        'size_bytes',    f.size_bytes,
                        'created_at',    to_char(a.created_at AT TIME ZONE 'UTC',
                                                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                        'thumb_file_id', COALESCE(a.thumb_file_id, 0)::text,
                        'kind',          CASE
                                             WHEN f.mime_type LIKE 'image/%' THEN 'image'
                                             WHEN f.mime_type = 'application/pdf' THEN 'pdf'
                                             ELSE 'other'
                                         END
                    ) ORDER BY a.id DESC
                )
                FROM attachment a
                JOIN file f ON f.id = a.file_id
                WHERE a.card_id = _card_id AND a.deleted_at IS NULL
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

-- attachment.delete handler (Phase 2 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runDelete into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: id is required.
--   2. Existence + already-deleted guard: the attachment must exist
--      and not already be soft-deleted. The original Go path
--      conflated these two cases under one 'not_found' code (since
--      the UPDATE filtered on `deleted_at IS NULL`); we preserve
--      that surface — both cases emit 'not_found' so existing
--      callers (and the integration test in attachment_test.go) keep
--      working unchanged.
--   3. Soft delete: SET deleted_at = now(), write a matching
--      activity row of kind='attachment_delete' carrying the
--      attachment_id / file_id / filename in value_old.
--
-- Result JSON shape matches `attachment.DeleteOutput`:
--   {"ok": true}
-- No bigint ids appear on the output side; nothing to cast.
CREATE OR REPLACE FUNCTION attachment_delete_batch(
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
    _exists boolean;
    _already_deleted boolean;
    _ignored bigint;
BEGIN
    FOR _idx, _id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _id IS NULL OR _id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'attachment.delete: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT true, (a.deleted_at IS NOT NULL)
        INTO _exists, _already_deleted
        FROM attachment a
        WHERE a.id = _id;
        IF NOT FOUND OR _already_deleted THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                'attachment.delete: attachment not found or already deleted'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;
        WITH upd AS (
            UPDATE attachment a
            SET deleted_at = now()
            FROM file f
            WHERE a.id = _id AND a.deleted_at IS NULL AND f.id = a.file_id
            RETURNING a.id, a.card_id, a.file_id, f.filename
        ),
        ins_act AS (
            INSERT INTO activity (card_id, kind, value_old, actor_id)
            SELECT card_id, 'attachment_delete',
                   jsonb_build_object(
                       'attachment_id', id,
                       'file_id', file_id,
                       'filename', filename
                   ),
                   actor_id
            FROM upd
            RETURNING id
        )
        SELECT id INTO _ignored FROM upd;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('ok', true);
    END LOOP;
END;
$$;

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
--   3. Grant: card.update on the attachment's card, in its project, as the
--      dispatcher's gate does — checked here too, because the gate runs
--      before the request transaction and an attachment id that has no
--      row then (the next one in the sequence) gives it no card to check
--      (review 2026-11-06 round 8 #4). Someone else's private card and a
--      card in an off area are refused the same way.
--   4. Soft delete: SET deleted_at = now(), write a matching
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
    _card bigint;
    _type text;
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
        SELECT true, (a.deleted_at IS NOT NULL), a.card_id, ct.name
        INTO _exists, _already_deleted, _card, _type
        FROM attachment a
        JOIN card c ON c.id = a.card_id
        JOIN card_type ct ON ct.id = c.card_type_id
        WHERE a.id = _id;
        IF NOT FOUND OR _already_deleted THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                'attachment.delete: attachment not found or already deleted'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT user_has_grant(attachment_delete_batch.actor_id, _type, 'card.update', card_enclosing_project(_card))
           OR NOT card_private_ok(_card, attachment_delete_batch.actor_id)
           OR card_in_off_area(_card) THEN
            RETURN QUERY SELECT _idx, false, 'unauthorized'::text,
                'attachment.delete: you may not change that card'::text, NULL::jsonb;
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
        -- A portal publishing the attachment's page rebuilds without it,
        -- so the file stops being served and its blob can be reaped
        -- (review 2026-11-03 #17; serve.go also refuses it at once).
        PERFORM portal_mark_dirty(p.portal_id)
        FROM publication p
        WHERE p.card_id = (SELECT a.card_id FROM attachment a WHERE a.id = _id);
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('ok', true);
    END LOOP;
END;
$$;

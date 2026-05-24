-- comment.insert handler (Phase 1 of UNIFIED_HANDLER_PLAN.md).
--
-- Validates + executes per row. Per-row failures return ok=false
-- rows rather than RAISE so the dispatcher can attribute the error
-- to the right InputIndex; sibling rows in the batch still emit
-- their own (ok=true, result) rows even when one fails (the
-- dispatcher's first-error semantics still abort the batch tx
-- afterwards — but the per-row data lets it pinpoint the offender).
--
-- Result JSON shape matches `comment.InsertOutput`:
--   {"ok": true, "activity_id": "123", "comment_body_id": "456"}
-- The bigint ids are cast to text because the Go-side struct uses
-- `json:",string"` tags (the dispatcher's wire convention for
-- 64-bit ids).
CREATE OR REPLACE FUNCTION comment_insert_batch(
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
    _body text;
    _new_body_id bigint;
    _new_act_id bigint;
BEGIN
    FOR _idx, _card_id, _body IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'card_id', '')::bigint,
               r.value->>'body'
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comment.insert: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _body IS NULL OR _body = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comment.insert: body is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM card WHERE id = _card_id) THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('comment.insert: card %s not found', _card_id), NULL::jsonb;
            CONTINUE;
        END IF;
        INSERT INTO comment_body (body) VALUES (_body) RETURNING id INTO _new_body_id;
        INSERT INTO activity (card_id, kind, value_new, actor_id)
        VALUES (_card_id, 'comment',
                jsonb_build_object('comment_body_id', _new_body_id),
                actor_id)
        RETURNING id INTO _new_act_id;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'activity_id', _new_act_id::text,
                'comment_body_id', _new_body_id::text
            );
    END LOOP;
END;
$$;

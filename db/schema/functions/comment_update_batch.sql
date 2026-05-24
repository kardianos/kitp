-- comment.update handler (Phase 2 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side validateUpdate + runUpdate into one
-- PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: activity_id and body are required.
--   2. Lookup: the target activity must exist and have kind='comment';
--      resolve its linked comment_body_id and the original author.
--   3. Authorization: the actor must be the original comment author.
--      Admin escape is intentionally NOT implemented — matches the
--      strict actor == origActor check in the prior Go runUpdate.
--      Admins who need to edit a foreign comment do so via direct SQL
--      (or a future admin-scoped override).
--   4. Apply: update the comment_body row in place; insert a new
--      activity row of kind='comment_edit' whose value_new carries the
--      target activity_id (as text) + the new body so the activity
--      stream can render an inline change line.
--
-- Result JSON shape matches `comment.UpdateOutput`:
--   {"ok": true, "edit_activity_id": "123"}
-- The 64-bit id is cast to text because the Go struct uses
-- `json:",string"` tags (the dispatcher's wire convention).
CREATE OR REPLACE FUNCTION comment_update_batch(
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
    _activity_id bigint;
    _body text;
    _body_id bigint;
    _orig_actor bigint;
    _kind text;
    _edit_id bigint;
BEGIN
    FOR _idx, _activity_id, _body IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'activity_id', '')::bigint,
               r.value->>'body'
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _activity_id IS NULL OR _activity_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comment.update: activity_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _body IS NULL OR _body = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'comment.update: body is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        SELECT a.kind,
               NULLIF(a.value_new->>'comment_body_id', '')::bigint,
               a.actor_id
        INTO _kind, _body_id, _orig_actor
        FROM activity a
        WHERE a.id = _activity_id;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text,
                format('comment.update: activity %s not found', _activity_id),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _kind <> 'comment' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('comment.update: activity %s is kind=%L, not ''comment''',
                       _activity_id, _kind),
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _orig_actor <> actor_id THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                format('comment.update: actor %s cannot edit comment authored by %s',
                       actor_id, _orig_actor),
                NULL::jsonb;
            CONTINUE;
        END IF;
        UPDATE comment_body SET body = _body WHERE id = _body_id;
        -- Insert the audit row. Source the card_id from the target
        -- activity; the new row's actor is the caller (`actor_id`
        -- function parameter). Aliasing the SELECT target as `a`
        -- disambiguates from the inserted column `actor_id`.
        INSERT INTO activity (card_id, kind, value_new, actor_id)
        SELECT a.card_id, 'comment_edit',
               jsonb_build_object(
                   'activity_id', _activity_id::text,
                   'new_body', _body
               ),
               comment_update_batch.actor_id
        FROM activity a WHERE a.id = _activity_id
        RETURNING id INTO _edit_id;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'edit_activity_id', _edit_id::text
            );
    END LOOP;
END;
$$;

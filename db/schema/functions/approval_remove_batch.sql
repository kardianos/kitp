-- approval.remove handler — withdraw an approval request from its task.
--
-- Soft-deletes the approval card and writes a card_delete activity row (the
-- removal's audit record). Decisions people already gave are
-- approval_decision rows on the task, so they stay in its history.
--
-- Authz: the dispatcher gates on card.update of the request's parent task
-- (like link.delete), so anyone who can edit the task can remove one.
--
-- Result JSON shape matches `approval.RemoveOutput`: {"removed": true}
CREATE OR REPLACE FUNCTION approval_remove_batch(
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
    _raw jsonb;
    _id bigint;
    _ct_name text;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _id := COALESCE(NULLIF(_raw->>'id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _id := 0;
        END;
        IF _id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.remove: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT ct.name INTO _ct_name
          FROM card c JOIN card_type ct ON ct.id = c.card_type_id
          WHERE c.id = _id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'approval_not_found'::text,
                format('approval.remove: approval %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ct_name <> 'approval' THEN
            RETURN QUERY SELECT _idx, false, 'wrong_card_type'::text,
                format('approval.remove: card %s is %L, not an approval', _id, _ct_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        UPDATE card SET deleted_at = now() WHERE id = _id AND deleted_at IS NULL;
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_id, 'card_delete', approval_remove_batch.actor_id);

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('removed', true);
    END LOOP;
END;
$$;

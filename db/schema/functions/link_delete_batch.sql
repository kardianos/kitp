-- link.delete handler — remove one link from its task: soft-delete the
-- link card + a card_delete activity row.
--
-- Authz: the dispatcher gates on card.update of the link's PARENT TASK
-- (the same gate link.set uses), so anyone who can edit the task can
-- unlink. Deleting is not sticky: a later link.set of the same URL (a
-- forge reporting the change again) creates a fresh link.
--
-- Result JSON shape matches `link.DeleteOutput`:
--   {"deleted": true}
CREATE OR REPLACE FUNCTION link_delete_batch(
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
                'link.delete: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT ct.name INTO _ct_name
          FROM card c JOIN card_type ct ON ct.id = c.card_type_id
          WHERE c.id = _id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'link_not_found'::text,
                format('link.delete: link %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _ct_name <> 'link' THEN
            RETURN QUERY SELECT _idx, false, 'wrong_card_type'::text,
                format('link.delete: card %s is %L, not a link', _id, _ct_name),
                NULL::jsonb;
            CONTINUE;
        END IF;

        UPDATE card SET deleted_at = now() WHERE id = _id AND deleted_at IS NULL;
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_id, 'card_delete', link_delete_batch.actor_id);

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('deleted', true);
    END LOOP;
END;
$$;

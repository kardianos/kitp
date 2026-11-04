-- my_screen.delete — delete one of the caller's personal screens and its
-- views (docs/PERSONAL_SCREENS.md): soft-delete each with a card_delete
-- activity row. The tasks and threads it listed are untouched.
CREATE OR REPLACE FUNCTION my_screen_delete_batch(
    actor_id bigint,
    inputs jsonb
) RETURNS TABLE (idx int, ok boolean, code text, message text, result jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    _idx int;
    _raw jsonb;
    _id bigint;
    _person bigint := account_person(my_screen_delete_batch.actor_id);
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF COALESCE(_raw->>'id', '') !~ '^\d+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text, 'my_screen.delete: id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        _id := (_raw->>'id')::bigint;
        IF _person IS NULL OR NOT EXISTS (
            SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'screen'
            WHERE c.id = _id AND c.parent_card_id IS NULL AND c.private_to = _person AND c.deleted_at IS NULL) THEN
            RETURN QUERY SELECT _idx, false, 'not_found'::text, format('my_screen.delete: screen %s not found', _id), NULL::jsonb;
            CONTINUE;
        END IF;
        WITH gone AS (
            UPDATE card SET deleted_at = now()
            WHERE (id = _id OR parent_card_id = _id) AND deleted_at IS NULL
            RETURNING id
        )
        INSERT INTO activity (card_id, kind, actor_id)
        SELECT g.id, 'card_delete', my_screen_delete_batch.actor_id FROM gone g;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, jsonb_build_object('id', _id::text);
    END LOOP;
END;
$$;

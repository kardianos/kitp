-- approval_fields — one approval request's fields in a single row: the
-- edge (from_id → to_id), the action label, the people asked (the
-- approvers card_ref[] value) and the note. Each cast is guarded by its
-- attribute's name inside a CASE, so it is never applied to another
-- attribute's value whatever plan the caller's query gets (a bare
-- `value::bigint` in a join can be evaluated before the attribute filter).
CREATE OR REPLACE FUNCTION approval_fields(p_id bigint)
RETURNS TABLE (from_id bigint, to_id bigint, action text, approvers jsonb, note text)
LANGUAGE sql STABLE AS $$
    SELECT
        max(CASE WHEN ad.name = 'approval_from' AND jsonb_typeof(av.value) = 'number'
                 THEN (av.value)::text::bigint END),
        max(CASE WHEN ad.name = 'approval_to' AND jsonb_typeof(av.value) = 'number'
                 THEN (av.value)::text::bigint END),
        max(CASE WHEN ad.name = 'approval_action' THEN av.value #>> '{}' END),
        (array_agg(av.value) FILTER (WHERE ad.name = 'approvers'))[1],
        COALESCE(max(CASE WHEN ad.name = 'approval_note' THEN av.value #>> '{}' END), '')
    FROM attribute_value av
    JOIN attribute_def ad ON ad.id = av.attribute_def_id
    WHERE av.card_id = p_id
$$;

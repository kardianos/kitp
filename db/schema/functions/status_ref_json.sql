-- status_ref_json — a status value-card as the approval reads ship it:
-- {"id", "label", "phase"}; NULL for a NULL id.
CREATE OR REPLACE FUNCTION status_ref_json(p_id bigint)
RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('id', c.id::text, 'label', COALESCE(card_label(c.id), ''), 'phase', c.phase)
    FROM card c
    WHERE c.id = p_id
$$;

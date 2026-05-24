-- Helper for attribute.update's flow-rejection envelope (V13 of
-- docs/FLOW_AND_SCREEN_KERNEL.md). Given the actor + a target card +
-- its enclosing project, returns the JSONB array shape the Go-side
-- flowAvailableTo / flowRejectionDetail structs serialise to:
--
--   [{ "step_id": "<id>",
--      "to": {"id":"<id>", "label":"…", "phase":"triage|active|terminal"},
--      "label": "<button>",
--      "your_role_allows": <bool>,
--      "requires_role": "<role>" | null }, …]
--
-- Mirrors flow.listAvailableTransitions semantics: every flow_step
-- whose from_card_id equals the card's current value on a flow-bound
-- attribute, sorted by attribute_def name then step sort_order/label/id
-- for determinism. The `your_role_allows` bit applies the same
-- system-bypass + project-or-global scope check as Gate 4.
CREATE OR REPLACE FUNCTION build_flow_available_array(
    p_actor_id bigint,
    p_card_id bigint,
    p_project_id bigint
) RETURNS jsonb LANGUAGE sql AS $$
    SELECT COALESCE(jsonb_agg(row ORDER BY ord_ad, ord_sort, ord_label, ord_id), '[]'::jsonb)
    FROM (
        SELECT
            jsonb_build_object(
                'step_id', fs.id::text,
                'to', jsonb_build_object(
                    'id', fs.to_card_id::text,
                    'label', COALESCE(av_to_title.value #>> '{}', ''),
                    'phase', tc.phase),
                'label', fs.label,
                'your_role_allows', (
                    fs.requires_role_id IS NULL
                    OR EXISTS (
                        SELECT 1 FROM user_role ur
                        JOIN role sr ON sr.id = ur.role_id
                        WHERE ur.user_id = p_actor_id AND sr.name = 'system'
                          AND ur.scope_card_id IS NULL
                    )
                    OR EXISTS (
                        SELECT 1 FROM user_role ur
                        WHERE ur.user_id = p_actor_id
                          AND ur.role_id = fs.requires_role_id
                          AND (ur.scope_card_id IS NULL OR ur.scope_card_id = p_project_id)
                    )
                ),
                'requires_role', CASE WHEN fs.requires_role_id IS NULL THEN NULL ELSE r.name END
            ) AS row,
            ad.name AS ord_ad,
            fs.sort_order AS ord_sort,
            fs.label AS ord_label,
            fs.id AS ord_id
        FROM flow f
        JOIN attribute_def ad ON ad.id = f.attribute_def_id
        JOIN attribute_value av
          ON av.card_id = p_card_id
         AND av.attribute_def_id = f.attribute_def_id
         AND jsonb_typeof(av.value) = 'number'
        JOIN flow_step fs
          ON fs.flow_id = f.id
         AND fs.from_card_id = (av.value)::text::bigint
        JOIN card tc ON tc.id = fs.to_card_id AND tc.deleted_at IS NULL
        LEFT JOIN role r ON r.id = fs.requires_role_id
        LEFT JOIN attribute_def ad_title ON ad_title.name = 'title'
        LEFT JOIN attribute_value av_to_title
          ON av_to_title.card_id = fs.to_card_id
         AND av_to_title.attribute_def_id = ad_title.id
        WHERE f.scope_card_id = p_project_id
    ) ranked
$$;

-- card_ref_cross_project — check whether a card's STORED card_ref /
-- card_ref[] attribute values would cross a project boundary if the
-- card sat under `target_project` (A11 / BE-M5).
--
-- Returns the first offending (attr_name, value_card_id, value_project)
-- triple, or no rows when every project-scoped card_ref the card holds
-- points into `target_project` (global value-cards — those with no
-- enclosing project — are wildcards and never offend). card.move uses
-- it to re-validate the cross-project invariant after a re-parent that
-- changes the card's enclosing project: card.insert / attribute.update
-- enforce the same invariant at write time, but a plain re-parent used
-- to skip it, letting a moved card keep refs into its old project.
--
-- Both the card's and each value's enclosing project resolve through
-- the shared capped card_enclosing_project helper, so the depth cap and
-- the "card → project" rule live in exactly one place (A1 / A10).
--
-- `target_project` is the enclosing project the card would have after
-- the move (NULL = the card would be global / project-less; any
-- project-scoped ref then offends, since a global card can't legitimately
-- reference a project-scoped value).
CREATE OR REPLACE FUNCTION card_ref_cross_project(
    card_id bigint,
    target_project bigint
) RETURNS TABLE (
    attr_name text,
    value_card_id bigint,
    value_project bigint
) LANGUAGE sql STABLE AS $$
    WITH refs AS (
        -- Every card_ref / card_ref[] value the card currently holds,
        -- flattened to one row per referenced value-card id.
        SELECT ad.name AS attr_name,
               CASE
                   WHEN ad.value_type = 'card_ref'
                        AND jsonb_typeof(av.value) = 'number'
                       THEN (av.value)::text::bigint
                   WHEN ad.value_type = 'card_ref'
                        AND jsonb_typeof(av.value) = 'string'
                        AND (av.value #>> '{}') ~ '^-?\d+$'
                       THEN (av.value #>> '{}')::bigint
               END AS vid
        FROM attribute_value av
        JOIN attribute_def ad ON ad.id = av.attribute_def_id
        WHERE av.card_id = card_ref_cross_project.card_id
          AND ad.value_type = 'card_ref'
        UNION ALL
        SELECT ad.name AS attr_name,
               CASE
                   WHEN jsonb_typeof(el.v) = 'number' THEN (el.v)::text::bigint
                   WHEN jsonb_typeof(el.v) = 'string'
                        AND (el.v #>> '{}') ~ '^-?\d+$' THEN (el.v #>> '{}')::bigint
               END AS vid
        FROM attribute_value av
        JOIN attribute_def ad ON ad.id = av.attribute_def_id
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(av.value) = 'array' THEN av.value ELSE '[]'::jsonb END
        ) AS el(v)
        WHERE av.card_id = card_ref_cross_project.card_id
          AND ad.value_type = 'card_ref[]'
    )
    SELECT refs.attr_name, refs.vid, card_enclosing_project(refs.vid)
    FROM refs
    WHERE refs.vid IS NOT NULL
      AND refs.vid <> 0
      -- Global value-cards (no enclosing project) are wildcards.
      AND card_enclosing_project(refs.vid) IS NOT NULL
      AND (target_project IS NULL OR card_enclosing_project(refs.vid) <> target_project)
    ORDER BY refs.attr_name, refs.vid
    LIMIT 1
$$;

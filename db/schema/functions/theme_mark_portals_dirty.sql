-- theme_mark_portals_dirty — a theme's settings or files changed: flag
-- every live portal that uses it for the portal.build job.
CREATE OR REPLACE FUNCTION theme_mark_portals_dirty(theme_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    _portal bigint;
BEGIN
    FOR _portal IN
        SELECT p.id
        FROM card p
        JOIN card_type ct ON ct.id = p.card_type_id AND ct.name = 'portal'
        JOIN attribute_value av ON av.card_id = p.id
        JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'portal_theme'
        WHERE p.deleted_at IS NULL
          AND (av.value = to_jsonb(theme_mark_portals_dirty.theme_id)
               OR av.value = to_jsonb(theme_mark_portals_dirty.theme_id::text))
    LOOP
        PERFORM portal_mark_dirty(_portal);
    END LOOP;
END;
$$;

-- portal.root_pages handler — the pages a portal may use as its root, for
-- the Portals screen's root-page picker.
--
-- Every live page in a live project that ISN'T a template. Feature-bundle
-- source projects are templates, so their starter pages (a "Home" in every
-- bundle that ships one) never appear. Each page is labelled with its
-- project and page path — "Docs › Home › Guide" — because most projects
-- carry a page called Home.
--
-- Input:  {}
-- Result: {"rows": [{"id": "<page id>", "label": "Project › Page › …",
--                    "project_id": "<id>"}, …]} ordered by label.
--
-- Visibility (DI-6): only pages in projects the caller can see.
CREATE OR REPLACE FUNCTION portal_root_pages_batch(
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
    _title_def bigint;
    _template_def bigint;
BEGIN
    SELECT id INTO _title_def FROM attribute_def WHERE name = 'title';
    SELECT id INTO _template_def FROM attribute_def WHERE name = 'is_template';

    FOR _idx IN
        SELECT (r.ord - 1)::int
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        RETURN QUERY
        WITH RECURSIVE tree AS (
            -- A project's top-level pages.
            SELECT pg.id AS page_id,
                   proj.id AS project_id,
                   COALESCE(pt.value #>> '{}', '?') || ' › ' || COALESCE(gt.value #>> '{}', '?') AS label,
                   1 AS depth
            FROM card proj
            JOIN card_type pct ON pct.id = proj.card_type_id AND pct.name = 'project'
            JOIN card pg ON pg.parent_card_id = proj.id AND pg.deleted_at IS NULL
            JOIN card_type gct ON gct.id = pg.card_type_id AND gct.name = 'page'
            LEFT JOIN attribute_value pt ON pt.card_id = proj.id AND pt.attribute_def_id = _title_def
            LEFT JOIN attribute_value gt ON gt.card_id = pg.id AND gt.attribute_def_id = _title_def
            WHERE proj.deleted_at IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM attribute_value tv
                  WHERE tv.card_id = proj.id AND tv.attribute_def_id = _template_def
                    AND tv.value = to_jsonb(true))
              AND card_visible_to(portal_root_pages_batch.actor_id, proj.id)
            UNION ALL
            -- Their sub-pages, any depth (within the cap).
            SELECT c.id, t.project_id,
                   t.label || ' › ' || COALESCE(ctt.value #>> '{}', '?'),
                   t.depth + 1
            FROM tree t
            JOIN card c ON c.parent_card_id = t.page_id AND c.deleted_at IS NULL
            JOIN card_type cct ON cct.id = c.card_type_id AND cct.name = 'page'
            LEFT JOIN attribute_value ctt ON ctt.card_id = c.id AND ctt.attribute_def_id = _title_def
            WHERE t.depth < 16
        )
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'id', tree.page_id::text,
                           'label', tree.label,
                           'project_id', tree.project_id::text)
                       ORDER BY lower(tree.label), tree.page_id)
                FROM tree
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

-- 0005_more_seed.sql — Phase 14/15 demo seed data.
--
-- Creates a 'Default Project' to host milestones, components, and tags
-- so the UI demos against a populated DB out of the box. We mirror the
-- card.insert runtime path: card row + card_create activity + attr_update
-- activity per attribute + attribute_value upsert. The migration is
-- idempotent on a clean migration runner cycle (each migration runs once);
-- the NOT EXISTS guards make a manual re-run safe.
--
-- All rows are owned by the System User (id=1).

-- ---------------------------------------------------------------
-- Default Project
-- ---------------------------------------------------------------
WITH proj_ins AS (
    INSERT INTO card (card_type_id, parent_card_id)
    SELECT ct.id, NULL FROM card_type ct
    WHERE ct.name = 'project'
      AND NOT EXISTS (
          SELECT 1
          FROM card c
          JOIN attribute_value av ON av.card_id = c.id
          JOIN attribute_def ad ON ad.id = av.attribute_def_id
          WHERE c.card_type_id = ct.id
            AND ad.name = 'title'
            AND av.value = '"Default Project"'::jsonb
      )
    RETURNING id
),
proj_create AS (
    INSERT INTO activity (card_id, kind, actor_id)
    SELECT id, 'card_create', 1 FROM proj_ins
    RETURNING id, card_id
),
proj_attr_act AS (
    INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
    SELECT pc.card_id, 'attr_update', (SELECT id FROM attribute_def WHERE name='title'),
           NULL, '"Default Project"'::jsonb, 1
    FROM proj_create pc
    RETURNING id, card_id, attribute_def_id, value_new
),
proj_attr_upsert AS (
    INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
    SELECT card_id, attribute_def_id, value_new, id FROM proj_attr_act
    ON CONFLICT (card_id, attribute_def_id) DO UPDATE
        SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id
    RETURNING card_id
)
SELECT count(*) FROM proj_attr_upsert;

-- ---------------------------------------------------------------
-- Helper: child cards of Default Project (milestones, components, tags)
-- We use a single-shot pattern per row so the migration stays readable
-- and uses regular SQL syntax.
-- ---------------------------------------------------------------

-- Note for the reader: `default_project()` resolves the Default Project's
-- card id at execution time. Wrapping in CTEs would be cleaner but pgx
-- runs migrations as one statement batch — keep the patterns explicit.

-- ---------------------------------------------------------------
-- Milestones (M1, M2, M3) under Default Project
-- ---------------------------------------------------------------
DO $$
DECLARE
    proj_id   bigint;
    ct_id     int;
    title_ad  int;
    cid       bigint;
    aid       bigint;
    title     text;
    titles    text[] := ARRAY['M1','M2','M3'];
BEGIN
    SELECT c.id INTO proj_id
    FROM card c
    JOIN card_type ct ON ct.id = c.card_type_id
    JOIN attribute_value av ON av.card_id = c.id
    JOIN attribute_def ad ON ad.id = av.attribute_def_id
    WHERE ct.name='project' AND ad.name='title' AND av.value='"Default Project"'::jsonb
    ORDER BY c.id LIMIT 1;

    SELECT id INTO ct_id FROM card_type WHERE name='milestone';
    SELECT id INTO title_ad FROM attribute_def WHERE name='title';

    FOREACH title IN ARRAY titles LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM card c
            JOIN attribute_value av ON av.card_id = c.id
            WHERE c.card_type_id = ct_id
              AND c.parent_card_id = proj_id
              AND av.attribute_def_id = title_ad
              AND av.value = to_jsonb(title)
        ) THEN
            INSERT INTO card (card_type_id, parent_card_id) VALUES (ct_id, proj_id) RETURNING id INTO cid;
            INSERT INTO activity (card_id, kind, actor_id) VALUES (cid, 'card_create', 1);
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                VALUES (cid, 'attr_update', title_ad, NULL, to_jsonb(title), 1) RETURNING id INTO aid;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                VALUES (cid, title_ad, to_jsonb(title), aid)
                ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                    SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
        END IF;
    END LOOP;
END $$;

-- ---------------------------------------------------------------
-- Components (Frontend, Backend, DB, Auth, UI) under Default Project
-- ---------------------------------------------------------------
DO $$
DECLARE
    proj_id   bigint;
    ct_id     int;
    title_ad  int;
    cid       bigint;
    aid       bigint;
    title     text;
    titles    text[] := ARRAY['Frontend','Backend','DB','Auth','UI'];
BEGIN
    SELECT c.id INTO proj_id
    FROM card c
    JOIN card_type ct ON ct.id = c.card_type_id
    JOIN attribute_value av ON av.card_id = c.id
    JOIN attribute_def ad ON ad.id = av.attribute_def_id
    WHERE ct.name='project' AND ad.name='title' AND av.value='"Default Project"'::jsonb
    ORDER BY c.id LIMIT 1;

    SELECT id INTO ct_id FROM card_type WHERE name='component';
    SELECT id INTO title_ad FROM attribute_def WHERE name='title';

    FOREACH title IN ARRAY titles LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM card c
            JOIN attribute_value av ON av.card_id = c.id
            WHERE c.card_type_id = ct_id
              AND c.parent_card_id = proj_id
              AND av.attribute_def_id = title_ad
              AND av.value = to_jsonb(title)
        ) THEN
            INSERT INTO card (card_type_id, parent_card_id) VALUES (ct_id, proj_id) RETURNING id INTO cid;
            INSERT INTO activity (card_id, kind, actor_id) VALUES (cid, 'card_create', 1);
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                VALUES (cid, 'attr_update', title_ad, NULL, to_jsonb(title), 1) RETURNING id INTO aid;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                VALUES (cid, title_ad, to_jsonb(title), aid)
                ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                    SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
        END IF;
    END LOOP;
END $$;

-- ---------------------------------------------------------------
-- Tag cards under Default Project. Each tag gets a `path` (required) and
-- the priority/* tags get `root_exclusive_at='priority'` so applying one
-- removes any sibling priority tag (Phase 10 mutual-exclusion rule).
-- ---------------------------------------------------------------
DO $$
DECLARE
    proj_id   bigint;
    ct_id     int;
    title_ad  int;
    path_ad   int;
    root_ad   int;
    cid       bigint;
    aid       bigint;
    rec       record;
    tag_specs jsonb := '[
        {"path":"priority/high","root":"priority"},
        {"path":"priority/med", "root":"priority"},
        {"path":"priority/low", "root":"priority"},
        {"path":"area/frontend"},
        {"path":"area/backend"},
        {"path":"team/platform"},
        {"path":"team/product"},
        {"path":"team/growth"}
    ]'::jsonb;
BEGIN
    SELECT c.id INTO proj_id
    FROM card c
    JOIN card_type ct ON ct.id = c.card_type_id
    JOIN attribute_value av ON av.card_id = c.id
    JOIN attribute_def ad ON ad.id = av.attribute_def_id
    WHERE ct.name='project' AND ad.name='title' AND av.value='"Default Project"'::jsonb
    ORDER BY c.id LIMIT 1;

    SELECT id INTO ct_id    FROM card_type     WHERE name='tag';
    SELECT id INTO title_ad FROM attribute_def WHERE name='title';
    SELECT id INTO path_ad  FROM attribute_def WHERE name='path';
    SELECT id INTO root_ad  FROM attribute_def WHERE name='root_exclusive_at';

    FOR rec IN SELECT * FROM jsonb_to_recordset(tag_specs) AS x(path text, root text) LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM card c
            JOIN attribute_value av ON av.card_id = c.id
            WHERE c.card_type_id = ct_id
              AND c.parent_card_id = proj_id
              AND av.attribute_def_id = path_ad
              AND av.value = to_jsonb(rec.path)
        ) THEN
            INSERT INTO card (card_type_id, parent_card_id) VALUES (ct_id, proj_id) RETURNING id INTO cid;
            INSERT INTO activity (card_id, kind, actor_id) VALUES (cid, 'card_create', 1);

            -- title attr (uses the path as the title for readability)
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                VALUES (cid, 'attr_update', title_ad, NULL, to_jsonb(rec.path), 1) RETURNING id INTO aid;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                VALUES (cid, title_ad, to_jsonb(rec.path), aid)
                ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                    SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;

            -- path attr (required for tag)
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                VALUES (cid, 'attr_update', path_ad, NULL, to_jsonb(rec.path), 1) RETURNING id INTO aid;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                VALUES (cid, path_ad, to_jsonb(rec.path), aid)
                ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                    SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;

            -- root_exclusive_at attr (only set if non-null in the spec)
            IF rec.root IS NOT NULL THEN
                INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                    VALUES (cid, 'attr_update', root_ad, NULL, to_jsonb(rec.root), 1) RETURNING id INTO aid;
                INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                    VALUES (cid, root_ad, to_jsonb(rec.root), aid)
                    ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                        SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
            END IF;
        END IF;
    END LOOP;
END $$;

-- 0008_description_order.sql — adds two new attributes used by the polish
-- pass: a free-form `description` (text, allowed on task and project) and a
-- `sort_order` (number, allowed on task) that the kanban uses to keep
-- within-column ordering stable across reloads.
--
-- Idempotent on re-run via ON CONFLICT and explicit existence checks.

-- 1. New attribute_defs.
INSERT INTO attribute_def (name, value_type, is_built_in) VALUES
    ('description', 'text',   true),
    ('sort_order',  'number', true)
ON CONFLICT (name) DO NOTHING;

-- 2. Edges:
--    description allowed (optional) on task and project.
--    sort_order  allowed (optional) on task.
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 5
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ad.name = 'description' AND ct.name IN ('task','project')
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
SELECT ct.id, ad.id, false, 6
FROM card_type ct
CROSS JOIN attribute_def ad
WHERE ad.name = 'sort_order' AND ct.name = 'task'
ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING;

-- 3. Backfill sort_order for every existing task. Use id*100 so the spacing
--    leaves room for "between A and B" inserts without rebalancing.
DO $$
DECLARE
    sort_ad     int;
    task_ct     int;
    rec         record;
    aid         bigint;
    sort_value  jsonb;
BEGIN
    SELECT id INTO sort_ad FROM attribute_def WHERE name = 'sort_order';
    SELECT id INTO task_ct FROM card_type     WHERE name = 'task';

    FOR rec IN
        SELECT c.id
        FROM card c
        WHERE c.card_type_id = task_ct
          AND c.deleted_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM attribute_value av
              WHERE av.card_id = c.id AND av.attribute_def_id = sort_ad
          )
        ORDER BY c.id
    LOOP
        sort_value := to_jsonb(rec.id::bigint * 100);
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (rec.id, 'attr_update', sort_ad, NULL, sort_value, 1) RETURNING id INTO aid;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (rec.id, sort_ad, sort_value, aid)
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
    END LOOP;
END $$;

-- 4. Backfill descriptions for ten of the seeded tasks. Lookup by exact
--    title under the Default Project; missing rows are silently skipped.
DO $$
DECLARE
    desc_ad     int;
    title_ad    int;
    proj_id     bigint;
    task_ct     int;
    rec         record;
    cid         bigint;
    aid         bigint;
    desc_value  jsonb;
    pairs       jsonb := '[
        {"title":"Wire pickers (dense#1)",       "description":"Replace ad-hoc pickers in the dense table with the shared component."},
        {"title":"API rate limits",              "description":"Cap per-IP request rate at the gateway and return a structured 429 with retry-after."},
        {"title":"Empty state copy",             "description":"Rewrite the empty-state strings on Projects, Inbox, and Grid to match the voice guide."},
        {"title":"OIDC callback URL",            "description":"Allow the redirect URL to be configured per environment without rebuilding the client."},
        {"title":"Activity feed pagination",     "description":"Page the activity stream by activity id so older comments load on demand."},
        {"title":"Component editor refactor",    "description":"Split the component editor into a header/body pair and isolate the autosave timer."},
        {"title":"JWKS cache",                   "description":"Cache the OP’s JWKS for an hour with stale-while-revalidate on signature failures."},
        {"title":"Idempotency-Key store",        "description":"Persist responses keyed by (user, key) for 24h and replay on duplicate submission."},
        {"title":"Schema migration runner",      "description":"Tighten the migration runner: per-file transactions, lock to serialise concurrent boots."},
        {"title":"Kanban swim lane DnD",         "description":"Drag-drop across both column and lane should issue exactly one batch with two attribute writes."}
    ]'::jsonb;
BEGIN
    SELECT id INTO desc_ad  FROM attribute_def WHERE name = 'description';
    SELECT id INTO title_ad FROM attribute_def WHERE name = 'title';
    SELECT id INTO task_ct  FROM card_type     WHERE name = 'task';
    SELECT c.id INTO proj_id
    FROM card c
    JOIN attribute_value av ON av.card_id = c.id AND av.attribute_def_id = title_ad
    WHERE av.value = '"Default Project"'::jsonb
    ORDER BY c.id LIMIT 1;
    IF proj_id IS NULL THEN
        RETURN;
    END IF;

    FOR rec IN
        SELECT * FROM jsonb_to_recordset(pairs)
        AS x(title text, description text)
    LOOP
        SELECT c.id INTO cid
        FROM card c
        JOIN attribute_value av ON av.card_id = c.id AND av.attribute_def_id = title_ad
        WHERE c.parent_card_id = proj_id
          AND c.card_type_id   = task_ct
          AND av.value         = to_jsonb(rec.title)
        LIMIT 1;
        IF cid IS NULL THEN CONTINUE; END IF;

        IF EXISTS (SELECT 1 FROM attribute_value WHERE card_id = cid AND attribute_def_id = desc_ad) THEN
            CONTINUE;
        END IF;

        desc_value := to_jsonb(rec.description);
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (cid, 'attr_update', desc_ad, NULL, desc_value, 1) RETURNING id INTO aid;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (cid, desc_ad, desc_value, aid)
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
    END LOOP;
END $$;

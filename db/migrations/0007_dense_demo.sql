-- 0007_dense_demo.sql — Phase 16/17/18 demo seed data.
--
-- Inserts 25 tasks under the Default Project with a realistic spread of
-- statuses, assignees, milestones, components, and tags so the inbox,
-- grid, and kanban views render against meaningful data on a fresh DB.
--
-- Distribution (totals always = 25):
--   status:     8 todo, 6 doing, 5 review, 6 done
--   assignee:   alice 8, bob 5, carol 5, dave 4, eve 3
--   priority:   10 high, 8 med, 5 low, 2 none (priority tags are mutually
--               exclusive at the priority/ root)
--   milestone/component: spread across M1/M2/M3 + Frontend/Backend/DB/Auth/UI
--                        with some null entries
--
-- Each task emits the same activity stream the runtime would: one
-- `card_create` plus one `attr_update` per attribute, all owned by the
-- System User (id=1). This keeps the activity panel realistic for screenshots.
--
-- We resolve every id at execution time (Default Project, milestones,
-- components, tag cards, attribute_defs) so the migration is robust to
-- ordering changes from upstream migrations.

DO $$
DECLARE
    -- Container ids resolved at runtime.
    proj_id        bigint;
    task_ct        int;
    -- Attribute defs.
    title_ad       int;
    status_ad      int;
    assignee_ad    int;
    milestone_ad   int;
    component_ad   int;
    tags_ad        int;
    -- Helper card ids (milestones / components / tags).
    m1_id   bigint;
    m2_id   bigint;
    m3_id   bigint;
    fe_id   bigint;
    be_id   bigint;
    db_id   bigint;
    auth_id bigint;
    ui_id   bigint;
    pri_high_id bigint;
    pri_med_id  bigint;
    pri_low_id  bigint;
    area_fe_id  bigint;
    area_be_id  bigint;
    team_plat_id bigint;
    team_prod_id bigint;
    team_grow_id bigint;
    -- Per-iteration locals.
    cid     bigint;
    aid     bigint;
    spec    jsonb;
    rec     record;
    n_tasks int;
    -- alice/bob/carol/dave/eve user ids.
    alice_id bigint;
    bob_id   bigint;
    carol_id bigint;
    dave_id  bigint;
    eve_id   bigint;
    -- Iteration helper; tag application stores a jsonb array of tag card ids.
    tag_ids jsonb;
BEGIN
    -- Default Project.
    SELECT c.id INTO proj_id
    FROM card c
    JOIN card_type ct ON ct.id = c.card_type_id
    JOIN attribute_value av ON av.card_id = c.id
    JOIN attribute_def ad ON ad.id = av.attribute_def_id
    WHERE ct.name='project' AND ad.name='title' AND av.value='"Default Project"'::jsonb
    ORDER BY c.id LIMIT 1;
    IF proj_id IS NULL THEN
        RAISE EXCEPTION 'dense seed: Default Project not found (run 0005 first)';
    END IF;

    SELECT id INTO task_ct FROM card_type WHERE name='task';
    SELECT id INTO title_ad     FROM attribute_def WHERE name='title';
    SELECT id INTO status_ad    FROM attribute_def WHERE name='status';
    SELECT id INTO assignee_ad  FROM attribute_def WHERE name='assignee';
    SELECT id INTO milestone_ad FROM attribute_def WHERE name='milestone_ref';
    SELECT id INTO component_ad FROM attribute_def WHERE name='component_ref';
    SELECT id INTO tags_ad      FROM attribute_def WHERE name='tags';

    -- Look up milestone/component card ids by title under the Default Project.
    SELECT c.id INTO m1_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=title_ad
        WHERE c.parent_card_id=proj_id AND c.card_type_id=(SELECT id FROM card_type WHERE name='milestone')
          AND av.value='"M1"'::jsonb;
    SELECT c.id INTO m2_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=title_ad
        WHERE c.parent_card_id=proj_id AND c.card_type_id=(SELECT id FROM card_type WHERE name='milestone')
          AND av.value='"M2"'::jsonb;
    SELECT c.id INTO m3_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=title_ad
        WHERE c.parent_card_id=proj_id AND c.card_type_id=(SELECT id FROM card_type WHERE name='milestone')
          AND av.value='"M3"'::jsonb;

    SELECT c.id INTO fe_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=title_ad
        WHERE c.parent_card_id=proj_id AND c.card_type_id=(SELECT id FROM card_type WHERE name='component')
          AND av.value='"Frontend"'::jsonb;
    SELECT c.id INTO be_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=title_ad
        WHERE c.parent_card_id=proj_id AND c.card_type_id=(SELECT id FROM card_type WHERE name='component')
          AND av.value='"Backend"'::jsonb;
    SELECT c.id INTO db_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=title_ad
        WHERE c.parent_card_id=proj_id AND c.card_type_id=(SELECT id FROM card_type WHERE name='component')
          AND av.value='"DB"'::jsonb;
    SELECT c.id INTO auth_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=title_ad
        WHERE c.parent_card_id=proj_id AND c.card_type_id=(SELECT id FROM card_type WHERE name='component')
          AND av.value='"Auth"'::jsonb;
    SELECT c.id INTO ui_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=title_ad
        WHERE c.parent_card_id=proj_id AND c.card_type_id=(SELECT id FROM card_type WHERE name='component')
          AND av.value='"UI"'::jsonb;

    -- Look up tag card ids by their `path` attribute.
    SELECT c.id INTO pri_high_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=(SELECT id FROM attribute_def WHERE name='path')
        WHERE c.parent_card_id=proj_id AND av.value='"priority/high"'::jsonb;
    SELECT c.id INTO pri_med_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=(SELECT id FROM attribute_def WHERE name='path')
        WHERE c.parent_card_id=proj_id AND av.value='"priority/med"'::jsonb;
    SELECT c.id INTO pri_low_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=(SELECT id FROM attribute_def WHERE name='path')
        WHERE c.parent_card_id=proj_id AND av.value='"priority/low"'::jsonb;
    SELECT c.id INTO area_fe_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=(SELECT id FROM attribute_def WHERE name='path')
        WHERE c.parent_card_id=proj_id AND av.value='"area/frontend"'::jsonb;
    SELECT c.id INTO area_be_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=(SELECT id FROM attribute_def WHERE name='path')
        WHERE c.parent_card_id=proj_id AND av.value='"area/backend"'::jsonb;
    SELECT c.id INTO team_plat_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=(SELECT id FROM attribute_def WHERE name='path')
        WHERE c.parent_card_id=proj_id AND av.value='"team/platform"'::jsonb;
    SELECT c.id INTO team_prod_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=(SELECT id FROM attribute_def WHERE name='path')
        WHERE c.parent_card_id=proj_id AND av.value='"team/product"'::jsonb;
    SELECT c.id INTO team_grow_id FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=(SELECT id FROM attribute_def WHERE name='path')
        WHERE c.parent_card_id=proj_id AND av.value='"team/growth"'::jsonb;

    -- Users.
    SELECT id INTO alice_id FROM user_account WHERE display_name='alice';
    SELECT id INTO bob_id   FROM user_account WHERE display_name='bob';
    SELECT id INTO carol_id FROM user_account WHERE display_name='carol';
    SELECT id INTO dave_id  FROM user_account WHERE display_name='dave';
    SELECT id INTO eve_id   FROM user_account WHERE display_name='eve';

    -- Idempotency guard: if dense tasks already exist (specifically the
    -- one whose title is 'Wire pickers (dense#1)') skip everything.
    SELECT count(*) INTO n_tasks FROM card c
        JOIN attribute_value av ON av.card_id=c.id AND av.attribute_def_id=title_ad
        WHERE c.parent_card_id=proj_id AND c.card_type_id=task_ct
          AND av.value='"Wire pickers (dense#1)"'::jsonb;
    IF n_tasks > 0 THEN
        RAISE NOTICE 'dense seed: already applied; skipping';
        RETURN;
    END IF;

    -- 25-row task spec. Each row: title, status, assignee_id, milestone_id,
    -- component_id, jsonb-array-of-tag-card-ids. NULL entries are real NULL.
    -- The order is read by humans (not by ord) — distributions are tracked
    -- in the file header.
    FOR rec IN
        SELECT * FROM jsonb_to_recordset(jsonb_build_array(
            jsonb_build_object('title','Wire pickers (dense#1)',         'status','todo',  'assignee', alice_id, 'milestone', m1_id,   'component', fe_id,  'tags', jsonb_build_array(pri_high_id)),
            jsonb_build_object('title','API rate limits',                'status','todo',  'assignee', alice_id, 'milestone', m1_id,   'component', be_id,  'tags', jsonb_build_array(pri_high_id, area_be_id)),
            jsonb_build_object('title','Empty state copy',               'status','todo',  'assignee', bob_id,   'milestone', m1_id,   'component', fe_id,  'tags', jsonb_build_array(pri_med_id)),
            jsonb_build_object('title','Connection pool tuning',         'status','todo',  'assignee', bob_id,   'milestone', m2_id,   'component', db_id,  'tags', jsonb_build_array(pri_low_id)),
            jsonb_build_object('title','OIDC callback URL',              'status','todo',  'assignee', carol_id, 'milestone', m2_id,   'component', auth_id,'tags', jsonb_build_array(pri_high_id)),
            jsonb_build_object('title','Triage backlog',                 'status','todo',  'assignee', dave_id,  'milestone', NULL,    'component', NULL,   'tags', jsonb_build_array(pri_med_id)),
            jsonb_build_object('title','Onboarding checklist v2',        'status','todo',  'assignee', eve_id,   'milestone', m3_id,   'component', ui_id,  'tags', jsonb_build_array(pri_low_id, team_grow_id)),
            jsonb_build_object('title','Theme tokens',                   'status','todo',  'assignee', alice_id, 'milestone', m2_id,   'component', fe_id,  'tags', jsonb_build_array(pri_high_id, team_prod_id)),
            jsonb_build_object('title','Activity feed pagination',       'status','doing', 'assignee', alice_id, 'milestone', m1_id,   'component', be_id,  'tags', jsonb_build_array(pri_high_id)),
            jsonb_build_object('title','Read replica failover',          'status','doing', 'assignee', bob_id,   'milestone', m2_id,   'component', db_id,  'tags', jsonb_build_array(pri_med_id, area_be_id)),
            jsonb_build_object('title','Component editor refactor',      'status','doing', 'assignee', carol_id, 'milestone', m2_id,   'component', fe_id,  'tags', jsonb_build_array(pri_high_id, area_fe_id)),
            jsonb_build_object('title','JWKS cache',                     'status','doing', 'assignee', dave_id,  'milestone', m3_id,   'component', auth_id,'tags', jsonb_build_array(pri_med_id)),
            jsonb_build_object('title','Onboarding analytics',           'status','doing', 'assignee', eve_id,   'milestone', m1_id,   'component', ui_id,  'tags', jsonb_build_array(team_grow_id)),
            jsonb_build_object('title','Audit log retention',            'status','doing', 'assignee', alice_id, 'milestone', NULL,    'component', NULL,   'tags', jsonb_build_array(pri_low_id, team_prod_id)),
            jsonb_build_object('title','Empty grid placeholder',         'status','review','assignee', alice_id, 'milestone', m3_id,   'component', fe_id,  'tags', jsonb_build_array(pri_med_id)),
            jsonb_build_object('title','Idempotency-Key store',          'status','review','assignee', bob_id,   'milestone', m2_id,   'component', be_id,  'tags', jsonb_build_array(pri_high_id)),
            jsonb_build_object('title','Schema migration runner',        'status','review','assignee', carol_id, 'milestone', m3_id,   'component', db_id,  'tags', jsonb_build_array(pri_low_id, area_be_id)),
            jsonb_build_object('title','PKCE refresh',                   'status','review','assignee', dave_id,  'milestone', m1_id,   'component', auth_id,'tags', jsonb_build_array(pri_high_id, team_plat_id)),
            jsonb_build_object('title','Kanban swim lane DnD',           'status','review','assignee', eve_id,   'milestone', m2_id,   'component', ui_id,  'tags', jsonb_build_array(pri_med_id)),
            jsonb_build_object('title','Set up CI cache',                'status','done',  'assignee', alice_id, 'milestone', m1_id,   'component', fe_id,  'tags', jsonb_build_array(pri_high_id, team_plat_id)),
            jsonb_build_object('title','Migrate to pgx v5',              'status','done',  'assignee', alice_id, 'milestone', m2_id,   'component', be_id,  'tags', jsonb_build_array(pri_high_id)),
            jsonb_build_object('title','Bigserial primary keys',         'status','done',  'assignee', bob_id,   'milestone', m1_id,   'component', db_id,  'tags', jsonb_build_array(pri_med_id)),
            jsonb_build_object('title','Repo bootstrap docs',            'status','done',  'assignee', carol_id, 'milestone', m3_id,   'component', NULL,   'tags', jsonb_build_array(pri_med_id)),
            jsonb_build_object('title','Linter rule for INSERT',         'status','done',  'assignee', dave_id,  'milestone', m2_id,   'component', NULL,   'tags', jsonb_build_array(pri_low_id, team_plat_id)),
            jsonb_build_object('title','Closed: dispatcher MVP',         'status','done',  'assignee', carol_id, 'milestone', NULL,    'component', ui_id,  'tags', '[]'::jsonb)
        )) AS x(
            title text,
            status text,
            assignee bigint,
            milestone bigint,
            component bigint,
            tags jsonb
        )
    LOOP
        -- 1) The card row.
        INSERT INTO card (card_type_id, parent_card_id) VALUES (task_ct, proj_id) RETURNING id INTO cid;
        -- 2) card_create activity.
        INSERT INTO activity (card_id, kind, actor_id) VALUES (cid, 'card_create', 1);
        -- 3) title attribute (always present).
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (cid, 'attr_update', title_ad, NULL, to_jsonb(rec.title), 1) RETURNING id INTO aid;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (cid, title_ad, to_jsonb(rec.title), aid)
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
        -- 4) status.
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (cid, 'attr_update', status_ad, NULL, to_jsonb(rec.status), 1) RETURNING id INTO aid;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (cid, status_ad, to_jsonb(rec.status), aid)
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
        -- 5) assignee (always present per the spec).
        INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            VALUES (cid, 'attr_update', assignee_ad, NULL, to_jsonb(rec.assignee), 1) RETURNING id INTO aid;
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            VALUES (cid, assignee_ad, to_jsonb(rec.assignee), aid)
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
        -- 6) milestone (optional).
        IF rec.milestone IS NOT NULL THEN
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                VALUES (cid, 'attr_update', milestone_ad, NULL, to_jsonb(rec.milestone), 1) RETURNING id INTO aid;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                VALUES (cid, milestone_ad, to_jsonb(rec.milestone), aid)
                ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                    SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
        END IF;
        -- 7) component (optional).
        IF rec.component IS NOT NULL THEN
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                VALUES (cid, 'attr_update', component_ad, NULL, to_jsonb(rec.component), 1) RETURNING id INTO aid;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                VALUES (cid, component_ad, to_jsonb(rec.component), aid)
                ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                    SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
        END IF;
        -- 8) tags (jsonb array of tag card ids; only emit if non-empty).
        tag_ids := rec.tags;
        IF jsonb_array_length(tag_ids) > 0 THEN
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
                VALUES (cid, 'tag_apply', tags_ad, '[]'::jsonb, tag_ids, 1) RETURNING id INTO aid;
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
                VALUES (cid, tags_ad, tag_ids, aid)
                ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                    SET value = EXCLUDED.value, last_activity_id = EXCLUDED.last_activity_id;
        END IF;
    END LOOP;
END $$;

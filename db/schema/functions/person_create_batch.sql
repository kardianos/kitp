-- person.create handler (Phase 4 of UNIFIED_HANDLER_PLAN.md). Folds
-- the former Go-side runPersonCreate into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Decode + cheap presence/tier validation (title required; tier
--      must be one of 'contact' / 'assignee' / 'user'). 'user' tier
--      additionally requires a non-empty email (future OIDC match key).
--   2. Insert global person card (parent_card_id NULL) + card_create
--      activity.
--   3. Set-based write of the three core attributes via the
--      ordinality-join pattern (title, person_kind, optional email);
--      one activity row per attribute then ON CONFLICT upserts using
--      the returned activity ids.
--   4. Tier='user': INSERT a paired user_account row (oidc_sub NULL —
--      attached on first sign-in) plus the user_account_person link.
--      A pre-existing user_account.email collision raises 23505 which
--      the dispatcher maps to code='conflict'.
--
-- Like person_upsert_by_email_batch this function does NOT do Unicode
-- NFC normalization on title/email; PL/pgSQL only does ASCII-level
-- case folding via lower()/btrim(). The legacy Go-side textnorm.Email
-- / textnorm.Name path performed full NFC; documented in the plan
-- ("Idioms surfaced during Phase 2/3 — NFC normalisation in SQL").
-- Two emails differing only in NFC composition would land as
-- separate cards — acceptable for v1; revisit if a real user trips it.
--
-- Result JSON shape matches `comm.PersonCreateOutput`:
--   {"person_card_id": "<bigint>", "user_account_id": "<bigint>"}
-- user_account_id is 0 (omitempty on the Go side) when tier != 'user'.
CREATE OR REPLACE FUNCTION person_create_batch(
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
    _raw jsonb;
    _title_in text;
    _email_in text;
    _tier_in text;
    _title text;
    _email text;
    _tier text;
    _kind text;
    _want_user_account boolean;
    _person_ct_id bigint;
    _title_def bigint;
    _email_def bigint;
    _kind_def bigint;
    _new_id bigint;
    _user_account_id bigint;
BEGIN
    SELECT id INTO _person_ct_id FROM card_type WHERE name = 'person';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'person.create: card_type person missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _title_def FROM attribute_def WHERE name = 'title';
    SELECT id INTO _email_def FROM attribute_def WHERE name = 'email';
    SELECT id INTO _kind_def  FROM attribute_def WHERE name = 'person_kind';
    IF _title_def IS NULL OR _email_def IS NULL OR _kind_def IS NULL THEN
        RAISE EXCEPTION 'person.create: required attribute_defs missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _title_in := COALESCE(_raw->>'title', '');
        _email_in := COALESCE(_raw->>'email', '');
        _tier_in  := COALESCE(_raw->>'tier',  '');

        -- 1a. Title required (after btrim — matches textnorm.Name's
        --     leading/trailing space strip but not full NFC).
        _title := btrim(_title_in);
        IF _title = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'person.create: title is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 1b. Email: lower + trim. Matches person_upsert_by_email_batch.
        _email := lower(btrim(_email_in));

        -- 1c. Tier validation. Map tier -> person_kind; reject unknown.
        _tier := lower(btrim(_tier_in));
        _want_user_account := false;
        IF _tier = 'contact' THEN
            _kind := 'contact';
        ELSIF _tier = 'assignee' THEN
            _kind := 'member';
        ELSIF _tier = 'user' THEN
            _kind := 'member';
            _want_user_account := true;
            IF _email = '' THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'person.create: email is required when tier=''user'' (future OIDC match key)'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
        ELSE
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('person.create: tier %L must be one of ''contact'' | ''assignee'' | ''user''',
                       _tier_in),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. Insert global person card + card_create activity.
        INSERT INTO card (card_type_id, parent_card_id) VALUES (_person_ct_id, NULL)
        RETURNING id INTO _new_id;
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_new_id, 'card_create', person_create_batch.actor_id);

        -- 3. Set-based attribute writes. Three rows max: title + kind
        --    always, email only when non-empty (contact / assignee may
        --    skip; user always carries one). Ordinality-join collapses
        --    the writes to one activity-INSERT + one ON CONFLICT upsert.
        WITH writes(ord, attr_def_id, value) AS (
            SELECT * FROM (VALUES
                (1, _title_def, to_jsonb(_title)),
                (2, _kind_def,  to_jsonb(_kind)),
                (3, _email_def, to_jsonb(_email))
            ) AS v(ord, attr_def_id, value)
            WHERE NOT (v.ord = 3 AND _email = '')
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _new_id, 'attr_update', w.attr_def_id, NULL, w.value,
                   person_create_batch.actor_id
            FROM writes w
            ORDER BY w.ord
            RETURNING id, attribute_def_id, value_new
        )
        INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
        SELECT _new_id, ia.attribute_def_id, ia.value_new, ia.id
        FROM ins_activity ia
        ON CONFLICT (card_id, attribute_def_id) DO UPDATE
            SET value = EXCLUDED.value,
                last_activity_id = EXCLUDED.last_activity_id;

        -- 4. tier='user' → create the login row + link. oidc_sub stays
        --    NULL — OIDC provisioning attaches it on first sign-in.
        --    If user_account.email already exists, 23505 escapes to the
        --    dispatcher (mapped to code='conflict').
        _user_account_id := 0;
        IF _want_user_account THEN
            INSERT INTO user_account (display_name, email)
            VALUES (_title, NULLIF(_email, ''))
            RETURNING id INTO _user_account_id;
            INSERT INTO user_account_person (user_account_id, person_card_id)
            VALUES (_user_account_id, _new_id);
        END IF;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'person_card_id', _new_id::text,
                'user_account_id', _user_account_id::text
            );
    END LOOP;
END;
$$;

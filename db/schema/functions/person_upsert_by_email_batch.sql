-- person.upsert_by_email handler (Phase 3 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runPersonUpsertByEmail into one PL/pgSQL
-- body.
--
-- Per-row pipeline:
--   1. Decode + cheap presence checks (email required).
--   2. Optional `kind` validation: must be empty / 'member' / 'contact'.
--   3. Lookup: case-insensitive match on the person.email
--      attribute_value across all person cards (deleted_at IS NULL).
--      On hit, return the existing id with created=false and DO NOT
--      reclassify (matches the legacy "existing persons are not
--      re-tagged" rule covered by TestPersonUpsertByEmail's Bob case).
--   4. On miss, create a global person card (parent_card_id NULL),
--      stamp a card_create activity, and write the three core
--      attributes (title / email / person_kind) via the same
--      ordinality-join pattern reply_post_batch uses so the five
--      activity rows + upserts share one statement-pair.
--
-- The Go-side textnorm.Email helper (NFC + lowercase + trim) is NOT
-- re-implemented here — Postgres can do lowercase/trim via lower() +
-- btrim() but NFC normalization needs a Unicode lib not available
-- without an extension. The existing test corpus only exercises
-- lowercase folding ("Alice@Example.com" -> "alice@example.com"), so
-- this function applies lower(btrim(...)) at both store and lookup
-- time. NFC-only differences would land in separate person cards;
-- callers that need NFC must normalize before encoding to JSON.
--
-- Result JSON shape matches `comm.PersonUpsertByEmailOutput`:
--   {"person_id": "<bigint>", "created": true|false}
CREATE OR REPLACE FUNCTION person_upsert_by_email_batch(
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
    _email_in text;
    _email text;
    _display_name text;
    _title text;
    _kind_in text;
    _kind text;
    _person_ct_id bigint;
    _title_def bigint;
    _email_def bigint;
    _kind_def bigint;
    _existing bigint;
    _new_id bigint;
BEGIN
    SELECT id INTO _person_ct_id FROM card_type WHERE name = 'person';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'person.upsert_by_email: card_type person missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _title_def FROM attribute_def WHERE name = 'title';
    SELECT id INTO _email_def FROM attribute_def WHERE name = 'email';
    SELECT id INTO _kind_def  FROM attribute_def WHERE name = 'person_kind';
    IF _title_def IS NULL OR _email_def IS NULL OR _kind_def IS NULL THEN
        RAISE EXCEPTION 'person.upsert_by_email: required attribute_defs missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _email_in := COALESCE(_raw->>'email', '');
        _display_name := COALESCE(_raw->>'display_name', '');
        _kind_in := COALESCE(_raw->>'kind', '');

        -- 1. Required: email (trimmed).
        _email := lower(btrim(_email_in));
        IF _email = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'person.upsert_by_email: email is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. kind validation.
        IF _kind_in <> '' AND _kind_in NOT IN ('member', 'contact') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                format('person.upsert_by_email: kind %L is not one of ''member'' / ''contact''',
                       _kind_in),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Case-insensitive lookup. Stored values are also lowered by
        --    this function on write, but historical rows + IMAP-sourced
        --    persons might carry mixed case — lower() on both sides
        --    keeps the join symmetric.
        SELECT av.card_id INTO _existing
        FROM attribute_value av
        JOIN card c ON c.id = av.card_id
        WHERE av.attribute_def_id = _email_def
          AND c.card_type_id = _person_ct_id
          AND c.deleted_at IS NULL
          AND lower(av.value #>> '{}') = _email
        ORDER BY av.card_id
        LIMIT 1;
        IF FOUND THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object(
                    'person_id', _existing::text,
                    'created', false
                );
            CONTINUE;
        END IF;

        -- 4. Create. Title defaults to the (trimmed) email when no
        --    display_name is supplied. Title is stored verbatim — no
        --    case folding — so the operator's casing intent is
        --    preserved. Kind defaults to 'contact'.
        _title := btrim(_display_name);
        IF _title = '' THEN
            _title := _email;
        END IF;
        IF _kind_in = '' THEN
            _kind := 'contact';
        ELSE
            _kind := _kind_in;
        END IF;

        INSERT INTO card (card_type_id, parent_card_id) VALUES (_person_ct_id, NULL)
        RETURNING id INTO _new_id;
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_new_id, 'card_create', person_upsert_by_email_batch.actor_id);

        -- Set-based attribute writes via the ordinality-join pattern.
        -- Three rows: title / email / person_kind. The CTE emits one
        -- activity per attribute then ON CONFLICT upserts using the
        -- returned activity ids as last_activity_id.
        WITH writes(ord, attr_def_id, value) AS (
            VALUES
                (1, _title_def, to_jsonb(_title)),
                (2, _email_def, to_jsonb(_email)),
                (3, _kind_def,  to_jsonb(_kind))
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _new_id, 'attr_update', w.attr_def_id, NULL, w.value,
                   person_upsert_by_email_batch.actor_id
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

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'person_id', _new_id::text,
                'created', true
            );
    END LOOP;
END;
$$;

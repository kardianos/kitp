-- link.set handler — create or update a LINK on a task: a code change
-- (Gerrit CL, pull request), an issue, or any URL worth keeping next to
-- the work. One handler serves the task-detail UI, MCP and the forge
-- hook (POST /api/v1/links), so a code forge and a person adding the
-- same URL land on the same card.
--
-- A link is a `link` card parented under the task, carrying:
--   title       — display text (defaults to the url on create)
--   link_url    — the canonical URL; the identity of the link on its task
--   link_kind   — short slug naming the source ('gerrit', 'github',
--                 'issue', …); '' / absent = a plain URL
--   link_state  — short slug the source reports ('open', 'reviewed',
--                 'approved', 'merged', 'abandoned', …); '' = no state
-- kind / state are open slugs, not an enum: the kernel stores text and
-- the web client maps the slugs it knows to an icon + tone.
--
-- IDEMPOTENT UPSERT keyed on (task_id, url): the first call creates the
-- card, every repeat finds it and PATCHes it. A transaction-scoped
-- advisory lock on the (task, url) pair serialises concurrent callers
-- (a forge firing two events at once) so they can't both miss the
-- lookup and create twins. Only attributes whose value actually
-- changes write an activity row (with value_old), so a forge
-- re-sending an unchanged state is a pure no-op.
--
-- PATCH semantics: title / kind / state are written when present and
-- left alone when absent (or JSON null). A present-but-blank title is
-- ignored (title is a required edge); a blank kind / state clears it.
--
-- Authz: the dispatcher gates on card.update of the PARENT TASK (like
-- attachments), so anyone who can edit the task can link to it.
--
-- Result JSON shape matches `link.SetOutput`:
--   {"link_id": "<bigint>", "created": bool, "changed": bool}
CREATE OR REPLACE FUNCTION link_set_batch(
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
    _link_ct_id bigint;
    _title_def bigint;
    _url_def bigint;
    _kind_def bigint;
    _state_def bigint;
    _idx int;
    _raw jsonb;
    _task_id bigint;
    _task_ct text;
    _url text;
    _title text;
    _title_present boolean;
    _kind text;
    _kind_present boolean;
    _state text;
    _state_present boolean;
    _link_id bigint;
    _created boolean;
    _writes int;
BEGIN
    SELECT id INTO _link_ct_id FROM card_type WHERE name = 'link';
    IF _link_ct_id IS NULL THEN
        RAISE EXCEPTION 'link.set: card_type link missing'
            USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO _title_def FROM attribute_def WHERE name = 'title';
    SELECT id INTO _url_def   FROM attribute_def WHERE name = 'link_url';
    SELECT id INTO _kind_def  FROM attribute_def WHERE name = 'link_kind';
    SELECT id INTO _state_def FROM attribute_def WHERE name = 'link_state';
    IF _title_def IS NULL OR _url_def IS NULL OR _kind_def IS NULL OR _state_def IS NULL THEN
        RAISE EXCEPTION 'link.set: one of the link attribute_defs is missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode + shape validation.
        BEGIN
            _task_id := COALESCE(NULLIF(_raw->>'task_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _task_id := 0;
        END;
        IF _task_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'link.set: task_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        _url := btrim(COALESCE(_raw->>'url', ''));
        IF _url = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'link.set: url is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF length(_url) > 2048 OR _url !~* '^https?://[^[:space:]]+$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'link.set: url must be an absolute http(s) URL of at most 2048 characters'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        _title := btrim(COALESCE(_raw->>'title', ''));
        _title_present := (_raw ? 'title') AND jsonb_typeof(_raw->'title') <> 'null'
                          AND _title <> '';
        IF length(_title) > 500 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'link.set: title must be at most 500 characters'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        _kind_present := (_raw ? 'kind') AND jsonb_typeof(_raw->'kind') <> 'null';
        _kind := lower(btrim(COALESCE(_raw->>'kind', '')));
        _state_present := (_raw ? 'state') AND jsonb_typeof(_raw->'state') <> 'null';
        _state := lower(btrim(COALESCE(_raw->>'state', '')));
        IF _kind <> '' AND _kind !~ '^[a-z][a-z0-9_-]{0,31}$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'link.set: kind must be a short slug (letters, digits, - or _; at most 32)'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;
        IF _state <> '' AND _state !~ '^[a-z][a-z0-9_-]{0,31}$' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'link.set: state must be a short slug (letters, digits, - or _; at most 32)'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. The target must be a live task.
        SELECT ct.name INTO _task_ct
          FROM card c JOIN card_type ct ON ct.id = c.card_type_id
          WHERE c.id = _task_id AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'task_not_found'::text,
                format('link.set: task %s not found', _task_id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _task_ct <> 'task' THEN
            RETURN QUERY SELECT _idx, false, 'wrong_card_type'::text,
                format('link.set: card %s is %L, not a task', _task_id, _task_ct),
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 3. Serialise writers of this (task, url) pair, then find the live
        --    link if one exists. The lock releases at commit / rollback.
        PERFORM pg_advisory_xact_lock(
            hashtextextended('kitp.link:' || _task_id::text || ':' || _url, 0));
        _link_id := NULL;
        SELECT c.id INTO _link_id
          FROM card c
          JOIN attribute_value av ON av.card_id = c.id AND av.attribute_def_id = _url_def
          WHERE c.parent_card_id = _task_id
            AND c.card_type_id = _link_ct_id
            AND c.deleted_at IS NULL
            AND av.value = to_jsonb(_url)
          ORDER BY c.id
          LIMIT 1;

        _created := _link_id IS NULL;
        IF _created THEN
            INSERT INTO card (card_type_id, parent_card_id)
            VALUES (_link_ct_id, _task_id)
            RETURNING id INTO _link_id;
            INSERT INTO activity (card_id, kind, actor_id)
            VALUES (_link_id, 'card_create', link_set_batch.actor_id);
        END IF;

        -- 4. Set-based write of the CHANGED attributes only (value_old
        --    carried so the activity stream renders "old → new").
        WITH want(ord, attr_def_id, value) AS (
            SELECT row_number() OVER () AS ord, attr_def_id, value
            FROM (
                SELECT _title_def AS attr_def_id,
                       to_jsonb(CASE WHEN _title_present THEN _title ELSE _url END) AS value
                WHERE _title_present OR _created
                UNION ALL
                SELECT _url_def, to_jsonb(_url)
                WHERE _created
                UNION ALL
                SELECT _kind_def, to_jsonb(_kind)
                WHERE _kind_present
                UNION ALL
                SELECT _state_def, to_jsonb(_state)
                WHERE _state_present
            ) AS w
        ),
        changed AS (
            SELECT w.ord, w.attr_def_id, w.value, cur.value AS old_value
            FROM want w
            LEFT JOIN attribute_value cur
              ON cur.card_id = _link_id AND cur.attribute_def_id = w.attr_def_id
            -- A blank kind / state on a link that never had one is not a
            -- change (nothing to clear).
            WHERE cur.value IS DISTINCT FROM w.value
              AND NOT (cur.value IS NULL AND w.value = to_jsonb(''::text))
        ),
        ins_activity AS (
            INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
            SELECT _link_id, 'attr_update', c.attr_def_id, c.old_value, c.value,
                   link_set_batch.actor_id
            FROM changed c
            ORDER BY c.ord
            RETURNING id, attribute_def_id, value_new
        ),
        upsert AS (
            INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
            SELECT _link_id, ia.attribute_def_id, ia.value_new, ia.id
            FROM ins_activity ia
            ON CONFLICT (card_id, attribute_def_id) DO UPDATE
                SET value = EXCLUDED.value,
                    last_activity_id = EXCLUDED.last_activity_id
            RETURNING 1
        )
        SELECT count(*)::int INTO _writes FROM upsert;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'link_id', _link_id::text,
                'created', _created,
                'changed', _created OR _writes > 0
            );
    END LOOP;
END;
$$;

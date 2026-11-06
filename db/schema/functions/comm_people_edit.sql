-- comm_people_edit — add people to, and take people from, one of a thread's
-- kitp-kept person lists (comm.comm_confirmed, comm.comm_removed: card_ref[]
-- of person ids). Ids already on stay where they are; added ids go at the
-- end in the order given. Shared by comm_confirm and comm_remove. No
-- activity row: comm_recipients' own row records the change that caused it.
CREATE OR REPLACE FUNCTION comm_people_edit(
    comm_id bigint,
    def_name text,
    add_people bigint[],
    drop_people bigint[]
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    _def bigint;
    _old jsonb;
BEGIN
    IF COALESCE(cardinality(add_people), 0) = 0 AND COALESCE(cardinality(drop_people), 0) = 0 THEN
        RETURN;
    END IF;
    SELECT id INTO _def FROM attribute_def WHERE name = comm_people_edit.def_name;
    IF _def IS NULL THEN
        RAISE EXCEPTION 'comm_people_edit: attribute_def % missing', comm_people_edit.def_name
            USING ERRCODE = 'P0001';
    END IF;
    PERFORM card_list_lock(ARRAY[comm_people_edit.comm_id]);
    SELECT av.value INTO _old
    FROM attribute_value av
    WHERE av.card_id = comm_people_edit.comm_id AND av.attribute_def_id = _def;
    IF _old IS NULL AND COALESCE(cardinality(add_people), 0) = 0 THEN
        RETURN; -- nothing to take from, nothing to add
    END IF;
    IF _old IS NULL OR jsonb_typeof(_old) <> 'array' THEN
        _old := '[]'::jsonb;
    END IF;
    INSERT INTO attribute_value (card_id, attribute_def_id, value)
    SELECT comm_people_edit.comm_id, _def, COALESCE(jsonb_agg(to_jsonb(id) ORDER BY first_ord), '[]'::jsonb)
    FROM (
        SELECT id, min(ord) AS first_ord
        FROM (
            SELECT (e.v #>> '{}')::bigint AS id, e.ord
            FROM jsonb_array_elements(_old) WITH ORDINALITY AS e(v, ord)
            WHERE (e.v #>> '{}') ~ '^[0-9]{1,18}$'
            UNION ALL
            SELECT p.id, 1000000 + p.ord
            FROM unnest(COALESCE(add_people, ARRAY[]::bigint[])) WITH ORDINALITY AS p(id, ord)
            WHERE p.id IS NOT NULL
        ) all_ids
        WHERE NOT (id = ANY(COALESCE(drop_people, ARRAY[]::bigint[])))
        GROUP BY id
    ) merged
    ON CONFLICT (card_id, attribute_def_id) DO UPDATE SET value = EXCLUDED.value;
END;
$$;

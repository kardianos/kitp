-- card_merge_into — the shared graph-merge primitive. Folds every `loser` card
-- into `survivor`: repoint all card_ref / card_ref[] attribute_values from any
-- loser -> survivor (deduping arrays), soft-delete the losers, and emit a
-- 'card_merge' activity on the survivor (absorbed ids) and on each loser (its
-- merge target). Returns the count of attribute_value rows repointed.
--
-- GENERIC by design — works for any card_type (duplicate milestones / components
-- / tags / persons). It deliberately knows nothing about type-specific links
-- (e.g. a person's user_account_person row); person_merge_batch handles those
-- and then calls this. CALLERS must validate first: survivor + losers exist,
-- are non-deleted, distinct, and the losers share survivor's card_type.
--
-- card_ref values are stored canonically as JSON numbers (to_jsonb(bigint));
-- a numeric STRING is tolerated on read (matches copy_project_template's
-- defensive remap) and normalised to a number on write.
CREATE OR REPLACE FUNCTION card_merge_into(
    survivor bigint,
    losers bigint[],
    actor_id bigint
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
    _repointed int := 0;
    _n int;
    _loser bigint;
BEGIN
    -- Scalar card_ref (assignee, originator, status, milestone_ref, …): repoint
    -- in place. One value per (card_id, attribute_def_id), so no unique clash.
    UPDATE attribute_value av
    SET value = to_jsonb(survivor)
    FROM attribute_def ad
    WHERE av.attribute_def_id = ad.id
      AND ad.value_type = 'card_ref'
      AND (
        (jsonb_typeof(av.value) = 'number' AND (av.value)::text::bigint = ANY(losers))
        OR (jsonb_typeof(av.value) = 'string'
            AND (av.value #>> '{}') ~ '^-?\d+$'
            AND (av.value #>> '{}')::bigint = ANY(losers))
      );
    GET DIAGNOSTICS _n = ROW_COUNT;
    _repointed := _repointed + _n;

    -- card_ref[] (comm_recipients, tags, …): rewrite each element loser ->
    -- survivor, then DISTINCT to dedup (survivor may now appear twice). Only
    -- touch arrays that actually contain a loser.
    UPDATE attribute_value av
    SET value = (
        SELECT COALESCE(jsonb_agg(DISTINCT remapped), '[]'::jsonb)
        FROM (
            SELECT CASE
                WHEN jsonb_typeof(e.v) = 'number' AND (e.v)::text::bigint = ANY(losers)
                    THEN to_jsonb(survivor)
                WHEN jsonb_typeof(e.v) = 'string'
                     AND (e.v #>> '{}') ~ '^-?\d+$'
                     AND (e.v #>> '{}')::bigint = ANY(losers)
                    THEN to_jsonb(survivor)
                ELSE e.v
            END AS remapped
            FROM jsonb_array_elements(av.value) AS e(v)
        ) s
    )
    FROM attribute_def ad
    WHERE av.attribute_def_id = ad.id
      AND ad.value_type = 'card_ref[]'
      AND jsonb_typeof(av.value) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(av.value) AS e(v)
        WHERE (jsonb_typeof(e.v) = 'number' AND (e.v)::text::bigint = ANY(losers))
           OR (jsonb_typeof(e.v) = 'string'
               AND (e.v #>> '{}') ~ '^-?\d+$'
               AND (e.v #>> '{}')::bigint = ANY(losers))
      );
    GET DIAGNOSTICS _n = ROW_COUNT;
    _repointed := _repointed + _n;

    -- Soft-delete each loser + a per-loser merge marker (value_new = survivor).
    FOREACH _loser IN ARRAY losers LOOP
        UPDATE card SET deleted_at = now() WHERE id = _loser AND deleted_at IS NULL;
        INSERT INTO activity (card_id, kind, actor_id, value_new)
        VALUES (_loser, 'card_merge', actor_id, to_jsonb(survivor::text));
    END LOOP;

    -- Survivor marker records the absorbed loser ids (as a JSON string array).
    INSERT INTO activity (card_id, kind, actor_id, value_new)
    VALUES (survivor, 'card_merge', actor_id,
            (SELECT COALESCE(jsonb_agg(l::text ORDER BY l), '[]'::jsonb) FROM unnest(losers) AS l));

    RETURN _repointed;
END;
$$;

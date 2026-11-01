-- bundle_source_purge — hard-delete a feature bundle's hidden SOURCE
-- project and everything under it, so store.ApplySchema's bundle tier can
-- re-materialise the bundle from its file.
--
-- Safe only for bundle sources: they are code-owned (written by the
-- bundle file, never by people), hold no tasks, comments, attachments or
-- per-user state, and nothing points at them — projects that applied the
-- bundle hold independent copies whose provenance (card_origin) is keyed
-- by (bundle_key, item_key), not by source card id. The function refuses
-- any project that isn't flagged is_template + bundle_key.
--
-- Order: flow_steps and flows scoped to the subtree first (flow_step and
-- flow.default_create_status_id reference value cards without a cascade),
-- then attribute values and activity, then the cards in one statement (the
-- parent_card_id FK is checked at statement end, so parents and children
-- go together).
CREATE OR REPLACE FUNCTION bundle_source_purge(project_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    _ok boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM card c
        JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
        JOIN attribute_value tv ON tv.card_id = c.id
        JOIN attribute_def td ON td.id = tv.attribute_def_id AND td.name = 'is_template'
        JOIN attribute_value bv ON bv.card_id = c.id
        JOIN attribute_def bd ON bd.id = bv.attribute_def_id AND bd.name = 'bundle_key'
        WHERE c.id = bundle_source_purge.project_id
          AND tv.value = to_jsonb(true)
          AND jsonb_typeof(bv.value) = 'string'
          AND bv.value #>> '{}' <> ''
    ) INTO _ok;
    IF NOT _ok THEN
        RAISE EXCEPTION 'bundle_source_purge: card % is not a bundle source project', project_id
            USING ERRCODE = 'P0001';
    END IF;

    CREATE TEMP TABLE IF NOT EXISTS _purge (id bigint PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE _purge;
    INSERT INTO _purge (id)
    WITH RECURSIVE sub(id, depth) AS (
        SELECT c.id, 0 FROM card c WHERE c.id = bundle_source_purge.project_id
        UNION ALL
        SELECT c.id, sub.depth + 1
        FROM card c JOIN sub ON c.parent_card_id = sub.id
        WHERE sub.depth < 16
    )
    SELECT DISTINCT id FROM sub;

    DELETE FROM flow_step fs
    USING flow f
    WHERE fs.flow_id = f.id AND f.scope_card_id IN (SELECT id FROM _purge);
    DELETE FROM flow WHERE scope_card_id IN (SELECT id FROM _purge);
    DELETE FROM attribute_value WHERE card_id IN (SELECT id FROM _purge);
    DELETE FROM activity WHERE card_id IN (SELECT id FROM _purge);
    DELETE FROM card WHERE id IN (SELECT id FROM _purge);
END;
$$;

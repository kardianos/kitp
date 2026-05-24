-- card.select handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runSelect into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Decode parent_card_id / card_type_name. Both optional.
--   2. SELECT cards filtered by parent + card_type, soft-deleted
--      excluded, gated by the per-actor visibility predicate (B7) — a
--      card is visible if the actor (or, for agents, their parent
--      user) holds at least one user_role row that is global
--      (scope_card_id IS NULL) or scoped to the card's enclosing
--      project. Mirrors schema.VisibilityClause.
--   3. Emit rows as a JSONB array under "rows" — matches
--      card.SelectOutput.
--
-- Result JSON shape:
--   {"rows": [{"id":"...", "card_type_id":"...", "card_type_name":"...",
--             "parent_card_id":"..." | null, "title": null}]}
-- Title is intentionally null in this read path — the SPA's main read
-- is card.select_with_attributes; this lighter read leaves title for
-- callers that don't need it (matches the pre-migration Go body).
CREATE OR REPLACE FUNCTION card_select_batch(
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
    _parent_card_id bigint;
    _card_type_name text;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _parent_card_id := NULLIF(_raw->>'parent_card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _parent_card_id := NULL;
        END;
        _card_type_name := NULLIF(_raw->>'card_type_name', '');

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id',              c.id::text,
                        'card_type_id',    c.card_type_id::text,
                        'card_type_name',  ct.name,
                        'parent_card_id',  CASE
                                               WHEN c.parent_card_id IS NULL THEN NULL
                                               ELSE to_jsonb(c.parent_card_id::text)
                                           END,
                        'title',           NULL
                    ) ORDER BY c.id
                )
                FROM card c
                JOIN card_type ct ON ct.id = c.card_type_id
                WHERE c.deleted_at IS NULL
                  AND (_parent_card_id IS NULL OR c.parent_card_id = _parent_card_id)
                  AND (_card_type_name IS NULL OR ct.name = _card_type_name)
                  AND EXISTS (
                    WITH RECURSIVE up(id, parent_card_id, card_type_id) AS (
                        SELECT card.id, card.parent_card_id, card.card_type_id
                        FROM card WHERE card.id = c.id
                        UNION ALL
                        SELECT p.id, p.parent_card_id, p.card_type_id
                        FROM card p JOIN up ON p.id = up.parent_card_id
                    )
                    SELECT 1
                    FROM user_account caller
                    JOIN user_role ur
                      ON ur.user_id = caller.id
                      OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
                    WHERE caller.id = card_select_batch.actor_id
                      AND (
                        ur.scope_card_id IS NULL
                        OR ur.scope_card_id IN (
                            SELECT up.id
                            FROM up JOIN card_type ct2 ON ct2.id = up.card_type_id
                            WHERE ct2.name = 'project'
                        )
                      )
                  )
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

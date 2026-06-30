-- card.search handler (Phase 5 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runSearch + numericIDFromQuery / nullableString /
-- nullableInt64Array helpers into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Decode + validate card_type_name (required).
--   2. Compute numeric_id (when query parses as a positive bigint).
--      The Go strconv.ParseInt path is replicated via a regex gate +
--      EXCEPTION-wrapped cast so non-numeric inputs leave it NULL.
--   3. Decode optional ids[] (jsonb array of strings or numbers) into
--      a bigint[]. NULL when empty/missing.
--   4. SELECT (id, title) hits filtered by card_type + visibility +
--      query (ILIKE on title OR exact id match via the numeric arm) +
--      optional ids[] + optional parent_card_id. Ordered newest-first.
--
-- Result JSON shape matches `card.SearchOutput`:
--   {"rows": [{"id": "<bigint>", "title": "..."}]}
CREATE OR REPLACE FUNCTION card_search_batch(
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
    _card_type_name text;
    _query text;
    _limit int;
    _parent_card_id bigint;
    _numeric_id bigint;
    _ids bigint[];
    _ids_raw jsonb;
    _el jsonb;
    _el_val bigint;
    _exclude_terminal boolean;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _card_type_name := COALESCE(_raw->>'card_type_name', '');
        IF _card_type_name = '' THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.search: card_type_name is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        _query := NULLIF(_raw->>'query', '');
        _limit := COALESCE(NULLIF(_raw->>'limit', '')::int, 50);
        IF _limit <= 0 THEN
            _limit := 50;
        END IF;
        IF _limit > 200 THEN
            _limit := 200;
        END IF;

        BEGIN
            _parent_card_id := NULLIF(_raw->>'parent_card_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _parent_card_id := NULL;
        END;

        _exclude_terminal := COALESCE((_raw->>'exclude_terminal')::boolean, false);

        -- numeric_id: only set when the query parses cleanly as a
        -- positive bigint (matches Go's strconv.ParseInt + > 0 gate).
        _numeric_id := NULL;
        IF _query IS NOT NULL AND _query ~ '^[0-9]+$' THEN
            BEGIN
                _numeric_id := _query::bigint;
                IF _numeric_id <= 0 THEN
                    _numeric_id := NULL;
                END IF;
            EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
                _numeric_id := NULL;
            END;
        END IF;

        -- Optional ids[]. Accepts JSON numbers or numeric strings;
        -- malformed elements silently skipped (Go-side reg.IDs already
        -- skips non-digit forms during UnmarshalJSON).
        _ids := NULL;
        _ids_raw := _raw->'ids';
        IF _ids_raw IS NOT NULL AND jsonb_typeof(_ids_raw) = 'array'
           AND jsonb_array_length(_ids_raw) > 0 THEN
            _ids := ARRAY[]::bigint[];
            FOR _el IN SELECT e.v
                       FROM jsonb_array_elements(_ids_raw) WITH ORDINALITY AS e(v, ord)
                       ORDER BY ord
            LOOP
                BEGIN
                    IF jsonb_typeof(_el) = 'number' THEN
                        _el_val := (_el)::text::bigint;
                    ELSIF jsonb_typeof(_el) = 'string'
                          AND (_el #>> '{}') ~ '^-?[0-9]+$' THEN
                        _el_val := ((_el #>> '{}')::bigint);
                    ELSE
                        CONTINUE;
                    END IF;
                EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                    CONTINUE;
                END;
                _ids := array_append(_ids, _el_val);
            END LOOP;
            IF array_length(_ids, 1) IS NULL THEN
                _ids := NULL;
            END IF;
        END IF;

        RETURN QUERY
        SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id',    sub.id::text,
                        'title', sub.title
                    ) ORDER BY sub.created_at DESC, sub.id DESC
                )
                FROM (
                    SELECT c.id, c.created_at,
                           COALESCE(av.value #>> '{}', '') AS title
                    FROM card c
                    JOIN card_type ct ON ct.id = c.card_type_id
                    LEFT JOIN LATERAL (
                        SELECT av.value
                        FROM attribute_value av
                        JOIN attribute_def ad ON ad.id = av.attribute_def_id
                        WHERE av.card_id = c.id AND ad.name = 'title'
                        LIMIT 1
                    ) av ON TRUE
                    WHERE c.deleted_at IS NULL
                      AND ct.name = _card_type_name
                      AND (
                        _query IS NULL
                        OR av.value #>> '{}' ILIKE '%' || _query || '%'
                        OR (_numeric_id IS NOT NULL AND c.id = _numeric_id)
                      )
                      AND (_ids IS NULL OR c.id = ANY(_ids))
                      AND (_parent_card_id IS NULL OR c.parent_card_id = _parent_card_id)
                      -- Open-work filter: drop cards whose `status` value-card
                      -- sits in the terminal phase. Cards with no `status`
                      -- attribute (most non-task types) are kept — the NOT
                      -- EXISTS is vacuously true. `status` is a card_ref stored
                      -- as a JSON number; #>> '{}' yields the id text.
                      AND (NOT _exclude_terminal OR NOT EXISTS (
                        SELECT 1
                        FROM attribute_value sav
                        JOIN attribute_def sad
                          ON sad.id = sav.attribute_def_id AND sad.name = 'status'
                        JOIN card sc ON sc.id = (sav.value #>> '{}')::bigint
                        WHERE sav.card_id = c.id
                          AND sc.phase = 'terminal'
                      ))
                      AND EXISTS (
                        -- depth < 16 caps the parent walk (CLAUDE.md cap;
                        -- matches card_ancestors / scopeWalkDepth) so a
                        -- parent_card_id cycle can't pin the connection (A1).
                        WITH RECURSIVE up(id, parent_card_id, card_type_id, depth) AS (
                            SELECT card.id, card.parent_card_id, card.card_type_id, 0
                            FROM card WHERE card.id = c.id
                            UNION ALL
                            SELECT p.id, p.parent_card_id, p.card_type_id, up.depth + 1
                            FROM card p JOIN up ON p.id = up.parent_card_id
                            WHERE up.depth < 16
                        )
                        SELECT 1
                        FROM user_account caller
                        JOIN user_role ur
                          ON ur.user_id = caller.id
                          OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
                        WHERE caller.id = card_search_batch.actor_id
                          AND (
                            ur.scope_card_id IS NULL
                            OR ur.scope_card_id IN (
                                SELECT up.id
                                FROM up JOIN card_type ct2 ON ct2.id = up.card_type_id
                                WHERE ct2.name = 'project'
                            )
                          )
                      )
                    ORDER BY c.created_at DESC, c.id DESC
                    LIMIT _limit
                ) sub
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

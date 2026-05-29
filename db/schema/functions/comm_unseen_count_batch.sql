-- comm.unseen_count handler: a CHEAP "how many new received comms?" probe for
-- the header notification bell. Given a since_activity_id it returns the newest
-- received-comm create-activity id and the count of received reply_body cards
-- created after it, across EVERY project the caller can see.
--
-- A received message is a reply_body card with delivery_status='received'
-- (written by the IMAP ingest). Each is referenced by exactly one comm via the
-- comm's `replies` array; the comm's parent is the task, the task's parent is
-- the project. Visibility (B7) is therefore one hop: the caller (or, if an
-- agent, their parent_user) must hold a globally-scoped user_role OR one scoped
-- to that project (task.parent_card_id). Projects are the top scoping unit, so
-- no recursive walk is needed here.
--
-- The cursor is the reply_body's card_create activity id (monotonic per new
-- message). Clients seed their baseline with an initial since=0 call (which
-- returns latest with unseen_count counting everything) then store latest.
--
-- Result JSON shape matches `comm.UnseenCountOutput`.
CREATE OR REPLACE FUNCTION comm_unseen_count_batch(
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
    _since bigint;
    _latest bigint;
    _count int;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        BEGIN
            _since := COALESCE(NULLIF(_raw->>'since_activity_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            _since := 0;
        END;

        WITH visible AS (
            SELECT DISTINCT ca.id AS create_activity_id
            FROM card rb
            JOIN card_type ct_rb ON ct_rb.id = rb.card_type_id AND ct_rb.name = 'reply_body'
            JOIN attribute_value dav ON dav.card_id = rb.id
                AND dav.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'delivery_status')
                AND dav.value = to_jsonb('received'::text)
            JOIN activity ca ON ca.card_id = rb.id AND ca.kind = 'card_create'
            JOIN attribute_value rep ON rep.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'replies')
                AND rep.value @> to_jsonb(rb.id)
            JOIN card cm ON cm.id = rep.card_id AND cm.deleted_at IS NULL   -- the comm
            JOIN card tk ON tk.id = cm.parent_card_id                        -- the task
            WHERE rb.deleted_at IS NULL
              AND EXISTS (
                  SELECT 1
                  FROM user_account caller
                  JOIN user_role ur
                    ON ur.user_id = caller.id
                    OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
                  WHERE caller.id = comm_unseen_count_batch.actor_id
                    AND (ur.scope_card_id IS NULL OR ur.scope_card_id = tk.parent_card_id)
              )
        )
        SELECT COALESCE(max(create_activity_id), 0),
               COALESCE(count(*) FILTER (WHERE create_activity_id > _since), 0)::int
          INTO _latest, _count
        FROM visible;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'latest_activity_id', _latest::text,
                'unseen_count', _count
            );
    END LOOP;
END;
$$;

-- approval.decide handler — record that the caller approves or rejects one
-- of a task's status actions ("Approve: Review → Done").
--
-- A decision is documentation, never a gate: it moves nothing and blocks
-- nothing. It is an immutable approval_decision activity row on the TASK,
-- so it sits in the task's history (and comment stream) and survives the
-- removal of any request. A vote belongs to the EDGE — the task moving
-- from one specific status to another — not to a request: a request only
-- asks people to vote on an edge. value_new carries:
--   decision    — 'approve' | 'reject'
--   from_id / to_id / action — the edge voted on (label snapshotted)
--   status_id   — the task's status when the decision was made
--   person_id   — the caller's person card (how a vote is matched to the
--                 people a request names); absent with no linked person —
--                 an agent account, whose vote is shown with its owner
--                 ("claude (for Dana)") but answers no one's request
--   comment_body_id — the optional reason, stored like a comment's body
--                 (comment_body) so activity.select hydrates it and
--                 comment.update can edit its wording
-- Votes on an edge run in rounds: a round ends when the task reaches the
-- edge's target (approval_round_start), settling its votes. Within the
-- current round a later vote by the same person supersedes the earlier one
-- (reject now, approve later); both stay in the history. Re-sending the
-- vote already in force this round with no reason is a no-op.
--
-- Anyone who may comment on the task can vote, asked or not — agents too
-- (through MCP). Whether a vote answers a request is worked out on read:
-- it counts for a person asked when its person_id is theirs, so an
-- agent's vote never stands in for its owner's.
--
-- The edge comes from a request (approval_id, a convenience: only the edge
-- is stored) or from from_status_id → to_status_id, which must be a step
-- of the task's status flow (task_status_action).
--
-- Authz: the dispatcher gates on comment.post of the task.
--
-- Result JSON shape matches `approval.DecideOutput`:
--   {"decision_id": "<activity id>", "changed": bool}
CREATE OR REPLACE FUNCTION approval_decide_batch(
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
    _approval_ct bigint;
    _status_def bigint;
    _from_def bigint;
    _to_def bigint;
    _action_def bigint;
    _idx int;
    _raw jsonb;
    _task_id bigint;
    _approval_id bigint;
    _from_id bigint;
    _to_id bigint;
    _label text;
    _decision text;
    _reason text;
    _person_id bigint;
    _status_id bigint;
    _body_id bigint;
    _latest_id bigint;
    _latest_decision text;
    _new_id bigint;
BEGIN
    SELECT id INTO _approval_ct FROM card_type WHERE name = 'approval';
    SELECT id INTO _status_def FROM attribute_def WHERE name = 'status';
    SELECT id INTO _from_def   FROM attribute_def WHERE name = 'approval_from';
    SELECT id INTO _to_def     FROM attribute_def WHERE name = 'approval_to';
    SELECT id INTO _action_def FROM attribute_def WHERE name = 'approval_action';
    IF _approval_ct IS NULL OR _status_def IS NULL OR _from_def IS NULL OR _to_def IS NULL
       OR _action_def IS NULL THEN
        RAISE EXCEPTION 'approval.decide: the approval card_type or one of its attribute_defs is missing'
            USING ERRCODE = 'P0001';
    END IF;

    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        -- 1. Decode + shape validation.
        BEGIN
            _task_id     := COALESCE(NULLIF(_raw->>'task_id', '')::bigint, 0);
            _approval_id := COALESCE(NULLIF(_raw->>'approval_id', '')::bigint, 0);
            _from_id     := COALESCE(NULLIF(_raw->>'from_status_id', '')::bigint, 0);
            _to_id       := COALESCE(NULLIF(_raw->>'to_status_id', '')::bigint, 0);
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.decide: ids must be card ids'::text, NULL::jsonb;
            CONTINUE;
        END;
        _decision := COALESCE(_raw->>'decision', '');
        _reason := btrim(COALESCE(_raw->>'reason', ''));
        IF _task_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.decide: task_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _decision NOT IN ('approve', 'reject') THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.decide: decision must be ''approve'' or ''reject'''::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF length(_reason) > 20000 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'approval.decide: reason must be at most 20000 characters'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. The task, and the edge voted on.
        IF NOT EXISTS (
            SELECT 1 FROM card c JOIN card_type ct ON ct.id = c.card_type_id
            WHERE c.id = _task_id AND c.deleted_at IS NULL AND ct.name = 'task'
        ) THEN
            RETURN QUERY SELECT _idx, false, 'task_not_found'::text,
                format('approval.decide: task %s not found', _task_id), NULL::jsonb;
            CONTINUE;
        END IF;
        IF _approval_id <> 0 THEN
            SELECT (f.value)::text::bigint, (t.value)::text::bigint, a.value #>> '{}'
              INTO _from_id, _to_id, _label
            FROM card c
            JOIN attribute_value f ON f.card_id = c.id AND f.attribute_def_id = _from_def
            JOIN attribute_value t ON t.card_id = c.id AND t.attribute_def_id = _to_def
            JOIN attribute_value a ON a.card_id = c.id AND a.attribute_def_id = _action_def
            WHERE c.id = _approval_id AND c.card_type_id = _approval_ct
              AND c.parent_card_id = _task_id AND c.deleted_at IS NULL;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'approval_not_found'::text,
                    format('approval.decide: approval %s not found on task %s', _approval_id, _task_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        ELSE
            IF _from_id = 0 OR _to_id = 0 THEN
                RETURN QUERY SELECT _idx, false, 'validation'::text,
                    'approval.decide: give approval_id, or from_status_id and to_status_id'::text,
                    NULL::jsonb;
                CONTINUE;
            END IF;
            SELECT sa.label INTO _label FROM task_status_action(_task_id, _from_id, _to_id) sa;
            IF NOT FOUND THEN
                RETURN QUERY SELECT _idx, false, 'approval_no_such_action'::text,
                    format('approval.decide: no status action leads from %s to %s in this task''s flow',
                           _from_id, _to_id),
                    NULL::jsonb;
                CONTINUE;
            END IF;
        END IF;

        -- 3. The same vote again this round, with nothing to add, changes
        --    nothing.
        SELECT a.id, a.value_new->>'decision' INTO _latest_id, _latest_decision
        FROM activity a
        WHERE a.card_id = _task_id AND a.kind = 'approval_decision'
          AND a.actor_id = approval_decide_batch.actor_id
          AND a.value_new->>'from_id' = _from_id::text
          AND a.value_new->>'to_id' = _to_id::text
          AND a.created_at > COALESCE(approval_round_start(_task_id, _to_id), '-infinity'::timestamptz)
        ORDER BY a.id DESC
        LIMIT 1;
        IF FOUND AND _latest_decision = _decision AND _reason = '' THEN
            RETURN QUERY SELECT _idx, true, ''::text, ''::text,
                jsonb_build_object('decision_id', _latest_id::text, 'changed', false);
            CONTINUE;
        END IF;

        -- 4. Record it. Only a person's own login carries their person id
        --    (agents have no user_account_person link of their own).
        SELECT uap.person_card_id INTO _person_id
        FROM user_account_person uap
        WHERE uap.user_account_id = approval_decide_batch.actor_id
        ORDER BY uap.person_card_id
        LIMIT 1;
        IF NOT FOUND THEN
            _person_id := NULL;
        END IF;
        SELECT (av.value)::text::bigint INTO _status_id
        FROM attribute_value av
        WHERE av.card_id = _task_id AND av.attribute_def_id = _status_def
          AND jsonb_typeof(av.value) = 'number';
        _body_id := NULL;
        IF _reason <> '' THEN
            INSERT INTO comment_body (body) VALUES (_reason) RETURNING id INTO _body_id;
        END IF;
        INSERT INTO activity (card_id, kind, value_new, actor_id)
        VALUES (_task_id, 'approval_decision',
                jsonb_strip_nulls(jsonb_build_object(
                    'decision', _decision,
                    'from_id', _from_id::text,
                    'to_id', _to_id::text,
                    'action', _label,
                    'status_id', _status_id::text,
                    'person_id', _person_id::text,
                    'comment_body_id', _body_id
                )),
                approval_decide_batch.actor_id)
        RETURNING id INTO _new_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('decision_id', _new_id::text, 'changed', true);
    END LOOP;
END;
$$;

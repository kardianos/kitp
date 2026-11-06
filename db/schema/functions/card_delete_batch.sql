-- card.delete handler (Phase 2 of UNIFIED_HANDLER_PLAN.md). Folds the
-- former Go-side runDelete into one PL/pgSQL body.
--
-- Per-row pipeline:
--   1. Validation: card_id is required.
--   2. flow_step reference guard (V8): if any flow_step row names the
--      card as from_card_id or to_card_id, the delete is rejected
--      with code 'value_referenced_by_flow' and a structured
--      blocked_by detail (same envelope shape as the legacy Go path).
--   2b. A flow's starting state is refused the same way, steps or not.
--   3. Soft-delete: SET deleted_at = now() WHERE deleted_at IS NULL.
--      If no row matched (card missing or already deleted) the row
--      surfaces 'card_not_found' — same as the legacy "seen != ins"
--      diagnostic but pinned to the specific input.
--   4. Activity row of kind='card_delete'.
--
-- Result JSON shape matches `card.DeleteOutput`:
--   {"ok": true, "activity_id": "<bigint>"}
-- The bigint id is cast to text per the dispatcher's wire convention.
CREATE OR REPLACE FUNCTION card_delete_batch(
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
    _card_id bigint;
    _title text;
    _blocker_count int;
    _blockers jsonb;
    _activity_id bigint;
    _updated bigint;
BEGIN
    FOR _idx, _card_id IN
        SELECT (r.ord - 1)::int,
               NULLIF(r.value->>'card_id', '')::bigint
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        IF _card_id IS NULL OR _card_id = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.delete: card_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 1b. A mail account or an activity sink is a workspace admin's
        --     (review 2026-11-06 #2).
        IF card_is_admin_only(_card_id) AND NOT user_is_global_admin(card_delete_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'card.delete: only a workspace admin changes a mail account or an activity sink'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        -- 2. flow_step reference guard.
        SELECT count(*) INTO _blocker_count
        FROM flow_step fs
        WHERE fs.from_card_id = _card_id OR fs.to_card_id = _card_id;
        IF _blocker_count > 0 THEN
            -- Resolve title for the friendly message.
            SELECT COALESCE(av.value #>> '{}', '')
              INTO _title
            FROM attribute_value av
            JOIN attribute_def ad ON ad.id = av.attribute_def_id
            WHERE av.card_id = _card_id AND ad.name = 'title';
            IF _title IS NULL OR _title = '' THEN
                _title := format('card %s', _card_id);
            END IF;
            -- Build blocked_by array (mirrors FlowStepBlocker on the Go
            -- side: flow_step_id, flow_id, flow_name, role, from_label,
            -- to_label, step_label).
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'flow_step_id', fs.id::text,
                'flow_id', fs.flow_id::text,
                'flow_name', f.name,
                'role', CASE WHEN fs.from_card_id = _card_id THEN 'from' ELSE 'to' END,
                'from_label', COALESCE(av_from.value #>> '{}', ''),
                'to_label', COALESCE(av_to.value #>> '{}', ''),
                'step_label', fs.label
            ) ORDER BY fs.id), '[]'::jsonb)
              INTO _blockers
            FROM flow_step fs
            JOIN flow f ON f.id = fs.flow_id
            LEFT JOIN attribute_def ad_title ON ad_title.name = 'title'
            LEFT JOIN attribute_value av_from
              ON av_from.card_id = fs.from_card_id
             AND av_from.attribute_def_id = ad_title.id
            LEFT JOIN attribute_value av_to
              ON av_to.card_id = fs.to_card_id
             AND av_to.attribute_def_id = ad_title.id
            WHERE fs.from_card_id = _card_id OR fs.to_card_id = _card_id;
            RETURN QUERY SELECT _idx, false, 'value_referenced_by_flow'::text,
                format('Cannot delete %L: %s flow_step row(s) reference it.',
                    _title, _blocker_count),
                jsonb_build_object(
                    -- card_id emitted as JSON number to match the legacy
                    -- Go-side Detail payload (the test decodes it into
                    -- an int64 without a `,string` tag).
                    'card_id', _card_id,
                    'blocked_by', _blockers
                );
            CONTINUE;
        END IF;

        -- 2b. A flow's starting state can't go either, with no step yet:
        --     the flow would name a deleted card for every new task
        --     (review 2026-11-03 round 4). Pick another starting state
        --     first. Same detail shape as 2, nothing blocking but the flow.
        IF EXISTS (SELECT 1 FROM flow f WHERE f.default_create_status_id = _card_id) THEN
            RETURN QUERY SELECT _idx, false, 'value_referenced_by_flow'::text,
                format('card.delete: card %s is a flow''s starting state; choose another first', _card_id),
                jsonb_build_object('card_id', _card_id, 'blocked_by', '[]'::jsonb);
            CONTINUE;
        END IF;

        -- 3. Soft delete.
        WITH upd AS (
            UPDATE card SET deleted_at = now()
            WHERE id = _card_id AND deleted_at IS NULL
            RETURNING id
        )
        SELECT count(*) INTO _updated FROM upd;
        IF _updated = 0 THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                'card.delete: one or more cards were missing or already deleted'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        -- 4. Activity row.
        INSERT INTO activity (card_id, kind, actor_id)
        VALUES (_card_id, 'card_delete', actor_id)
        RETURNING id INTO _activity_id;

        -- 5. A deleted page leaves every portal, and so does every page
        --    under a deleted card (a project, a parent page): the build and
        --    the serving paths skip pages under a deleted card (review
        --    2026-11-03 #17), and the portals they are on rebuild. The
        --    publications stay, so card.undelete brings the pages back as
        --    they were published (round 2 #19). The walk is per page.
        PERFORM portal_mark_dirty(pp.portal_id) FROM portals_publishing_under(_card_id) pp;
        -- A theme deleted or brought back rebuilds the portals built
        -- with it (review 2026-11-03 round 5).
        PERFORM portal_mark_dirty(pv.card_id)
        FROM attribute_value pv
        JOIN attribute_def pd ON pd.id = pv.attribute_def_id AND pd.name = 'portal_theme'
        WHERE jsonb_typeof(pv.value) = 'number' AND (pv.value)::text::bigint = _card_id;

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'activity_id', _activity_id::text
            );
    END LOOP;
END;
$$;

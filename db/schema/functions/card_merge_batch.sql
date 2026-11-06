-- card.merge handler — fold one or more duplicate `loser` cards into a
-- `survivor` of the SAME card_type, repointing every card_ref / card_ref[]
-- reference and soft-deleting the losers (see card_merge_into). Generic across
-- card types (duplicate milestones / components / tags / persons). The
-- person-specific path (user_account_person reconciliation, login-conflict
-- guard, email backfill) lives in person_merge_batch, which shares the same
-- card_merge_into primitive.
--
-- Per-row input: {"survivor_id": "<bigint>", "loser_ids": ["<bigint>", ...]}.
-- Validation: survivor + every loser must exist, be non-deleted, distinct from
-- the survivor, and share the survivor's card_type.
--
-- Scope: the dispatcher authorizes the survivor only (its project's
-- card.delete grant, or the owner of a private survivor). So every loser must
-- sit in the survivor's project (card_enclosing_project, both NULL for a
-- global card such as a person), share its privacy (private_to: the same
-- person, or both shared), be visible to the caller and not be in a switched-
-- off area. Without that, a manager of one project could soft-delete and
-- repoint any other project's cards, or anyone's private views (review
-- 2026-11-03 #2).
--
-- Not through here (review 2026-11-03 round 2 #4, #6):
--   - people: person.merge, which keeps one login per person and moves a
--     person's private cards only with their login. Merged here, an admin
--     could take another user's watch lists and views ('use_person_merge');
--   - a value a flow uses (a status a flow step leads from or to): merging
--     it would leave steps naming a deleted card, as card.delete refuses
--     ('value_referenced_by_flow');
--   - a loser whose cards would land in a state the caller couldn't move
--     them into (flow_state_role_gated on the survivor): a merge is a bulk
--     move ('flow_role_required').
--
-- Result JSON shape matches `card.MergeOutput`:
--   {"ok": true, "survivor_id": "<bigint>", "merged_count": N, "repointed": M}
CREATE OR REPLACE FUNCTION card_merge_batch(
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
    _survivor bigint;
    _losers bigint[];
    _loser bigint;
    _surv_ct bigint;
    _surv_project bigint;
    _surv_private bigint;
    _ct bigint;
    _private bigint;
    _repointed int;
    _bad_code text;
    _bad_msg text;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _bad_code := NULL;
        _bad_msg := NULL;

        BEGIN
            _survivor := NULLIF(_raw->>'survivor_id', '')::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
            _survivor := NULL;
        END;

        -- Parse loser_ids[] (numeric strings or numbers), deduped.
        SELECT COALESCE(array_agg(DISTINCT x), '{}'::bigint[]) INTO _losers
        FROM (
            SELECT (e.v #>> '{}')::bigint AS x
            FROM jsonb_array_elements(COALESCE(_raw->'loser_ids', '[]'::jsonb)) AS e(v)
            WHERE (e.v #>> '{}') ~ '^-?\d+$'
        ) q;

        IF _survivor IS NULL OR _survivor = 0 THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.merge: survivor_id is required'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF array_length(_losers, 1) IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.merge: loser_ids must be a non-empty array'::text, NULL::jsonb;
            CONTINUE;
        END IF;
        IF _survivor = ANY(_losers) THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'card.merge: survivor_id cannot also be a loser'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        SELECT card_type_id, private_to INTO _surv_ct, _surv_private FROM card
        WHERE id = _survivor AND deleted_at IS NULL;
        IF NOT FOUND THEN
            RETURN QUERY SELECT _idx, false, 'card_not_found'::text,
                format('card.merge: survivor %s not found or deleted', _survivor), NULL::jsonb;
            CONTINUE;
        END IF;

        IF _surv_ct = (SELECT id FROM card_type WHERE name = 'person') THEN
            RETURN QUERY SELECT _idx, false, 'use_person_merge'::text,
                'card.merge: people are merged with person.merge, which keeps their logins and private cards apart'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;

        IF card_is_admin_only(_survivor) AND NOT user_is_global_admin(card_merge_batch.actor_id) THEN
            RETURN QUERY SELECT _idx, false, 'forbidden'::text,
                'card.merge: only a workspace admin changes a mail account or an activity sink'::text, NULL::jsonb;
            CONTINUE;
        END IF;

        _surv_project := card_home_project(_survivor);

        -- Every loser must exist, be live, share the survivor's card_type,
        -- project and privacy, and be one the caller can see.
        FOREACH _loser IN ARRAY _losers LOOP
            SELECT card_type_id, private_to INTO _ct, _private FROM card
            WHERE id = _loser AND deleted_at IS NULL;
            IF NOT FOUND OR NOT card_visible_to(actor_id, _loser) THEN
                _bad_code := 'card_not_found';
                _bad_msg := format('card.merge: loser %s not found or deleted', _loser);
                EXIT;
            END IF;
            IF _ct <> _surv_ct THEN
                _bad_code := 'card_type_mismatch';
                _bad_msg := format('card.merge: loser %s is a different card_type than survivor %s', _loser, _survivor);
                EXIT;
            END IF;
            IF card_home_project(_loser) IS DISTINCT FROM _surv_project THEN
                _bad_code := 'forbidden';
                _bad_msg := format('card.merge: loser %s is in another project than survivor %s', _loser, _survivor);
                EXIT;
            END IF;
            IF _private IS DISTINCT FROM _surv_private THEN
                _bad_code := 'forbidden';
                _bad_msg := format('card.merge: loser %s and survivor %s are not both yours, or both shared', _loser, _survivor);
                EXIT;
            END IF;
            -- A flow's starting state counts even with no steps yet: the
            -- flow would name a merged-away card (review 2026-11-03 round 4).
            IF EXISTS (SELECT 1 FROM flow_step fs WHERE fs.from_card_id = _loser OR fs.to_card_id = _loser)
               OR EXISTS (SELECT 1 FROM flow f WHERE f.default_create_status_id = _loser) THEN
                _bad_code := 'value_referenced_by_flow';
                _bad_msg := format('card.merge: %s is a state of a flow; take it out of the flow first', _loser);
                EXIT;
            END IF;
        END LOOP;
        -- A portal's root page is a workspace setting only an admin
        -- changes (portal.set): merging it away re-pointed the portal at the
        -- survivor (review 2026-11-03 round 5).
        IF _bad_code IS NULL AND NOT user_is_global_admin(card_merge_batch.actor_id) AND EXISTS (
            SELECT 1 FROM attribute_value r
            JOIN attribute_def rd ON rd.id = r.attribute_def_id AND rd.name = 'portal_root'
            WHERE jsonb_typeof(r.value) = 'number' AND (r.value)::text::bigint = ANY(_losers)) THEN
            _bad_code := 'forbidden';
            _bad_msg := 'card.merge: a page that is a portal''s root is merged only by a workspace admin';
        END IF;
        -- The losers' cards take the survivor as their state: the caller
        -- must be able to move a card into it (any flow it is a state of
        -- whose attribute holds a loser somewhere).
        IF _bad_code IS NULL THEN
            SELECT format('card.merge: moving cards into %s needs a role you don''t hold', _survivor)
              INTO _bad_msg
            FROM flow f
            WHERE _survivor = ANY(flow_state_ids(f.id))
              AND EXISTS (
                  SELECT 1 FROM attribute_value av
                  WHERE av.attribute_def_id = f.attribute_def_id
                    AND jsonb_typeof(av.value) = 'number'
                    AND (av.value)::text::bigint = ANY(_losers))
              AND flow_state_role_gated(card_merge_batch.actor_id, f.id, _survivor, f.scope_card_id)
            LIMIT 1;
            IF _bad_msg IS NOT NULL THEN
                _bad_code := 'flow_role_required';
            END IF;
        END IF;
        -- The losers' live children go to the survivor (a merged page's
        -- section; review 2026-11-03 round 5 #13 — they stayed under the
        -- deleted card, out of the site and unreachable). Not when the
        -- survivor sits under a loser (a cycle), nor past the nesting cap.
        IF _bad_code IS NULL AND EXISTS (
            SELECT 1 FROM card ch WHERE ch.parent_card_id = ANY(_losers) AND ch.deleted_at IS NULL) THEN
            IF EXISTS (SELECT 1 FROM card_ancestors(_survivor) a WHERE a.id = ANY(_losers)) THEN
                _bad_code := 'cycle';
                _bad_msg := format('card.merge: survivor %s is under a card being merged into it', _survivor);
            ELSIF (SELECT count(*) FROM card_ancestors(_survivor))
                  + (WITH RECURSIVE sub(id, depth) AS (
                         SELECT ch.id, 0 FROM card ch WHERE ch.parent_card_id = ANY(_losers) AND ch.deleted_at IS NULL
                         UNION ALL
                         SELECT c.id, sub.depth + 1 FROM card c JOIN sub ON c.parent_card_id = sub.id
                         WHERE sub.depth < 16)
                     SELECT max(depth) FROM sub) >= 14 THEN
                _bad_code := 'too_deep';
                _bad_msg := 'card.merge: the merged cards'' children would nest more than 14 deep';
            END IF;
        END IF;
        IF _bad_code IS NOT NULL THEN
            RETURN QUERY SELECT _idx, false, _bad_code, _bad_msg, NULL::jsonb;
            CONTINUE;
        END IF;

        -- Merging pages repoints portals' roots and the pages' children:
        -- the portals publishing any of them rebuild (review 2026-11-03
        -- round 4). Marked before the merge, while the losers still have
        -- their pages under them, and after it, for the survivor.
        PERFORM portal_mark_dirty(pp.portal_id)
        FROM (SELECT DISTINCT u.portal_id FROM unnest(_losers) AS l(id)
              CROSS JOIN LATERAL portals_publishing_under(l.id) u
              UNION
              SELECT r.card_id FROM attribute_value r
              JOIN attribute_def rd ON rd.id = r.attribute_def_id AND rd.name = 'portal_root'
              WHERE jsonb_typeof(r.value) = 'number' AND (r.value)::text::bigint = ANY(_losers)) pp(portal_id);
        WITH moved AS (
            UPDATE card ch SET parent_card_id = _survivor
            FROM card old
            WHERE ch.parent_card_id = ANY(_losers) AND ch.deleted_at IS NULL AND old.id = ch.id
            RETURNING ch.id, old.parent_card_id AS was
        )
        INSERT INTO activity (card_id, kind, value_old, value_new, actor_id)
        SELECT m.id, 'card_move', to_jsonb(m.was), to_jsonb(_survivor), card_merge_batch.actor_id FROM moved m;
        _repointed := card_merge_into(_survivor, _losers, actor_id);
        PERFORM portal_mark_dirty(pp.portal_id) FROM portals_publishing_under(_survivor) pp;
        -- Merged themes: the portals now built with the survivor rebuild;
        -- merged portals: the survivor rebuilds, taking the losers' pages
        -- (review 2026-11-03 round 5).
        PERFORM portal_mark_dirty(pv.card_id)
        FROM attribute_value pv
        JOIN attribute_def pd ON pd.id = pv.attribute_def_id AND pd.name = 'portal_theme'
        WHERE jsonb_typeof(pv.value) = 'number' AND (pv.value)::text::bigint = _survivor;
        PERFORM portal_mark_dirty(_survivor)
        WHERE _surv_ct = (SELECT id FROM card_type WHERE name = 'portal');

        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object(
                'ok', true,
                'survivor_id', _survivor::text,
                'merged_count', array_length(_losers, 1),
                'repointed', _repointed
            );
    END LOOP;
END;
$$;

-- flow_state_ids — the live value cards that are states of one flow: its
-- default_create_status_id plus every from / to card of its flow_steps.
--
-- A flow-bound attribute (status, comm_status) may only ever hold one of
-- these. A value outside the set — a soft-deleted status card, a status no
-- flow_step touches, a value card belonging to a sibling flow — strands the
-- card: the attribute.update flow gate finds no step off it, and the
-- attribute is required so it can't be cleared either. attribute.update,
-- card.insert and task.move reject such values up front.
--
-- Result order is unspecified; callers test membership with = ANY(...).
CREATE OR REPLACE FUNCTION flow_state_ids(p_flow_id bigint)
RETURNS bigint[] LANGUAGE sql STABLE AS $$
    SELECT COALESCE(array_agg(c.id), ARRAY[]::bigint[])
    FROM card c
    WHERE c.deleted_at IS NULL
      AND c.id IN (
          SELECT f.default_create_status_id FROM flow f WHERE f.id = p_flow_id
          UNION
          SELECT fs.from_card_id FROM flow_step fs WHERE fs.flow_id = p_flow_id
          UNION
          SELECT fs.to_card_id FROM flow_step fs WHERE fs.flow_id = p_flow_id)
$$;

-- user_has_grant — whether the user holds a role granting the process on
-- the card_type, globally or scoped to the project: the dispatcher's
-- per-row authz rule (internal/api/authz.go authorizeLeaf) for a write a
-- handler makes on top of the one it was gated on. approval.set asks it
-- before starting an email thread (comm, card.create), since that write
-- doesn't pass through comm.create's own gate.
CREATE OR REPLACE FUNCTION user_has_grant(
    p_user_id bigint,
    p_card_type text,
    p_process text,
    p_project_id bigint
) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM user_role ur
        JOIN role_grant rg ON rg.role_id = ur.role_id
        JOIN card_type ct  ON ct.id = rg.card_type_id AND ct.name = p_card_type
        JOIN process p     ON p.id = rg.process_id AND p.name = p_process
        WHERE ur.user_id = p_user_id
          AND (ur.scope_card_id IS NULL OR ur.scope_card_id = p_project_id)
    )
$$;

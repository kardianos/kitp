-- user_role.list — return every user_role row for the requested user.
-- One input → one output row whose result.rows holds the grant tuples.
-- Authz (parent/admin/self) is enforced in Go (authzList); this body
-- only does the read.

CREATE OR REPLACE FUNCTION user_role_list_batch(
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
    _user_id bigint;
BEGIN
    FOR _idx, _raw IN
        SELECT (r.ord - 1)::int, r.value
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        _user_id := NULLIF(_raw->>'user_id', '')::bigint;
        IF _user_id IS NULL THEN
            RETURN QUERY SELECT _idx, false, 'validation'::text,
                'user_role.list: user_id is required'::text,
                NULL::jsonb;
            CONTINUE;
        END IF;
        RETURN QUERY SELECT _idx, true, ''::text, ''::text,
            jsonb_build_object('rows', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'role_name', r.name,
                    'scope_project_id', CASE WHEN ur.scope_card_id IS NULL THEN NULL ELSE ur.scope_card_id::text END
                ) ORDER BY r.name, ur.scope_card_id NULLS FIRST)
                FROM user_role ur
                JOIN role r ON r.id = ur.role_id
                WHERE ur.user_id = _user_id
            ), '[]'::jsonb));
    END LOOP;
END;
$$;

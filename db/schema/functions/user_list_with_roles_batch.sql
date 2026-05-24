-- user.list_with_roles handler (Phase 5 of UNIFIED_HANDLER_PLAN.md).
-- Folds the former Go-side runListWithRoles into one PL/pgSQL body.
--
-- One input → one result row. Returns every user_account row joined
-- with their role assignments (scope_card_id + resolved scope project
-- title for scoped grants). Single global snapshot — input fields are
-- ignored in v1, but the wrapper signature is preserved for uniformity.
--
-- Authz (admin) runs pre-tx in Go.
--
-- Result JSON shape matches `user.ListWithRolesOutput`:
--   {"rows": [{"id": "<bigint>", "display_name": "...", "email": ...,
--             "oidc_sub": ..., "parent_user_id": ..., "is_agent": bool,
--             "person_card_id": "<bigint>"|null,
--             "roles": [{"role_name": "...",
--                        "scope_project_id": "<bigint>"|null,
--                        "scope_project_title": "..."|null}]}]}
CREATE OR REPLACE FUNCTION user_list_with_roles_batch(
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
    _payload jsonb;
BEGIN
    -- Resolve title attribute_def id once (used in the lateral lookup
    -- for scope_project_title).
    --
    -- Build the rows aggregate inline; the per-user roles array is
    -- assembled via a correlated subquery joining user_role + role +
    -- the title attribute_value for scoped grants.
    SELECT jsonb_build_object('rows', COALESCE((
        SELECT jsonb_agg(
            jsonb_build_object(
                'id',             ua.id::text,
                'display_name',   ua.display_name,
                'email',
                    CASE WHEN ua.email IS NULL OR ua.email = ''
                         THEN NULL::jsonb
                         ELSE to_jsonb(ua.email)
                    END,
                'oidc_sub',
                    CASE WHEN ua.oidc_sub IS NULL
                         THEN NULL::jsonb
                         ELSE to_jsonb(ua.oidc_sub)
                    END,
                'parent_user_id',
                    CASE WHEN ua.parent_user_id IS NULL
                         THEN NULL::jsonb
                         ELSE to_jsonb(ua.parent_user_id::text)
                    END,
                'is_agent',       ua.is_agent,
                'person_card_id',
                    CASE WHEN uap.person_card_id IS NULL
                         THEN NULL::jsonb
                         ELSE to_jsonb(uap.person_card_id::text)
                    END,
                'roles', COALESCE((
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'role_name', r.name,
                            'scope_project_id',
                                CASE WHEN ur.scope_card_id IS NULL
                                     THEN NULL::jsonb
                                     ELSE to_jsonb(ur.scope_card_id::text)
                                END,
                            'scope_project_title',
                                CASE WHEN ur.scope_card_id IS NULL THEN NULL::jsonb
                                     ELSE (
                                        SELECT av.value
                                        FROM attribute_value av
                                        JOIN attribute_def ad ON ad.id = av.attribute_def_id
                                        WHERE av.card_id = ur.scope_card_id
                                          AND ad.name = 'title'
                                        LIMIT 1
                                     )
                                END
                        ) ORDER BY r.name, ur.scope_card_id NULLS FIRST
                    )
                    FROM user_role ur
                    JOIN role r ON r.id = ur.role_id
                    WHERE ur.user_id = ua.id
                ), '[]'::jsonb)
            ) ORDER BY ua.display_name, ua.id
        )
        FROM user_account ua
        LEFT JOIN user_account_person uap ON uap.user_account_id = ua.id
        WHERE NOT ua.is_agent
    ), '[]'::jsonb))
    INTO _payload;

    FOR _idx IN
        SELECT (r.ord - 1)::int
        FROM jsonb_array_elements(inputs) WITH ORDINALITY AS r(value, ord)
    LOOP
        RETURN QUERY SELECT _idx, true, ''::text, ''::text, _payload;
    END LOOP;
END;
$$;

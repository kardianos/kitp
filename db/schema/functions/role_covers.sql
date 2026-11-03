-- role_covers — whether holding role `holder` covers role `wanted`: the
-- same role, or a built-in role ranked at or above it (role.rank: viewer 1
-- < commenter 2 < worker 3 < manager 4 < admin 5). Each of those roles'
-- grants contains the ones below it (seed.hcsv role_grant), so an owner who
-- holds admin but not worker can still let an agent act as a worker: the
-- agent does no more than its owner could. A role without a rank (0)
-- covers only itself. Used by user_role_effective and user_role.set.
CREATE OR REPLACE FUNCTION role_covers(holder bigint, wanted bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT holder = wanted
        OR EXISTS (SELECT 1 FROM role h, role w
                   WHERE h.id = holder AND w.id = wanted
                     AND w.rank > 0 AND h.rank >= w.rank)
$$;

-- portal_mark_dirty — flag a portal for the portal.build job. dirty_since
-- takes clock_timestamp() (not now()) so every mark writes a value the
-- builder hasn't seen: it clears the flag only if dirty_since still equals
-- what it read before building, so a change that lands mid-build keeps the
-- portal dirty for the next tick.
CREATE OR REPLACE FUNCTION portal_mark_dirty(portal_id bigint)
RETURNS void LANGUAGE sql AS $$
    INSERT INTO portal_state (portal_id, dirty_since)
    VALUES (portal_mark_dirty.portal_id, clock_timestamp())
    ON CONFLICT (portal_id) DO UPDATE SET dirty_since = EXCLUDED.dirty_since
$$;

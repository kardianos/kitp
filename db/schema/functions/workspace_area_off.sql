-- workspace_area_off — true when the workspace-scoped area `key` (Sites)
-- is switched off. The portal and theme handlers, builder and servers
-- check it: with Sites off nothing is built, served, listed or changed.
CREATE OR REPLACE FUNCTION workspace_area_off(key text)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM workspace_area w WHERE w.area_key = workspace_area_off.key AND w.state = 'off')
$$;

-- activity_set_actor_admin — BEFORE INSERT trigger on activity that records,
-- on a row setting a person's email, whether its actor was a workspace admin
-- at that moment (activity.actor_admin). Signing in reuses a login-less
-- person only by an email kitp or an admin wrote (oidc.go provisionUser,
-- DI-4); judged by the actor's role at sign-in, a worker promoted later made
-- every email they had set trusted after the fact (review 2026-11-03 round
-- 4). Other rows leave it NULL; older email rows are judged as before.
--
-- Declared with its trigger, as attribute_value_set_type_id is.
CREATE OR REPLACE FUNCTION activity_set_actor_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'attr_update'
     AND NEW.attribute_def_id = (SELECT ad.id FROM attribute_def ad WHERE ad.name = 'email') THEN
    NEW.actor_admin := user_is_global_admin(NEW.actor_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS activity_set_actor_admin_trg ON activity;
CREATE TRIGGER activity_set_actor_admin_trg
  BEFORE INSERT ON activity
  FOR EACH ROW EXECUTE FUNCTION activity_set_actor_admin();

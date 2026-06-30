-- attribute_value_set_type_id — BEFORE INSERT trigger on attribute_value
-- that denormalizes the def's storage class onto the row (value_type_id)
-- via av_value_type_id. value_type_id depends only on attribute_def_id,
-- which is part of the primary key and never changes, so setting it once at
-- insert keeps the class correct with no re-sync (an ON CONFLICT UPDATE of
-- `value` leaves the original, still-correct value_type_id in place).
--
-- The trigger is declared alongside its function here so it rides the
-- schema's function emission: the auto-emitted DROP FUNCTION ... is a no-op
-- on the trigger's zero-arg signature, and CREATE OR REPLACE FUNCTION +
-- DROP/CREATE TRIGGER re-apply idempotently on every boot.
CREATE OR REPLACE FUNCTION attribute_value_set_type_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.value_type_id := av_value_type_id(
    (SELECT ad.value_type FROM attribute_def ad WHERE ad.id = NEW.attribute_def_id));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attribute_value_set_type_id_trg ON attribute_value;
CREATE TRIGGER attribute_value_set_type_id_trg
  BEFORE INSERT ON attribute_value
  FOR EACH ROW EXECUTE FUNCTION attribute_value_set_type_id();

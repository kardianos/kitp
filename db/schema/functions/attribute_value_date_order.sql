-- attribute_value_date_order — AFTER INSERT / UPDATE trigger on
-- attribute_value: refuses any write that leaves a card's start_date after
-- its due_date (date_order_problem; docs/TIMELINE_AND_CALENDAR.md T8),
-- whatever wrote it — a template stamp, a compose, an import, a handler not
-- yet written. attribute.update and card.insert check the pair first, so
-- their callers get a 'validation' row; this is the floor under every path.
--
-- A row-level AFTER trigger runs at the end of its statement, so a
-- statement that writes both dates (a stamp's INSERT … SELECT) is judged on
-- the pair it leaves. Separate statements are judged one at a time: a
-- client that moves both dates writes them in an order that never inverts
-- the pair (later: due first; earlier: start first).
--
-- The card is held FOR NO KEY UPDATE (card_list_lock's strength) before the
-- pair is read, so two writers of a card's dates take turns, and the second
-- reads (a later statement, a fresh snapshot under READ COMMITTED) the
-- first's committed date: two writes at once can't each pass against the
-- other's old value. attribute.update takes the same lock up front, which
-- makes this one a no-op there. Only rows of the two dates are looked at;
-- every other value (value_type_id not 30) returns at once.
--
-- RAISE (P0001) text reaches the client as-is (internal/api/sqlfunc.go
-- mapPGError), so it names only the card and the two dates. Declared with
-- its trigger, as attribute_value_set_type_id is.
CREATE OR REPLACE FUNCTION attribute_value_date_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  _problem text;
BEGIN
  IF NEW.value_type_id IS DISTINCT FROM av_value_type_id('date')
     OR jsonb_typeof(NEW.value) <> 'string'
     OR NOT EXISTS (SELECT 1 FROM attribute_def ad
                    WHERE ad.id = NEW.attribute_def_id
                      AND ad.name IN ('start_date', 'due_date')) THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM card c WHERE c.id = NEW.card_id FOR NO KEY UPDATE;
  _problem := date_order_problem(card_date(NEW.card_id, 'start_date'),
                                 card_date(NEW.card_id, 'due_date'));
  IF _problem IS NOT NULL THEN
    RAISE EXCEPTION 'card %: %', NEW.card_id, _problem;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS attribute_value_date_order_trg ON attribute_value;
CREATE TRIGGER attribute_value_date_order_trg
  AFTER INSERT OR UPDATE ON attribute_value
  FOR EACH ROW EXECUTE FUNCTION attribute_value_date_order();

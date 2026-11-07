-- date_order_problem — the one rule between a card's start_date and its
-- due_date (docs/TIMELINE_AND_CALENDAR.md T8): the start is never after the
-- due date. NULL when the pair is fine (either date missing, or start on or
-- before due); otherwise the display-safe reason. Both are ISO YYYY-MM-DD
-- (iso_date_ok), so text order is date order. attribute.update and
-- card.insert ask it before they write, and the attribute_value_date_order
-- trigger after any write, so every path refuses the same pair in the same
-- words.
CREATE OR REPLACE FUNCTION date_order_problem(start_date text, due_date text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN $1 IS NOT NULL AND $2 IS NOT NULL AND $1 > $2
    THEN format('the start date %s is after the due date %s', $1, $2) END
$$;

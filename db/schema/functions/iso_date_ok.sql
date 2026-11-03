-- iso_date_ok — true when s is a date in the one form kitp stores: exactly
-- YYYY-MM-DD, and a real calendar day (2026-02-30 is not). Every date that
-- enters kitp is checked with this (or the Go twin, internal/isodate), so
-- date reads can compare the ISO text: it sorts in date order. Postgres's
-- own date input is far looser ('today', 'epoch', '03/11/2026' by DateStyle)
-- and is never used to accept a date. See docs/MAIL_INTAKE_AND_CALENDARS.md §1.
CREATE OR REPLACE FUNCTION iso_date_ok(s text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF s IS NULL OR s !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RETURN false;
    END IF;
    PERFORM make_date(substr(s, 1, 4)::int, substr(s, 6, 2)::int, substr(s, 9, 2)::int);
    RETURN substr(s, 1, 4)::int >= 1;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RETURN false;
END;
$$;

-- iso_timestamp_ok — true when s is an RFC 3339 timestamp: date, 'T',
-- hh:mm:ss, optional fraction, and 'Z' or a ±hh:mm offset — and names a
-- real instant. The Go twin is isodate.ParseTimestamp. Postgres's
-- timestamptz input also takes 'now', 'infinity', 'epoch' and
-- locale-ordered dates; inputs are checked with this first, then cast.
-- See docs/MAIL_INTAKE_AND_CALENDARS.md §1.
CREATE OR REPLACE FUNCTION iso_timestamp_ok(s text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    _t timestamptz;
BEGIN
    IF s IS NULL
       OR s !~ '^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$' THEN
        RETURN false;
    END IF;
    IF NOT iso_date_ok(substr(s, 1, 10)) THEN
        RETURN false;
    END IF;
    IF substr(s, 12, 2)::int > 23 OR substr(s, 15, 2)::int > 59 OR substr(s, 18, 2)::int > 59 THEN
        RETURN false;
    END IF;
    -- An offset is at most ±15:59 (Postgres raises past it; the Go twin
    -- agrees — review 2026-11-03 #22).
    IF s ~ '[+-]\d{2}:\d{2}$'
       AND (substr(s, length(s) - 4, 2)::int > 15 OR substr(s, length(s) - 1, 2)::int > 59) THEN
        RETURN false;
    END IF;
    _t := s::timestamptz;
    RETURN true;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR invalid_time_zone_displacement_value THEN
    RETURN false;
END;
$$;

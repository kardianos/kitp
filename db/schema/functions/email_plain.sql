-- email_plain — whether a stored email is an addr-spec kitp sends to: one
-- "@" between a non-empty local part and domain, and none of the characters
-- only a quoted local part or a domain literal can hold (comma, semicolon,
-- colon, double quote, angle and square brackets, parentheses, backslash,
-- whitespace, control characters). The SQL twin of comm.PlainAddress.
-- A To list is built by joining people's emails with ", " and split again
-- when sent, so a stored `eve@evil.example, x@ourco.example` (net/mail's
-- unquoted form of a quoted local part) would reach eve@evil.example too
-- (review 2026-11-03 round 3 #9).
CREATE OR REPLACE FUNCTION email_plain(email text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT email IS NOT NULL
     AND email ~ '^[^@,;:"<>()\[\]\\[:space:][:cntrl:]]+@[^@,;:"<>()\[\]\\[:space:][:cntrl:]]+$'
$$;

-- email_plain — whether a stored email is an addr-spec kitp sends to: one
-- "@" between a non-empty local part and domain, and none of the characters
-- only a quoted local part or a domain literal can hold (comma, semicolon,
-- colon, double quote, angle and square brackets, parentheses, backslash,
-- whitespace — Unicode spaces such as U+00A0 included, as Go's
-- unicode.IsSpace has them — control characters). The SQL twin of
-- comm.PlainAddress.
-- A To list is built by joining people's emails with ", " and split again
-- when sent, so a stored `eve@evil.example, x@ourco.example` (net/mail's
-- unquoted form of a quoted local part) would reach eve@evil.example too
-- (review 2026-11-03 round 3 #9).
CREATE OR REPLACE FUNCTION email_plain(email text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT email IS NOT NULL
     AND email ~ '^[^@,;:"<>()\[\]\\[:space:][:cntrl:]\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+@[^@,;:"<>()\[\]\\[:space:][:cntrl:]\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$'
$$;

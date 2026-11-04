// Package isodate holds the one rule for dates and timestamps that enter
// kitp: a date is exactly YYYY-MM-DD and a real calendar day; a timestamp is
// RFC 3339 (date, 'T', hh:mm:ss, optional fraction, 'Z' or ±hh:mm). The SQL
// twins are iso_date_ok / iso_timestamp_ok. Stored dates compare as ISO text
// (it sorts in date order), so nothing looser may be stored. See
// docs/MAIL_INTAKE_AND_CALENDARS.md §1.
package isodate

import (
	"errors"
	"time"
)

// DateLayout is the stored date form.
const DateLayout = "2006-01-02"

// ErrNotDate / ErrNotTimestamp are the parse failures.
var (
	ErrNotDate      = errors.New("not a date (YYYY-MM-DD)")
	ErrNotTimestamp = errors.New("not an RFC 3339 timestamp (YYYY-MM-DDThh:mm:ssZ)")
)

// ValidDate reports whether s is exactly YYYY-MM-DD and a real day.
func ValidDate(s string) bool {
	_, err := ParseDate(s)
	return err == nil
}

// ParseDate parses a stored-form date (UTC midnight).
func ParseDate(s string) (time.Time, error) {
	if len(s) != 10 || !digits(s[0:4]) || s[4] != '-' || !digits(s[5:7]) || s[7] != '-' || !digits(s[8:10]) {
		return time.Time{}, ErrNotDate
	}
	t, err := time.Parse(DateLayout, s)
	if err != nil || t.Year() < 1 {
		return time.Time{}, ErrNotDate
	}
	return t, nil
}

// ParseTimestamp parses an RFC 3339 timestamp. time.RFC3339Nano is a little
// looser than RFC 3339 in places (it accepts a lower-case 'z' and some
// out-of-range offsets), so the shape is checked first.
func ParseTimestamp(s string) (time.Time, error) {
	if !timestampShape(s) {
		return time.Time{}, ErrNotTimestamp
	}
	// RFC 3339 allows a lower-case 't' and 'z'; Go's parser doesn't.
	b := []byte(s)
	b[10] = 'T'
	if b[len(b)-1] == 'z' {
		b[len(b)-1] = 'Z'
	}
	t, err := time.Parse(time.RFC3339Nano, string(b))
	if err != nil {
		return time.Time{}, ErrNotTimestamp
	}
	return t, nil
}

// timestampShape checks YYYY-MM-DD[Tt]hh:mm:ss(.f{1,9})?(Z|z|±hh:mm).
func timestampShape(s string) bool {
	if len(s) < 20 || !ValidDate(s[0:10]) || (s[10] != 'T' && s[10] != 't') {
		return false
	}
	if !digits(s[11:13]) || s[13] != ':' || !digits(s[14:16]) || s[16] != ':' || !digits(s[17:19]) {
		return false
	}
	rest := s[19:]
	if rest[0] == '.' {
		n := 1
		for n < len(rest) && rest[n] >= '0' && rest[n] <= '9' {
			n++
		}
		if n == 1 || n > 10 {
			return false
		}
		rest = rest[n:]
	}
	switch {
	case rest == "Z" || rest == "z":
		return true
	case len(rest) == 6 && (rest[0] == '+' || rest[0] == '-') && digits(rest[1:3]) && rest[3] == ':' && digits(rest[4:6]):
		// An offset is at most ±15:59, as iso_timestamp_ok (and Postgres)
		// allow; the two checks agree (review 2026-11-03 #22).
		return rest[1:3] <= "15" && rest[4:6] <= "59"
	}
	return false
}

func digits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

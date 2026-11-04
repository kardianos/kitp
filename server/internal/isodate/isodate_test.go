package isodate

import "testing"

func TestDates(t *testing.T) {
	for _, c := range []struct {
		in string
		ok bool
	}{
		{"2026-11-03", true},
		{"2024-02-29", true},
		{"2026-02-29", false},
		{"2026-13-01", false},
		{"2026-11-3", false},
		{"2026-11-03T00:00:00Z", false},
		{"today", false},
		{"03/11/2026", false},
		{"0000-01-01", false},
		{"", false},
		{" 2026-11-03", false},
	} {
		if got := ValidDate(c.in); got != c.ok {
			t.Errorf("ValidDate(%q) = %v, want %v", c.in, got, c.ok)
		}
	}
}

func TestTimestamps(t *testing.T) {
	for _, c := range []struct {
		in string
		ok bool
	}{
		{"2026-11-03T10:00:00Z", true},
		{"2026-11-03t10:00:00z", true},
		{"2026-11-03T10:00:00.123456789+05:30", true},
		{"2026-11-03T10:00:00-08:00", true},
		{"2026-11-03 10:00:00Z", false},
		{"2026-11-03T10:00Z", false},
		{"2026-11-03T25:00:00Z", false},
		{"2026-11-03T10:00:00", false},
		{"2026-11-03T10:00:00.Z", false},
		{"2026-11-03T10:00:00.1234567890Z", false},
		{"2026-02-30T10:00:00Z", false},
		{"infinity", false},
		{"now", false},
		{"2026-11-03T10:00:00+15:59", true},
		{"2026-11-03T10:00:00+16:00", false},
		{"2026-11-03T10:00:00-24:00", false},
		{"2026-11-03T10:00:00+05:60", false},
	} {
		_, err := ParseTimestamp(c.in)
		if (err == nil) != c.ok {
			t.Errorf("ParseTimestamp(%q) err = %v, want ok %v", c.in, err, c.ok)
		}
	}
}

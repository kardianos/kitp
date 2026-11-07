package attribute_test

// A milestone's date is the due_date attribute bound to the milestone card
// type (docs/TIMELINE_AND_CALENDAR.md T6, migration 0047): it takes an ISO
// date like a task's — checked by value_type, not by name — and the
// start-before-due rule (T8) has no start date to hold it against.

import (
	"fmt"
	"strings"
	"testing"
)

func TestMilestoneDueDate(t *testing.T) {
	srv, pool := dateOrderServer(t, "kitp_test_milestone_due_date")
	project := insertID(t, call(t, srv, "card", "insert", map[string]any{"card_type_name": "project", "title": "Dates"}))
	ms := insertID(t, call(t, srv, "card", "insert", map[string]any{
		"card_type_name": "milestone", "parent_card_id": fmt.Sprint(project), "title": "M1",
		"attributes": map[string]any{"due_date": "2026-12-11"},
	}))
	if _, due := storedDates(t, pool, ms); due != "2026-12-11" {
		t.Fatalf("inserted milestone due_date = %q, want 2026-12-11", due)
	}
	for _, c := range []struct {
		name, value string
		ok          bool
		want        string // the stored date after
	}{
		{"a date", "2027-01-15", true, "2027-01-15"},
		{"not a day", "2027-02-30", false, "2027-01-15"},
		{"words", "next week", false, "2027-01-15"},
		{"removed", "", true, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := batch(t, srv, ms, dateWrite{"due_date", c.value})
			if c.ok && e != nil {
				t.Fatalf("refused: %+v", e)
			}
			if !c.ok && (e == nil || e.Code != "validation" || strings.Contains(e.Message, "start date")) {
				t.Fatalf("got %+v, want a date validation refusal", e)
			}
			if _, due := storedDates(t, pool, ms); due != c.want {
				t.Errorf("stored due_date %q, want %q", due, c.want)
			}
		})
	}
	// start_date isn't a milestone's: no edge, so it's refused as such.
	if e := batch(t, srv, ms, dateWrite{"start_date", "2026-11-01"}); e == nil {
		t.Error("a milestone took a start_date")
	}
}

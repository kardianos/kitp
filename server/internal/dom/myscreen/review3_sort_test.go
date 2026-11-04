package myscreen_test

// Regression test for the third 2026-11-03 review, finding 23.

import (
	"encoding/json"
	"testing"
)

// TestSortOrderIsAWholeNumber (round 3 #23): a fractional or huge
// sort_order is a validation error, not an internal one.
func TestSortOrderIsAWholeNumber(t *testing.T) {
	f := setup(t, "kitp_test_r3_myscreen_sort")
	var made struct {
		ID string `json:"id"`
	}
	into(t, call(t, f.srv, f.ada, "my_screen", "set", map[string]any{"title": "Mine"}), &made)
	for so, want := range map[string]string{"2.5": "validation", "1e300": "validation", "30": ""} {
		r := call(t, f.srv, f.ada, "my_screen", "set", map[string]any{"id": made.ID, "sort_order": json.RawMessage(so)})
		got := ""
		if !r.OK {
			got = r.Error.Code
		}
		if got != want {
			t.Errorf("sort_order %s: code %q, want %q", so, got, want)
		}
	}
}

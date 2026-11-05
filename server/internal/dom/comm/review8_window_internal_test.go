package comm

import (
	"fmt"
	"testing"
)

// TestUnseenWindowPutsFailingLast (review 2026-11-05 round 6 #2): messages
// that keep failing come after the rest before the window's cap, so fifty
// of them can't keep newer mail out of every poll.
func TestUnseenWindowPutsFailingLast(t *testing.T) {
	var uids []uint32
	for u := uint32(60); u >= 1; u-- {
		uids = append(uids, u)
	}
	got := unseenWindow(uids, func(u uint32) bool { return u <= 55 })
	if len(got) != imapFetchBatch {
		t.Fatalf("%d in the window, want %d", len(got), imapFetchBatch)
	}
	if fmt.Sprint(got[:6]) != "[56 57 58 59 60 1]" || got[len(got)-1] != 45 {
		t.Errorf("window = %v, want 56–60 then the failing ones from 1", got)
	}
	if got := unseenWindow([]uint32{3, 1, 2}, nil); fmt.Sprint(got) != "[1 2 3]" {
		t.Errorf("no failing ones: %v, want oldest first", got)
	}
}

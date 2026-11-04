package comm

import (
	"strings"
	"testing"
)

// TestSendingFrom (review 2026-11-03 round 3 #10): queued mail goes out at
// the sending account's address, keeping the stored name.
func TestSendingFrom(t *testing.T) {
	for _, c := range []struct{ stored, account, want string }{
		{"support@old.example", "help@new.example", "<help@new.example>"},
		{`"Ada via Support" <support@old.example>`, "help@new.example", `"Ada via Support" <help@new.example>`},
		{`"Ada via Support" <SUPPORT@new.example>`, "support@new.example", `"Ada via Support" <SUPPORT@new.example>`},
		{"", "help@new.example", "help@new.example"},
		{"support@old.example", "", "support@old.example"},
	} {
		if got := sendingFrom(c.stored, c.account); got != c.want {
			t.Errorf("sendingFrom(%q, %q) = %q, want %q", c.stored, c.account, got, c.want)
		}
	}
}

// TestLongSubjectIsFolded: a long non-ASCII subject stays within the
// 998-octet line limit.
func TestLongSubjectIsFolded(t *testing.T) {
	msg := buildMIME("support@example.com", "ada@example.com", strings.Repeat("Größenänderung ", 200), "body", "", "", "", "", 0, nil)
	for _, line := range strings.Split(string(msg), "\r\n") {
		if len(line) > 998 {
			t.Fatalf("a %d-octet header line: %.80s…", len(line), line)
		}
	}
}

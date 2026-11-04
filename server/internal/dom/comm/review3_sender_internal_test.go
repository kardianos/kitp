package comm

import (
	"net/mail"
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
		// An account address with a display name (round 4 #8).
		{"support@new.example", "Support <support@new.example>", "support@new.example"},
		{`"Ada via Support" <support@old.example>`, "Support <help@new.example>", `"Ada via Support" <help@new.example>`},
		{"support@old.example", "Support <help@new.example>", `"Support" <help@new.example>`},
	} {
		if got := sendingFrom(c.stored, c.account); got != c.want {
			t.Errorf("sendingFrom(%q, %q) = %q, want %q", c.stored, c.account, got, c.want)
		}
	}
}

// TestLongSubjectIsFolded: a long subject, ASCII or not, is folded: no
// header line over 78 octets, no encoded-word line over 76 (round 3, round
// 4 #19); unfolded, the subject reads as it was.
func TestLongSubjectIsFolded(t *testing.T) {
	for _, subj := range []string{strings.Repeat("Größenänderung ", 200), strings.Repeat("resize ", 300)} {
		msg := buildMIME("support@example.com", "ada@example.com", subj, "body", "", "", "", "", 0, nil)
		head, _, _ := strings.Cut(string(msg), "\r\n\r\n")
		inSubject := false
		for _, line := range strings.Split(head, "\r\n") {
			if strings.HasPrefix(line, "Subject:") {
				inSubject = true
			} else if !strings.HasPrefix(line, " ") {
				inSubject = false
			}
			if !inSubject {
				continue
			}
			limit := 78
			if strings.Contains(line, "=?") {
				limit = 76
			}
			if len(line) > limit {
				t.Errorf("a %d-octet subject line: %.80s…", len(line), line)
			}
		}
		h, err := mail.ReadMessage(strings.NewReader(string(msg)))
		if err != nil {
			t.Fatal(err)
		}
		got, err := headerDecoder.DecodeHeader(h.Header.Get("Subject"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(got, strings.TrimSpace(subj)[:40]) {
			t.Errorf("subject unfolds to %.60q…", got)
		}
	}
}

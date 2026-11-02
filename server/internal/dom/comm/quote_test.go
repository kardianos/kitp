package comm

import (
	"strings"
	"testing"
	"time"
)

// TestSplitQuoted: what counts as a received message's quoted tail. The web
// client trims for display with the same rules (web/src/task-detail/comm-quoted.ts).
func TestSplitQuoted(t *testing.T) {
	cases := []struct {
		name, body, own string // own "" = nothing trimmed (own is the body)
	}{
		{"plain", "Thanks, that worked.", ""},
		{"on wrote", "Thanks!\n\nOn 2026-11-02 Mon, Support <s@x.com> wrote:\n> Try again.\n", "Thanks!"},
		{"gmail wrapped", "Fixed.\n\nOn Mon, Nov 2, 2026 at 10:01 AM Support <s@x.com>\nwrote:\n\n> Try again.", "Fixed."},
		{"original message", "See below.\n\n-----Original Message-----\nFrom: a\nSent: b\n\nold", "See below."},
		{"outlook block", "Yes.\n\n________________________________\nFrom: Support <s@x.com>\nSent: Monday\nTo: me\nSubject: Re\n\nold", "Yes."},
		{"quote run to end", "Sure.\n\n> old line\n>\n> more\n", "Sure."},
		{"kitp trailer only", "Got it.\n\nTask: 42\nRef: Ab3dE5gH9k\n", "Got it."},
		{"quoted with trailer", "Ok.\n\n> old\n> Ref: Ab3dE5gH9k\n", "Ok."},
		{"bottom-posted", "> your question\n\nmy answer", ""},
		{"inline replies", "> q1\na1\n> q2\na2", ""},
		{"all quoted", "On Mon, Ada wrote:\n> everything", ""},
		{"crlf", "Done.\r\n\r\n> old\r\n", "Done."},
		{"from without sent", "From: the team, with thanks.\nBye", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			own, quoted := SplitQuoted(c.body)
			if c.own == "" {
				if own != c.body || quoted != "" {
					t.Errorf("trimmed %q to %q / %q, want it whole", c.body, own, quoted)
				}
				return
			}
			if own != c.own {
				t.Errorf("own = %q, want %q", own, c.own)
			}
			if strings.TrimSpace(quoted) == "" {
				t.Errorf("quoted is empty for %q", c.body)
			}
		})
	}
}

func TestResolveModes(t *testing.T) {
	for _, c := range []struct {
		stored string
		status int64
		want   string
	}{
		{"", 0, IntakeIgnore},
		{"", 7, IntakeTask},
		{"thread", 7, IntakeThread},
		{"ignore", 7, IntakeIgnore},
		{"task", 0, IntakeTask},
		{"bogus", 0, IntakeIgnore},
	} {
		if got := ResolveIntakeMode(c.stored, c.status); got != c.want {
			t.Errorf("ResolveIntakeMode(%q, %d) = %q, want %q", c.stored, c.status, got, c.want)
		}
	}
	for stored, want := range map[string]string{"": QuoteLast, "off": QuoteOff, "last": QuoteLast, "all": QuoteAll, "x": QuoteLast} {
		if got := ResolveReplyQuote(stored); got != want {
			t.Errorf("ResolveReplyQuote(%q) = %q, want %q", stored, got, want)
		}
	}
}

func TestFormatQuote(t *testing.T) {
	at := time.Date(2026, 11, 2, 23, 30, 0, 0, time.FixedZone("x", -5*3600)) // 2026-11-03 04:30 UTC
	got := formatQuote([]quotedMessage{
		{From: "Ada Lovelace <ada@example.com>", At: at, Body: "Second line one\n\nline three\n\nOn Sun, Support wrote:\n> older"},
		{From: "", At: at, Body: "First"},
		{From: "x@example.com", At: at, Body: "   "},
	})
	want := "On 2026-11-03 Tue, Ada Lovelace <ada@example.com> wrote:\n" +
		"> Second line one\n>\n> line three\n\n" +
		"On 2026-11-03 Tue wrote:\n> First"
	if got != want {
		t.Errorf("formatQuote =\n%s\nwant\n%s", got, want)
	}
	if formatQuote(nil) != "" {
		t.Error("formatQuote(nil) not empty")
	}
}

// TestBuildMIMEQuote: the quote sits below the signature, the Task: / Ref:
// trailer stays last, and no Task: line is written for a thread on its own.
func TestBuildMIMEQuote(t *testing.T) {
	msg := string(buildMIME("k@example.com", "a@example.com", "Hi", "Body", "Support", "abc123", "", "On 2026-11-02 Mon, A wrote:\n> earlier", 42, nil))
	body := msg[strings.Index(msg, "\r\n\r\n")+4:]
	want := "Body\r\n\r\n-Support\r\n\r\nOn 2026-11-02 Mon, A wrote:\r\n> earlier\r\n\r\nTask: 42\r\nRef: abc123\r\n"
	if body != want {
		t.Errorf("body =\n%q\nwant\n%q", body, want)
	}
	noTask := string(buildMIME("k@example.com", "a@example.com", "Hi", "Body", "", "abc123", "", "", 0, nil))
	if strings.Contains(noTask, "Task:") {
		t.Errorf("a thread on its own got a Task: line:\n%s", noTask)
	}
}

// TestSplitQuotedIsLinear (A5): a long run of quoted lines below a short
// reply used to take seconds (every line rescanned to the end); it must
// stay fast, and still trim.
func TestSplitQuotedIsLinear(t *testing.T) {
	body := "hi\n" + strings.Repeat("> a\n", 160<<10/4) // ~160 KB
	start := time.Now()
	own, quoted := SplitQuoted(body)
	if d := time.Since(start); d > 500*time.Millisecond {
		t.Errorf("SplitQuoted on %d bytes took %v", len(body), d)
	}
	if own != "hi" || quoted == "" {
		t.Errorf("own = %q, quoted %d bytes", own, len(quoted))
	}
	huge := "hi\n" + strings.Repeat("> a\n", (maxSplitBytes/4)+10)
	if own, quoted := SplitQuoted(huge); own != huge || quoted != "" {
		t.Error("a message over the cap should be shown whole")
	}
}

// TestHeaderDecoding (A27): encoded subjects and sender names are decoded
// for people — the task / thread title, the thread view, quote headers.
func TestHeaderDecoding(t *testing.T) {
	raw := "From: =?UTF-8?B?QWTDoSBMb3ZlbGFjZQ==?= <ada@example.com>\r\n" +
		"Subject: =?ISO-8859-1?Q?Caf=E9_question?=\r\n" +
		"Content-Type: text/plain\r\n\r\nHello\r\n"
	m, err := ParseInboundMessage(1, []byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if m.Subject != "Café question" {
		t.Errorf("subject = %q", m.Subject)
	}
	if got := displayAddress(m.From); got != "Adá Lovelace <ada@example.com>" {
		t.Errorf("displayAddress = %q", got)
	}
	if got := displayAddress("plain@example.com"); got != "plain@example.com" {
		t.Errorf("bare address = %q", got)
	}
	if got := displayAddress("Lovelace, Ada <ada@example.com>"); got != "Lovelace, Ada <ada@example.com>" {
		t.Errorf("an unparsable header comes back as it is: %q", got)
	}
}

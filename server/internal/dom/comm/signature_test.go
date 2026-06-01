package comm

import (
	"strings"
	"testing"
)

func TestResolveSignature(t *testing.T) {
	cases := []struct {
		name    string
		mode    string
		channel string
		author  string
		want    string
	}{
		{"none signs nothing", "none", "Support", "Alice", ""},
		{"comm_name signs channel", "comm_name", "Support", "Alice", "Support"},
		{"user_name signs author", "user_name", "Support", "Alice", "Alice"},
		{"unset falls back to channel", "", "Support", "Alice", "Support"},
		{"unknown falls back to channel", "bogus", "Support", "Alice", "Support"},
		{"user_name with no author signs nothing", "user_name", "Support", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveSignature(c.mode, c.channel, c.author); got != c.want {
				t.Errorf("resolveSignature(%q,%q,%q)=%q want %q",
					c.mode, c.channel, c.author, got, c.want)
			}
		})
	}
}

// TestBuildMIMETaskURL verifies the task deep link is appended below the
// signature (and before the machine Ref: trailer) when a non-empty taskURL is
// supplied — and omitted entirely when it's empty.
func TestBuildMIMETaskURL(t *testing.T) {
	link := "https://kitp.example.com/task/42"

	withLink := string(buildMIME("k@example.com", "a@example.com", "Hi", "Body text", "Support", "abc123", link, nil))
	if !strings.Contains(withLink, link) {
		t.Fatalf("expected task link %q in body, got:\n%s", link, withLink)
	}
	// The link must sit AFTER the signature and BEFORE the Ref: trailer.
	sigIdx := strings.Index(withLink, "-Support")
	linkIdx := strings.Index(withLink, link)
	refIdx := strings.Index(withLink, "Ref: abc123")
	if !(sigIdx >= 0 && sigIdx < linkIdx && linkIdx < refIdx) {
		t.Fatalf("ordering wrong: sig=%d link=%d ref=%d in:\n%s", sigIdx, linkIdx, refIdx, withLink)
	}

	noLink := string(buildMIME("k@example.com", "a@example.com", "Hi", "Body text", "Support", "abc123", "", nil))
	if strings.Contains(noLink, "/task/") {
		t.Fatalf("did not expect a task link when taskURL empty, got:\n%s", noLink)
	}
}

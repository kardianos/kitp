package help

import (
	"strings"
	"testing"
)

// TestEmbeddedTopics confirms every wire-side topic key resolves to a
// non-empty embedded file. Catches mismatches between topicFiles and
// the files actually shipped under content/.
func TestEmbeddedTopics(t *testing.T) {
	for key := range topicFiles {
		t.Run(key, func(t *testing.T) {
			body, err := readTopic(key)
			if err != nil {
				t.Fatalf("readTopic(%q): %v", key, err)
			}
			if strings.TrimSpace(body) == "" {
				t.Fatalf("topic %q resolved to empty body", key)
			}
		})
	}
}

func TestReadTopic_unknown(t *testing.T) {
	if _, err := readTopic("does.not.exist"); err == nil {
		t.Fatalf("expected error for unknown topic")
	}
}

func TestFirstH1(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"present", "# Hello\n\nbody", "Hello"},
		{"trim", "#   Spaces   \n", "Spaces"},
		{"fallback", "no heading here", "TOPIC"},
		{"second-level ignored", "## H2\n# H1\n", "H1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := firstH1(c.body, "TOPIC")
			if got != c.want {
				t.Errorf("got %q want %q", got, c.want)
			}
		})
	}
}

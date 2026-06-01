package comm

import (
	"strings"
	"testing"
)

func priorityNames(es []bodyExtractor) string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.name
	}
	return strings.Join(out, ",")
}

// TestResolveBodyPriority covers the KITP_COMM_BODY_PRIORITY parsing: order
// preserved, tokens lowercased/trimmed/de-duplicated, unknown tokens dropped,
// and an empty / all-invalid setting falling back to plain,html.
func TestResolveBodyPriority(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "plain,html"},
		{"plain,html", "plain,html"},
		{"html,plain", "html,plain"},
		{"plain", "plain"},
		{"html", "html"},
		{"  HTML , PLAIN ", "html,plain"},  // case + whitespace
		{"plain,plain,html", "plain,html"}, // de-dup
		{"garbage", "plain,html"},          // no valid tokens → default
		{"json,html", "html"},              // unknown token dropped
		{"plain,,html", "plain,html"},      // empty token ignored
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := priorityNames(resolveBodyPriority(tc.in)); got != tc.want {
				t.Errorf("resolveBodyPriority(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestDescriptionMarkdownPriority covers the selection logic: the first
// extractor whose part is present wins, absent parts fall through, and when
// nothing in the configured priority matches we fall back to converting
// whatever text the message has (m.Body).
func TestDescriptionMarkdownPriority(t *testing.T) {
	bothParts := InboundMessage{
		BodyPlain: "plain line",
		BodyHTML:  "<p>html <b>line</b></p>",
		Body:      "plain line",
	}
	htmlOnly := InboundMessage{
		BodyHTML: "<p>html <b>line</b></p>",
		Body:     "html line", // stripped fallback the parser would have set
	}
	plainOnly := InboundMessage{
		BodyPlain: "plain line",
		Body:      "plain line",
	}

	cases := []struct {
		name     string
		priority string
		msg      InboundMessage
		want     string
	}{
		{"html-first picks html when both present", "html,plain", bothParts, "html **line**"},
		{"plain-first picks plain when both present", "plain,html", bothParts, "plain line"},
		{"html-first falls through to plain", "html,plain", plainOnly, "plain line"},
		{"plain-first falls through to html", "plain,html", htmlOnly, "html **line**"},
		{"html-only ignores plain part", "html", bothParts, "html **line**"},
		{"plain-only ignores html part", "plain", bothParts, "plain line"},
		// Configured priority has no matching part → fall back to m.Body text.
		{"plain-only with no plain part falls back to Body", "plain", htmlOnly, "html line"},
		{"html-only with no html part falls back to Body", "html", plainOnly, "plain line"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := &IMAPPoller{bodyPriority: resolveBodyPriority(tc.priority)}
			if got := p.descriptionMarkdown(tc.msg); got != tc.want {
				t.Errorf("descriptionMarkdown = %q, want %q", got, tc.want)
			}
		})
	}
}

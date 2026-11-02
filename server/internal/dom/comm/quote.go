package comm

import (
	"regexp"
	"strings"
	"time"
)

// Quoting in replies (docs/CONVERSATIONS.md). kitp stores and shows each
// message on its own; when a channel's reply_quote is 'last' or 'all' the
// SMTP sender adds the earlier messages below the signature at send time,
// each as
//
//	On 2026-11-02 Mon, Ada Lovelace <ada@example.com> wrote:
//	> the earlier message,
//	> line by line
//
// A received message usually carries its own copy of the history (the
// customer's mail program quoted it), so each quoted message is first cut
// down to its own text with SplitQuoted. The web client applies the same
// rules for display (web/src/task-detail/comm-quoted.ts); keep the two in step.

// Reply quote modes.
const (
	QuoteOff  = "off"
	QuoteLast = "last"
	QuoteAll  = "all"
)

// ResolveReplyQuote maps a channel's stored reply_quote to the mode in
// effect: unset (or unknown) quotes the last message.
func ResolveReplyQuote(stored string) string {
	switch stored {
	case QuoteOff, QuoteLast, QuoteAll:
		return stored
	}
	return QuoteLast
}

var (
	// "On <anything> wrote:" — one line, or two when a mail program wraps
	// the header before "wrote:".
	quoteOnWrote   = regexp.MustCompile(`(?i)^\s*On\s.{0,300}\bwrote:\s*$`)
	quoteOnStart   = regexp.MustCompile(`(?i)^\s*On\s.{4,}$`)
	quoteWroteEnd  = regexp.MustCompile(`(?i)^.{0,200}\bwrote:\s*$`)
	quoteOriginal  = regexp.MustCompile(`(?i)^\s*-{2,}\s*Original Message\s*-{2,}\s*$`)
	quoteFromLine  = regexp.MustCompile(`(?i)^\s*\*?From:\*?\s+\S`)
	quoteSentLine  = regexp.MustCompile(`(?i)^\s*\*?(Sent|Date):\*?\s+\S`)
	quoteUnderline = regexp.MustCompile(`^\s*_{8,}\s*$`)
	quoteTrailer   = regexp.MustCompile(`^(Ref|Task):\s*\S+\s*$`)
)

// maxSplitBytes caps the text SplitQuoted looks at: a message larger
// than this is shown (and quoted) whole. Ordinary mail is far smaller.
const maxSplitBytes = 512 << 10

// SplitQuoted splits a received message into its own text and the quoted
// history its mail program added below it: an "On … wrote:" header, a
// "-----Original Message-----" or Outlook "From: … Sent: …" block, a run
// of ">" lines that lasts to the end, or kitp's own Task: / Ref: trailer.
// It is a guess, so it only ever trims the tail, and never everything:
// when nothing would be left of the message, it is returned whole.
// Linear in the size of the message (review A5).
func SplitQuoted(body string) (own, quoted string) {
	if len(body) > maxSplitBytes {
		return body, ""
	}
	text := strings.ReplaceAll(body, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	cut := quoteCut(lines)
	if cut < 0 {
		return body, ""
	}
	own = strings.TrimRight(strings.Join(lines[:cut], "\n"), " \t\n")
	if strings.TrimSpace(own) == "" {
		return body, ""
	}
	return own, strings.Trim(strings.Join(lines[cut:], "\n"), "\n")
}

// quoteCut is the index of the first line of the quoted tail, or -1. The
// two "to the end" rules are suffix properties, so one backward pass
// records them for every line first; the forward scan then looks at most
// four lines ahead.
func quoteCut(lines []string) int {
	n := len(lines)
	// quotedFrom[i]: from line i on, every non-blank line is a ">" line
	// or kitp's trailer. trailerFrom[i]: every non-blank line is a
	// trailer line.
	quotedFrom := make([]bool, n+1)
	trailerFrom := make([]bool, n+1)
	quotedFrom[n], trailerFrom[n] = true, true
	for i := n - 1; i >= 0; i-- {
		ln := lines[i]
		blank := strings.TrimSpace(ln) == ""
		trailer := quoteTrailer.MatchString(ln)
		quotedFrom[i] = quotedFrom[i+1] && (blank || trailer || isQuoteLine(ln))
		trailerFrom[i] = trailerFrom[i+1] && (blank || trailer)
	}
	for i, ln := range lines {
		switch {
		case quoteOnWrote.MatchString(ln):
			return i
		case quoteOnStart.MatchString(ln) && i+1 < n && quoteWroteEnd.MatchString(lines[i+1]) && !quoteOnStart.MatchString(lines[i+1]):
			return i
		case quoteOriginal.MatchString(ln):
			return i
		case quoteFromLine.MatchString(ln) && outlookHeader(lines, i):
			if i > 0 && quoteUnderline.MatchString(lines[i-1]) {
				return i - 1
			}
			return i
		case isQuoteLine(ln) && quotedFrom[i]:
			return i
		case quoteTrailer.MatchString(ln) && trailerFrom[i]:
			return i
		}
	}
	return -1
}

// outlookHeader reports whether a "From:" line at i starts a forwarded /
// replied-to header block: a "Sent:" or "Date:" line within the next four.
func outlookHeader(lines []string, i int) bool {
	for j := i + 1; j < len(lines) && j <= i+4; j++ {
		if quoteSentLine.MatchString(lines[j]) {
			return true
		}
	}
	return false
}

func isQuoteLine(ln string) bool { return strings.HasPrefix(strings.TrimLeft(ln, " \t"), ">") }

// quotedMessage is one earlier message of a thread, for quoting.
type quotedMessage struct {
	From string
	At   time.Time
	Body string
}

// QuoteDate formats a quote header's date: YYYY-MM-DD DoW, in UTC.
func QuoteDate(t time.Time) string { return t.UTC().Format("2006-01-02 Mon") }

// formatQuote renders earlier messages (newest first) as quote blocks,
// each its own text only (SplitQuoted). Empty when there is nothing to
// quote.
func formatQuote(msgs []quotedMessage) string {
	var b strings.Builder
	for _, m := range msgs {
		own, _ := SplitQuoted(m.Body)
		own = strings.TrimRight(strings.ReplaceAll(own, "\r\n", "\n"), " \t\n")
		if strings.TrimSpace(own) == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString("On ")
		b.WriteString(QuoteDate(m.At))
		if from := strings.TrimSpace(m.From); from != "" {
			b.WriteString(", ")
			b.WriteString(from)
		}
		b.WriteString(" wrote:")
		for _, ln := range strings.Split(own, "\n") {
			b.WriteString("\n>")
			if ln != "" {
				b.WriteString(" ")
				b.WriteString(ln)
			}
		}
	}
	return b.String()
}

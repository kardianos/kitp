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

// SplitQuoted splits a received message into its own text and the quoted
// history its mail program added below it: an "On … wrote:" header, a
// "-----Original Message-----" or Outlook "From: … Sent: …" block, a run
// of ">" lines that lasts to the end, or kitp's own Task: / Ref: trailer.
// It is a guess, so it only ever trims the tail, and never everything:
// when nothing would be left of the message, it is returned whole.
func SplitQuoted(body string) (own, quoted string) {
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

// quoteCut is the index of the first line of the quoted tail, or -1.
func quoteCut(lines []string) int {
	for i, ln := range lines {
		switch {
		case quoteOnWrote.MatchString(ln):
			return i
		case quoteOnStart.MatchString(ln) && i+1 < len(lines) && quoteWroteEnd.MatchString(lines[i+1]) && !quoteOnStart.MatchString(lines[i+1]):
			return i
		case quoteOriginal.MatchString(ln):
			return i
		case quoteFromLine.MatchString(ln) && outlookHeader(lines, i):
			if i > 0 && quoteUnderline.MatchString(lines[i-1]) {
				return i - 1
			}
			return i
		case isQuoteLine(ln) && quotedToEnd(lines, i):
			return i
		case quoteTrailer.MatchString(ln) && trailerToEnd(lines, i):
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

// quotedToEnd: from i on, every non-blank line is a ">" line or kitp's
// trailer — the reply was written above the quote (top-posted).
func quotedToEnd(lines []string, i int) bool {
	for _, ln := range lines[i:] {
		if strings.TrimSpace(ln) == "" || isQuoteLine(ln) || quoteTrailer.MatchString(ln) {
			continue
		}
		return false
	}
	return true
}

// trailerToEnd: from i on there is nothing but Task: / Ref: lines.
func trailerToEnd(lines []string, i int) bool {
	for _, ln := range lines[i:] {
		if strings.TrimSpace(ln) == "" || quoteTrailer.MatchString(ln) {
			continue
		}
		return false
	}
	return true
}

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

package calendar

import (
	"strings"
	"time"
	"unicode/utf8"
)

// icsWriter writes RFC 5545 text: CRLF line ends, lines folded at 75
// octets (never inside a UTF-8 sequence), TEXT values escaped.
type icsWriter struct {
	b strings.Builder
}

// prop writes "NAME:value" (value already in its final form).
func (w *icsWriter) prop(name, value string) {
	w.line(name + ":" + value)
}

// text writes a TEXT property, escaped.
func (w *icsWriter) text(name, value string) {
	w.prop(name, escapeText(value))
}

func (w *icsWriter) line(s string) {
	// The first line holds 75 octets; continuation lines start with a
	// space, so they hold 74 more.
	limit := 75
	for len(s) > limit {
		cut := limit
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		w.b.WriteString(s[:cut])
		w.b.WriteString("\r\n ")
		s = s[cut:]
		limit = 74
	}
	w.b.WriteString(s)
	w.b.WriteString("\r\n")
}

func (w *icsWriter) String() string { return w.b.String() }

func escapeText(s string) string {
	r := strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\r\n", `\n`, "\n", `\n`, "\r", `\n`)
	return r.Replace(s)
}

// icsDate is a DATE value (YYYYMMDD).
func icsDate(t time.Time) string { return t.Format("20060102") }

// icsStamp is a UTC DATE-TIME value.
func icsStamp(t time.Time) string { return t.UTC().Format("20060102T150405Z") }
